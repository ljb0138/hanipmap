// 팀 공용 구글시트([식당]/[메뉴] 탭) 형식에 맞춰, 사람이 직접 저장한 메뉴판 사진들을
// 한 폴더에 모아두면 한 장씩 OCR로 메뉴를 추출하고, 확인/수정을 거쳐 두 개의 CSV
// (식당 탭용 / 메뉴 탭용)로 뽑아준다. Supabase가 아니라 팀 시트가 목적지라
// SUPABASE 키는 필요없고 UPSTAGE_API_KEY만 있으면 된다.
//
// 팀 규칙(파일명 "수집자-식당이름.jpg", 여러 장이면 -1,-2)을 그대로 따르면
// 수집자/식당이름을 파일명에서 자동으로 채워준다. 주소는 이름으로 네이버 검색해
// 자동으로 찾고, 위도/경도도 같이 채운다.
//
// 사용법:
//   1) 사진들을 폴더에 모은다 (기본값 ./team-sheet-inbox)
//   2) UPSTAGE_API_KEY=xxxx node scripts/bulk-photo-to-team-sheet.js [폴더경로]
//   3) 사진마다: 메뉴 확인/수정 -> 식당이름/수집자 확인 -> 주소 자동조회 확인
//      -> 카테고리 번호 선택 -> 태그 입력(쉼표구분, 생략가능)
//   4) 끝나면 restaurants.csv / menu.csv 두 파일이 생성됨 -> 각 탭에 붙여넣기

const fs = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");

const UPSTAGE_KEY = process.env.UPSTAGE_API_KEY;
if (!UPSTAGE_KEY) {
  console.error("UPSTAGE_API_KEY 환경변수가 필요합니다. 예: UPSTAGE_API_KEY=xxxx node scripts/bulk-photo-to-team-sheet.js");
  process.exit(1);
}

const SEARCH_API_URL = "https://hanipmap.vercel.app/api/search";
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const MIME_BY_EXT = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const CATEGORIES = ["한식", "중식", "일식", "양식", "분식", "세계음식", "고기/구이", "술집", "카페/디저트"];

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvRow(cells) {
  return cells.map(csvEscape).join(",");
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

// 파일명 규칙 "수집자-식당이름.jpg" (여러 장이면 "수집자-식당이름-1.jpg")에서 추측
function guessFromFilename(filename) {
  const base = filename.replace(/\.[^.]+$/, "");
  const parts = base.split("-");
  if (parts.length < 2) return { collector: "", name: base };
  const collector = parts[0].trim();
  const namePart = parts.slice(1).filter((p) => !/^\d+$/.test(p.trim())).join("-").trim();
  return { collector, name: namePart || base };
}

async function lookupPlace(query) {
  try {
    const res = await fetch(`${SEARCH_API_URL}?query=${encodeURIComponent(query)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const item = data.items && data.items[0];
    if (!item) return null;
    return {
      name: item.title.replace(/<\/?b>/g, ""),
      address: (item.roadAddress || item.address || "").trim(),
      lat: Number(item.mapy) / 1e7,
      lng: Number(item.mapx) / 1e7
    };
  } catch {
    return null;
  }
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

function makeLineReader(rl) {
  const iterator = rl[Symbol.asyncIterator]();
  return async function nextLine() {
    const { value, done } = await iterator.next();
    return done ? null : value;
  };
}

async function ask(nextLine, prompt, defaultValue = "") {
  console.log(prompt);
  const line = await nextLine();
  if (line === null) return defaultValue;
  const trimmed = line.trim();
  return trimmed || defaultValue;
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

async function pickCategory(nextLine) {
  console.log("카테고리를 선택하세요:");
  CATEGORIES.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
  while (true) {
    const pick = await ask(nextLine, "번호 선택 (모르면 Enter로 건너뜀): ");
    if (!pick) return "";
    const idx = Number(pick) - 1;
    if (CATEGORIES[idx]) return CATEGORIES[idx];
    console.log("잘못된 번호예요, 다시 선택하세요.");
  }
}

async function main() {
  const folder = process.argv[2] || "./team-sheet-inbox";
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

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const nextLine = makeLineReader(rl);

  const restaurantRows = [];
  const menuRows = [];
  let saved = 0, skipped = 0;

  for (const filename of files) {
    const filePath = path.join(folder, filename);
    console.log(`\n──────── [${filename}] ────────`);
    const buffer = await fs.readFile(filePath);
    const mime = MIME_BY_EXT[path.extname(filename).toLowerCase()];
    const guess = guessFromFilename(filename);

    console.log("OCR 처리 중...");
    const { menu: extracted, error } = await extractMenu(buffer, filename, mime);
    if (error) console.log(`⚠️ ${error}`);
    console.log(extracted.length ? "추출된 메뉴:" : "추출된 메뉴가 없어요.");
    extracted.forEach((item) => console.log(`  - ${item.name}: ${item.price}`));

    const action = await ask(nextLine, "\n이대로 저장(Enter) / 직접 수정(e) / 건너뛰기(s): ");
    if (action.toLowerCase() === "s") {
      await fs.rename(filePath, path.join(skippedDir, filename));
      skipped++;
      continue;
    }
    let menu = extracted;
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

    const name = await ask(nextLine, `식당이름 (Enter="${guess.name}"): `, guess.name);
    const collector = await ask(nextLine, `수집자 (Enter="${guess.collector}"): `, guess.collector);

    console.log("네이버지도에서 주소/좌표 찾는 중...");
    const place = await lookupPlace(name);
    let address = "", lat = "", lng = "";
    if (place) {
      console.log(`찾음: ${place.name} · ${place.address}`);
      const confirm = await ask(nextLine, "이 주소가 맞나요? (Enter=예 / n=아니오): ");
      if (!confirm || confirm.toLowerCase() !== "n") {
        address = place.address;
        lat = place.lat;
        lng = place.lng;
      }
    } else {
      console.log("주소를 못 찾았어요. 시트에서 직접 채워주세요.");
    }

    const category = await pickCategory(nextLine);
    const tags = await ask(nextLine, "태그 (쉼표로 구분, 없으면 Enter): ");

    restaurantRows.push([
      "", name, category, address, lat, lng, tags, "", collector, todayDate(), "입력완료"
    ]);
    for (const item of menu) {
      menuRows.push(["", name, item.name, item.price, "사진파싱", "대기", ""]);
    }

    console.log(`✅ [${name}] 메뉴 ${menu.length}개 기록됨.`);
    await fs.rename(filePath, path.join(doneDir, filename));
    saved++;
  }

  rl.close();

  if (restaurantRows.length) {
    const restaurantsCsv = [
      csvRow(["식당ID", "식당이름", "카테고리", "주소", "위도", "경도", "태그(쉼표 구분)", "메뉴판 사진 링크", "수집자", "촬영일", "상태"]),
      ...restaurantRows.map(csvRow)
    ].join("\n");
    await fs.writeFile("restaurants.csv", restaurantsCsv, "utf-8");

    const menuCsv = [
      csvRow(["식당ID", "식당이름", "메뉴명", "가격(원)", "출처", "검수", "비고"]),
      ...menuRows.map(csvRow)
    ].join("\n");
    await fs.writeFile("menu.csv", menuCsv, "utf-8");

    console.log(`\n완료 — 저장 ${saved}장, 건너뜀 ${skipped}장.`);
    console.log("restaurants.csv -> [식당] 탭에 붙여넣기");
    console.log("menu.csv -> [메뉴] 탭에 붙여넣기");
  } else {
    console.log(`\n완료 — 저장된 게 없어요 (건너뜀 ${skipped}장).`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
