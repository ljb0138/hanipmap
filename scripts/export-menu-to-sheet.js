// hanipmap DB(Supabase)에서 메뉴 데이터가 채워진 식당을, 팀 구글시트와 같은 형식
// ("식당ID,식당이름,메뉴명,가격(원),출처,검수,비고")의 CSV로 내보낸다.
// 이미 팀 시트에 있는 식당(이름 기준)은 중복 방지를 위해 자동으로 제외한다.
//
// Google Sheets에 "쓰기"는 별도 API 인증(서비스 계정)이 필요해서, 대신 CSV를
// 만들어두면 구글시트에서 파일 > 가져오기(또는 복사해서 붙여넣기)로 간단히
// 옮길 수 있다. Supabase는 읽기 전용(anon 키)만 쓰므로 service-role 키가
// 필요없다.
//
// 실행: node scripts/export-menu-to-sheet.js > export.csv
// (또는 파일로 바로 저장: node scripts/export-menu-to-sheet.js export.csv)

const fs = require("node:fs");

const SUPABASE_URL = "https://ubvpkldnsadyxnhirjzl.supabase.co";
const SUPABASE_KEY = "sb_publishable_bYQBH_FnrYBanG9YufSkBQ_0qPY0nG1"; // anon, 읽기 전용
const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/1r_G6Z6FhlCQ_svQifrvQAWjlCyicOeB6UB4PPbboGTQ/export?format=csv&gid=10";

function normalize(name) {
  return (name || "").replace(/\s+/g, "").replace(/[()]/g, "").toLowerCase();
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
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

async function fetchExistingSheetNames() {
  try {
    const res = await fetch(SHEET_CSV_URL);
    if (!res.ok) return new Set();
    const text = await res.text();
    const lines = text.split(/\r?\n/).filter(Boolean);
    const names = new Set();
    for (const line of lines.slice(1)) {
      const cells = splitCsvLine(line);
      const name = (cells[1] || "").trim();
      if (name) names.add(normalize(name));
    }
    return names;
  } catch {
    return new Set(); // 실패해도 export 자체는 계속 진행(중복 방지만 못 함)
  }
}

async function fetchRestaurantsWithMenu() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/restaurants?select=id,name,menu,menu_photo_url&status=eq.approved&menu=neq.%5B%5D`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  if (!res.ok) throw new Error(`Supabase 조회 실패 (${res.status})`);
  return res.json();
}

async function main() {
  const [restaurants, existingNames] = await Promise.all([
    fetchRestaurantsWithMenu(),
    fetchExistingSheetNames()
  ]);

  const rows = [["식당ID", "식당이름", "메뉴명", "가격(원)", "출처", "검수", "비고"]];
  let included = 0;
  let skipped = 0;

  for (const r of restaurants) {
    if (!r.menu || r.menu.length === 0) continue;
    if (existingNames.has(normalize(r.name))) {
      skipped++;
      continue;
    }
    included++;
    const source = r.menu_photo_url ? "사진파싱" : "수기입력";
    for (const item of r.menu) {
      rows.push([`H${r.id}`, r.name, item.name, item.price, source, "확인", "hanipmap에서 반입"]);
    }
  }

  const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\n");
  const outPath = process.argv[2];

  if (outPath) {
    fs.writeFileSync(outPath, csv, "utf-8");
    console.error(`저장됨: ${outPath}`);
  } else {
    console.log(csv);
  }
  console.error(`식당 ${included}곳 내보냄 (이미 팀 시트에 있어 건너뜀: ${skipped}곳)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
