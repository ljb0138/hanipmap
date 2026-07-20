// 네이버지도 등에서 사람이 직접 저장한(스크린샷 등) 메뉴판 사진 여러 장을 한 폴더에
// 넣어두면, 한 장씩 순서대로: Storage 업로드 -> OCR(Upstage Document AI) -> 메뉴 구조화
// (Solar) -> 터미널에서 결과 확인/수정 -> 어느 식당인지 검색해서 선택 -> DB 반영까지
// 처리한다. api/extract-menu.js와 동일한 OCR 로직을 로컬에서 그대로 수행한다(자동으로
// 어디서 사진을 가져오는 게 아니라, 이미 사람이 저장해둔 사진을 처리만 함 — 스크래핑 아님).
//
// 사용법:
//   1) 사진들을 폴더 하나에 모아둔다 (기본값: ./menu-photos-inbox, 다른 폴더면 인자로 지정)
//   2) SUPABASE_SERVICE_ROLE_KEY=xxxx UPSTAGE_API_KEY=xxxx node scripts/bulk-menu-photo-import.js [폴더경로]
//   3) 사진마다: 추출된 메뉴를 보여주면 Enter(그대로 저장) / e(직접 수정) / s(건너뛰기)
//      -> 식당 이름 검색해서 선택 -> 기존 메뉴가 있으면 합치기(m)/교체(r) 선택
//   4) 처리된 사진은 폴더 안 done/(저장됨) 또는 skipped/(건너뜀)로 옮겨져서 재실행 시 안 겹침

const fs = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const UPSTAGE_KEY = process.env.UPSTAGE_API_KEY;
if (!SERVICE_KEY || !UPSTAGE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY, UPSTAGE_API_KEY 환경변수가 모두 필요합니다.");
  console.error("예: SUPABASE_SERVICE_ROLE_KEY=xxxx UPSTAGE_API_KEY=xxxx node scripts/bulk-menu-photo-import.js");
  process.exit(1);
}

const SUPABASE_URL = "https://ubvpkldnsadyxnhirjzl.supabase.co";
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const MIME_BY_EXT = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

function normalize(name) {
  return (name || "").replace(/\s+/g, "").toLowerCase();
}

function parseMenuLines(lines) {
  return lines
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, price] = line.split(":").map((p) => p.trim());
      return { name, price: Number(price) || 0 };
    })
    .filter((item) => item.name);
}

function estimateTypicalPrice(menu) {
  if (!menu.length) return null;
  const avg = menu.reduce((sum, item) => sum + item.price, 0) / menu.length;
  return Math.round(avg / 100) * 100;
}

function mergeMenu(existing, incoming) {
  const byName = new Map((existing || []).map((item) => [normalize(item.name), item]));
  for (const item of incoming) byName.set(normalize(item.name), item); // 이름 같으면 새 값으로 갱신
  return [...byName.values()];
}

async function supabaseRequest(path_, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path_}`, {
    ...options,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase request failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function uploadToStorage(buffer, filename, mime) {
  const storagePath = `bulk/${Date.now()}-${filename}`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/menu-photos/${storagePath}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": mime
    },
    body: buffer
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Storage 업로드 실패 (${res.status}): ${text}`);
  }
  return storagePath;
}

