// 팀에서 관리 중인 구글 시트("식당ID, 식당이름, 메뉴명, 가격(원), 출처, 검수, 비고")를
// 읽어서, 검수='확인'된 메뉴만 Supabase restaurants에 반영한다.
//
// 시트 -> DB 매칭은 이름을 엄격하게 정규화해서(공백/괄호 제거 + 흔한 지점 접미사 제거)
// "정확히 일치"할 때만 자동 반영한다. 느슨한 부분일치(substring)는 쓰지 않는다 —
// 예를 들어 "백미향마라탕 명륜점"이 전혀 다른 식당인 "미향"과 부분일치해버리는
// 사고가 실제로 발견되어(정확매칭으로 바꾸면 사라짐), 오매칭 위험이 검증됨.
// 매칭 안 되는 이름은 자동 반영하지 않고 목록으로만 보여준다 — 새 식당일 수도,
// 표기 차이일 수도 있어 사람이 확인해야 한다.
//
// 기본은 dry-run(무엇을 반영할지 출력만). 실제로 반영하려면 --apply를 붙인다.
//
// 실행: SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/import-menu-sheet.js [--apply]

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다. 예: SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/import-menu-sheet.js");
  process.exit(1);
}

const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/1r_G6Z6FhlCQ_svQifrvQAWjlCyicOeB6UB4PPbboGTQ/export?format=csv&gid=10";
const SUPABASE_URL = "https://ubvpkldnsadyxnhirjzl.supabase.co";
const apply = process.argv.includes("--apply");

function normalize(name) {
  let s = (name || "").replace(/\s+/g, "").replace(/[()]/g, "");
  for (const suf of ["점", "본점", "직영", "서울", "종로", "성대", "성균관대", "대학로", "앞", "캠퍼스", "역점", "별관"]) {
    s = s.split(suf).join("");
  }
  return s.toLowerCase();
}

// 아주 단순한 CSV 파서: 이 시트는 셀 안에 줄바꿈이 없고 콤마 포함 필드만 따옴표로
// 감싸는 표준 형태라 정규식 기반 split으로 충분하다.
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row = {};
    header.forEach((key, i) => { row[key] = cells[i] || ""; });
    return row;
  });
}

function splitCsvLine(line) {
  const cells = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { cur += ch; }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { cells.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  cells.push(cur);
  return cells;
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

async function fetchSheet() {
  const res = await fetch(SHEET_CSV_URL);
  if (!res.ok) throw new Error(`시트를 가져오지 못했습니다 (${res.status}) — 공유 설정이 "링크가 있는 모든 사용자"인지 확인해주세요.`);
  return res.text();
}

function groupBySheetRestaurant(rows) {
  const groups = new Map(); // key: "식당ID|식당이름" -> menu items(확인만)
  for (const row of rows) {
    const name = (row["식당이름"] || "").trim();
    const id = (row["식당ID"] || "").trim();
    if (!name) continue;
    if (id === "R000" || id === "TEST" || name.includes("예시") || name.includes("E2E검증")) continue;

    const key = `${id}|${name}`;
    if (!groups.has(key)) groups.set(key, { id, name, items: [] });
    if ((row["검수"] || "").trim() === "확인") {
      const menuName = (row["메뉴명"] || "").trim();
      const price = Number((row["가격(원)"] || "").replace(/[^\d]/g, "")) || 0;
      if (menuName) groups.get(key).items.push({ name: menuName, price });
    }
  }
  return [...groups.values()];
}

async function main() {
  const csvText = await fetchSheet();
  const rows = parseCsv(csvText);
  const sheetRestaurants = groupBySheetRestaurant(rows);
  console.log(`시트에서 식당 ${sheetRestaurants.length}곳을 읽었습니다.`);

  const dbRestaurants = await supabaseRequest("restaurants?select=id,name&status=eq.approved");
  const dbByNorm = new Map();
  for (const r of dbRestaurants) {
    const key = normalize(r.name);
    if (!dbByNorm.has(key)) dbByNorm.set(key, []);
    dbByNorm.get(key).push(r);
  }

  const toApply = [];
  const unmatched = [];
  const noVerifiedMenu = [];
  const ambiguous = [];

  for (const sr of sheetRestaurants) {
    if (sr.items.length === 0) {
      noVerifiedMenu.push(sr);
      continue;
    }
    const candidates = dbByNorm.get(normalize(sr.name)) || [];
    if (candidates.length === 0) {
      unmatched.push(sr);
    } else if (candidates.length > 1) {
      ambiguous.push({ sr, candidates });
    } else {
      toApply.push({ sr, target: candidates[0] });
    }
  }

  console.log(`\n✅ 자동 반영 대상 (${toApply.length}곳):`);
  toApply.forEach(({ sr, target }) => console.log(`   [${target.id}] ${target.name}  <- 시트 "${sr.name}" (메뉴 ${sr.items.length}개)`));

  if (ambiguous.length) {
    console.log(`\n⚠️ DB에 같은 이름이 여러 개라 자동 반영 보류 (${ambiguous.length}곳, 수동 확인 필요):`);
    ambiguous.forEach(({ sr, candidates }) => console.log(`   시트 "${sr.name}" -> DB 후보 ${candidates.map((c) => `[${c.id}]${c.name}`).join(", ")}`));
  }

  if (unmatched.length) {
    console.log(`\n❓ DB에서 못 찾음 (${unmatched.length}곳, 표기 차이이거나 아직 DB에 없는 신규 식당일 수 있음):`);
    unmatched.forEach((sr) => console.log(`   시트 "${sr.name}" (메뉴 ${sr.items.length}개, 시트 ID ${sr.id})`));
  }

  if (noVerifiedMenu.length) {
    console.log(`\n⏳ 검수 '확인' 항목이 아직 없어 건너뜀 (${noVerifiedMenu.length}곳): ${noVerifiedMenu.map((sr) => sr.name).join(", ")}`);
  }

  if (!apply) {
    console.log("\n(dry-run) 위 내용을 확인한 뒤, 실제로 반영하려면 --apply 옵션을 붙여 다시 실행하세요.");
    return;
  }

  for (const { sr, target } of toApply) {
    await supabaseRequest(`restaurants?id=eq.${target.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        menu: sr.items,
        typical_price: estimateTypicalPrice(sr.items),
        embedding: null
      })
    });
    console.log(`   [${target.id}] ${target.name}: 메뉴 ${sr.items.length}개 반영 완료`);
  }
  console.log(`\n완료 — ${toApply.length}곳 반영. 이어서 embed-restaurants.js를 실행해 임베딩을 갱신해주세요.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
