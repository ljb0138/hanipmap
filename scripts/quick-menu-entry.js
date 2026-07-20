// 네이버지도 등에서 사용자가 직접 눈으로 확인한 메뉴 정보를, 터미널에서 빠르게
// 타이핑만으로 바로 DB에 반영하는 도구. 자동으로 어디서 데이터를 긁어오지 않는다 —
// 사람이 직접 확인하고 입력하는 걸 빠르게 만드는 것뿐이라 이용약관 문제가 없다.
//
// 흐름: 식당 이름을 검색어로 입력 -> 후보 중 선택 -> 메뉴를 "이름:가격" 형식으로
// 한 줄씩 입력(빈 줄 입력 시 종료) -> Solar가 메뉴를 보고 한줄설명 초안을 제시하면
// 그대로 쓰거나 직접 수정 -> 바로 승인된 식당에 반영. 한줄설명(base_reason)은 의미검색
// 임베딩 텍스트에 들어가는 핵심 재료라서, AI가 초안만 쓰고 사람이 확인/수정하게 해
// "AI가 마음대로 지어내지 않는다"는 원칙은 유지하면서도 매번 직접 쓰는 부담을 줄인다.
// 메뉴/설명이 바뀌었으니 embedding은 비워서, 다음에 node scripts/embed-restaurants.js를
// 돌리면 새로 계산된다.
//
// 실행: SUPABASE_SERVICE_ROLE_KEY=xxxx UPSTAGE_API_KEY=xxxx node scripts/quick-menu-entry.js

const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const UPSTAGE_KEY = process.env.UPSTAGE_API_KEY;
if (!SERVICE_KEY || !UPSTAGE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY, UPSTAGE_API_KEY 환경변수가 모두 필요합니다.");
  console.error("예: SUPABASE_SERVICE_ROLE_KEY=xxxx UPSTAGE_API_KEY=xxxx node scripts/quick-menu-entry.js");
  process.exit(1);
}

const SUPABASE_URL = "https://ubvpkldnsadyxnhirjzl.supabase.co";

function normalize(name) {
  return (name || "").replace(/\s+/g, "").toLowerCase();
}

function parseMenuText(lines) {
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, price] = line.split(":").map((part) => part.trim());
      return { name, price: Number(price) || 0 };
    })
    .filter((item) => item.name);
}

function estimateTypicalPrice(menu) {
  if (!menu.length) return null;
  const avg = menu.reduce((sum, item) => sum + item.price, 0) / menu.length;
  return Math.round(avg / 100) * 100;
}