// api/extract-menu.js와 동일한 OCR + 구조화 로직
async function extractMenu(buffer, filename, mime) {
  const ocrForm = new FormData();
  ocrForm.append("document", new Blob([buffer], { type: mime }), filename);
  ocrForm.append("model", "document-parse");
  ocrForm.append("ocr", "force");
  ocrForm.append("output_formats", "['text','html']");

  const ocrRes = await fetch("https://api.upstage.ai/v1/document-digitization", {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTAGE_KEY}` },
    body: ocrForm
  });
  if (!ocrRes.ok) return { menu: [], error: `OCR 실패 (${ocrRes.status})` };

  const ocrData = await ocrRes.json();
  const rawText = ((ocrData.content && ocrData.content.text) || "").trim()
    || ((ocrData.content && ocrData.content.html) || "")
      .replace(/<[^>]+>/g, "\n")
      .replace(/&nbsp;/g, " ")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join("\n");

  if (!rawText.trim()) return { menu: [], error: "글자를 읽지 못했어요." };

  const structurePrompt = `다음은 메뉴판을 OCR로 읽은 텍스트야. 메뉴명과 가격(숫자만, 원 단위)을 추출해서 JSON 배열로만 답해.
형식: [{"name":"메뉴명","price":숫자}]
가격을 알 수 없는 항목은 제외해. 다른 설명 없이 JSON 배열만 출력해.

${rawText}`;

  const solarRes = await fetch("https://api.upstage.ai/v1/solar/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTAGE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "solar-pro", messages: [{ role: "user", content: structurePrompt }] })
  });
  if (!solarRes.ok) return { menu: [], rawText, error: `메뉴 정리 실패 (${solarRes.status})` };

  const solarData = await solarRes.json();
  const content = (solarData.choices && solarData.choices[0] && solarData.choices[0].message.content) || "[]";
  const jsonMatch = content.match(/\[[\s\S]*\]/);

  let menu = [];
  try {
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
    if (Array.isArray(parsed)) {
      menu = parsed
        .filter((item) => item && typeof item.name === "string" && item.name.trim() && Number(item.price) > 0)
        .map((item) => ({ name: item.name.trim().slice(0, 40), price: Number(item.price) }))
        .slice(0, 30);
    }
  } catch {
    menu = [];
  }

  return { menu, rawText };
}

// rl.question()을 여러 번 반복 호출하는 방식은 파이프/일부 환경의 입력에서
// 두 번째 질문부터 응답을 못 받고 죽는 문제가 실제로 발견되어(quick-menu-entry.js에서도
// 동일 문제 확인), 하나의 비동기 이터레이터를 만들어 직접 next()를 호출하는 방식을 쓴다.
function makeLineReader(rl) {
  const iterator = rl[Symbol.asyncIterator]();
  return async function nextLine() {
    const { value, done } = await iterator.next();
    return done ? null : value;
  };
}

async function ask(nextLine, prompt) {
  console.log(prompt);
  const line = await nextLine();
  return line === null ? null : line.trim();
}

async function collectLinesUntilBlank(nextLine) {
  const lines = [];
  while (true) {
    const line = await nextLine();
    if (line === null || !line.trim()) break;
    lines.push(line);
  }
  return lines;
}

async function pickRestaurant(nextLine, restaurants) {
  while (true) {
    const query = await ask(nextLine, "\n식당 이름 검색 (건너뛰려면 s): ");
    if (query === null || query.toLowerCase() === "s") return null;
    const nq = normalize(query);
    const matches = restaurants.filter((r) => normalize(r.name).includes(nq));
    if (matches.length === 0) {
      console.log("일치하는 식당이 없어요. 다시 검색해주세요.");
      continue;
    }
    if (matches.length === 1) return matches[0];
    console.log(`${matches.length}곳이 검색됐어요:`);
    matches.forEach((r, i) => console.log(`  ${i + 1}. ${r.name} (현재 메뉴 ${(r.menu || []).length}개)`));
    const pick = await ask(nextLine, "번호 선택: ");
    if (pick === null) return null;
    const idx = Number(pick) - 1;
    if (matches[idx]) return matches[idx];
    console.log("잘못된 선택이에요, 다시 검색해주세요.");
  }
}

async function main() {
  const folder = process.argv[2] || "./menu-photos-inbox";
  const doneDir = path.join(folder, "done");
  const skippedDir = path.join(folder, "skipped");
  await fs.mkdir(doneDir, { recursive: true });
  await fs.mkdir(skippedDir, { recursive: true });

  const entries = await fs.readdir(folder, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort();

  if (files.length === 0) {
    console.log(`${folder} 안에 처리할 이미지가 없어요 (jpg/jpeg/png/webp).`);
    return;
  }
  console.log(`${files.length}장을 처리합니다.\n`);

  const restaurants = await supabaseRequest("restaurants?select=id,name,menu&status=eq.approved");
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const nextLine = makeLineReader(rl);

  let saved = 0, skipped = 0;

  for (const filename of files) {
    const filePath = path.join(folder, filename);
    console.log(`\n──────── [${filename}] ────────`);
    const buffer = await fs.readFile(filePath);
    const mime = MIME_BY_EXT[path.extname(filename).toLowerCase()];

    console.log("업로드 + OCR 처리 중...");
    const storagePath = await uploadToStorage(buffer, filename, mime);
    const { menu: extracted, error } = await extractMenu(buffer, filename, mime);

    if (error) console.log(`⚠️ ${error}`);
    console.log(extracted.length ? "추출된 메뉴:" : "추출된 메뉴가 없어요.");
    extracted.forEach((item) => console.log(`  - ${item.name}: ${item.price}`));

    const action = await ask(nextLine, "\n이대로 저장(Enter) / 직접 수정(e) / 건너뛰기(s): ");
    if (action === null) break; // 입력이 끊기면 안전하게 종료

    let menu = extracted;
    if (action.toLowerCase() === "s") {
      await fs.rename(filePath, path.join(skippedDir, filename));
      skipped++;
      continue;
    }
    if (action.toLowerCase() === "e") {
      console.log("메뉴를 '이름:가격' 형식으로 한 줄씩 입력하고, 빈 줄로 끝내세요.");
      menu = parseMenuLines(await collectLinesUntilBlank(nextLine));
    }

    if (menu.length === 0) {
      console.log("메뉴가 없어서 건너뜁니다.");
      await fs.rename(filePath, path.join(skippedDir, filename));
      skipped++;
      continue;
    }

    const target = await pickRestaurant(nextLine, restaurants);
    if (!target) {
      await fs.rename(filePath, path.join(skippedDir, filename));
      skipped++;
      continue;
    }

    let finalMenu = menu;
    if ((target.menu || []).length > 0) {
      const mode = await ask(nextLine, `[${target.name}]에 이미 메뉴 ${target.menu.length}개가 있어요. 합치기(m) / 교체(r): `);
      finalMenu = mode && mode.toLowerCase() === "r" ? menu : mergeMenu(target.menu, menu);
    }

    await supabaseRequest(`restaurants?id=eq.${target.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        menu: finalMenu,
        typical_price: estimateTypicalPrice(finalMenu),
        menu_photo_url: storagePath,
        embedding: null
      })
    });
    target.menu = finalMenu; // 같은 세션에서 다시 검색될 때 최신 상태로

    console.log(`✅ [${target.name}] 메뉴 ${finalMenu.length}개 반영 완료.`);
    await fs.rename(filePath, path.join(doneDir, filename));
    saved++;
  }

  rl.close();
  console.log(`\n완료 — 저장 ${saved}장, 건너뜀 ${skipped}장.`);
  if (saved > 0) {
    console.log("이어서 아래를 실행해 임베딩을 갱신하세요:");
    console.log("  UPSTAGE_API_KEY=xxxx SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/embed-restaurants.js");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