async function supabaseRequest(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
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

async function draftReason(name, menu) {
  const menuText = menu.map((m) => `${m.name}:${m.price}`).join(", ");
  const prompt = `식당 이름과 메뉴를 보고, 이 식당을 한 문장으로 소개하는 문장을 만들어줘.
대학 캠퍼스 주변 맛집을 추천해주는 앱에서 쓸 문장이야. 40자 이내, 존댓말, 과장 없이
메뉴/가격대에서 드러나는 사실만 반영해서 써줘. 다른 설명 없이 문장 하나만 출력해.

식당: ${name}
메뉴: ${menuText}`;

  try {
    const res = await fetch("https://api.upstage.ai/v1/solar/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTAGE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "solar-pro", messages: [{ role: "user", content: prompt }] })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = ((data.choices && data.choices[0] && data.choices[0].message.content) || "").trim();
    return text ? text.replace(/^["']|["']$/g, "").slice(0, 60) : null;
  } catch {
    return null;
  }
}

async function applyMenu(target, menuLines, reason) {
  const menu = parseMenuText(menuLines);
  if (menu.length === 0) {
    console.log("입력된 메뉴가 없어서 건너뜁니다.\n");
    return;
  }
  await supabaseRequest(`restaurants?id=eq.${target.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      menu,
      typical_price: estimateTypicalPrice(menu),
      base_reason: reason || null,
      embedding: null
    })
  });
  target.menu = menu;
  console.log(`✅ [${target.name}] 메뉴 ${menu.length}개 + 한줄설명 반영 완료.\n`);
}

async function main() {
  const restaurants = await supabaseRequest("restaurants?select=id,name,menu&status=eq.approved");
  console.log(`승인된 식당 ${restaurants.length}곳 로드 완료.\n`);

  const rl = readline.createInterface({ input: stdin, output: stdout });

  // 상태 기계로 처리: rl.question()을 반복 호출하는 방식은 입력이 파이프로 들어올 때
  // 두 번째 질문부터 응답을 못 받는 경우가 있어(테스트 중 실제로 발견), 대신
  // for-await 비동기 이터레이터로 한 줄씩 안정적으로 소비한다.
  let state = "search"; // "search" | "pick" | "menu" | "reason"
  let candidates = [];
  let target = null;
  let menuLines = [];
  let draftedReason = null;

  console.log("식당 이름 검색 (그만하려면 exit): ");

  for await (const rawLine of rl) {
    const line = rawLine.trim();

    if (state === "search") {
      if (!line || line.toLowerCase() === "exit") break;

      const nq = normalize(line);
      const matches = restaurants.filter((r) => normalize(r.name).includes(nq));

      if (matches.length === 0) {
        console.log("일치하는 식당이 없어요. 다시 검색해주세요.\n");
        console.log("식당 이름 검색 (그만하려면 exit): ");
      } else if (matches.length === 1) {
        target = matches[0];
        console.log(`\n[${target.name}] 선택됨. 현재 메뉴: ${(target.menu || []).map((m) => `${m.name}:${m.price}`).join(", ") || "없음"}`);
        console.log("메뉴를 한 줄에 하나씩 '이름:가격' 형식으로 입력하고, 다 쓰면 빈 줄을 입력하세요.\n(예: 순대국밥:8000)");
        menuLines = [];
        state = "menu";
      } else {
        candidates = matches;
        console.log(`${matches.length}곳이 검색됐어요:`);
        matches.forEach((r, i) => console.log(`  ${i + 1}. ${r.name} (현재 메뉴 ${(r.menu || []).length}개)`));
        console.log("번호를 선택하세요: ");
        state = "pick";
      }
      continue;
    }

    if (state === "pick") {
      const idx = Number(line) - 1;
      if (!candidates[idx]) {
        console.log("잘못된 선택이에요. 다시 검색해주세요.\n");
        console.log("식당 이름 검색 (그만하려면 exit): ");
        state = "search";
        continue;
      }
      target = candidates[idx];
      console.log(`\n[${target.name}] 선택됨. 현재 메뉴: ${(target.menu || []).map((m) => `${m.name}:${m.price}`).join(", ") || "없음"}`);
      console.log("메뉴를 한 줄에 하나씩 '이름:가격' 형식으로 입력하고, 다 쓰면 빈 줄을 입력하세요.\n(예: 순대국밥:8000)");
      menuLines = [];
      state = "menu";
      continue;
    }

    if (state === "menu") {
      if (!line) {
        const menu = parseMenuText(menuLines);
        if (menu.length === 0) {
          console.log("입력된 메뉴가 없어서 건너뜁니다.\n");
          target = null;
          menuLines = [];
          state = "search";
          console.log("식당 이름 검색 (그만하려면 exit): ");
          continue;
        }
        console.log("한줄설명 초안 만드는 중...");
        draftedReason = await draftReason(target.name, menu);
        if (draftedReason) {
          console.log(`AI 초안: "${draftedReason}"`);
          console.log("이대로 저장하려면 Enter, 바꾸려면 직접 입력하세요: ");
        } else {
          console.log("AI 초안 생성에 실패했어요. 직접 입력하거나(비워두려면 Enter):");
        }
        state = "reason";
        continue;
      }
      menuLines.push(rawLine);
      continue;
    }

    if (state === "reason") {
      const finalReason = line ? line : draftedReason;
      await applyMenu(target, menuLines, finalReason);
      target = null;
      menuLines = [];
      draftedReason = null;
      state = "search";
      console.log("식당 이름 검색 (그만하려면 exit): ");
      continue;
    }
  }

  rl.close();
  console.log("\n종료합니다. 메뉴를 바꾼 식당이 있다면 이어서 아래를 실행해 임베딩을 갱신하세요:");
  console.log("  UPSTAGE_API_KEY=xxxx SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/embed-restaurants.js");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
