// 팀 구글시트 [식당] 탭에서 식당이름은 있는데 위도/경도가 비어있는 행을 찾아,
// 배포된 /api/search(네이버 검색 프록시)로 좌표를 조회해 보여준다.
// 시트에 직접 쓰지는 못하므로(Google Workspace 계정은 Apps Script 공개 배포가
// 막혀있어 자동 반영이 불가능함이 확인됨), 결과를 표로 출력하면 사람이 복사해서
// 시트에 붙여넣는다. 읽기 전용이라 별도 키/인증이 필요없다.
//
// 실행: node scripts/geocode-sheet-addresses.js

const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/1r_G6Z6FhlCQ_svQifrvQAWjlCyicOeB6UB4PPbboGTQ/export?format=csv&gid=0";
const SEARCH_API_URL = "https://hanipmap.vercel.app/api/search";

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

async function fetchSheetRows() {
  const res = await fetch(SHEET_CSV_URL);
  if (!res.ok) throw new Error(`시트를 가져오지 못했습니다 (${res.status})`);
  const text = await res.text();
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row = {};
    header.forEach((key, i) => { row[key] = (cells[i] || "").trim(); });
    return row;
  });
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

async function main() {
  const rows = await fetchSheetRows();
  const missing = rows.filter((r) => r["식당이름"] && (!r["위도"] || !r["경도"]));

  if (missing.length === 0) {
    console.log("좌표가 비어있는 식당이 없습니다.");
    return;
  }

  console.log(`좌표가 비어있는 식당 ${missing.length}곳을 조회합니다...\n`);

  const found = [];
  const notFound = [];

  for (const row of missing) {
    const name = row["식당이름"];
    const place = await lookupPlace(name);
    if (place) {
      found.push({ id: row["식당ID"], name, ...place });
    } else {
      notFound.push({ id: row["식당ID"], name, address: row["주소"] });
    }
  }

  if (found.length) {
    console.log("✅ 찾음 — 아래 표를 시트의 위도/경도 칸에 옮겨주세요:\n");
    console.log("식당ID\t식당이름\t위도\t경도\t(찾은 주소)");
    found.forEach((f) => console.log(`${f.id}\t${f.name}\t${f.lat}\t${f.lng}\t${f.address}`));
  }

  if (notFound.length) {
    console.log("\n❓ 못 찾음 — 이름 표기를 확인하거나 직접 입력해주세요:");
    notFound.forEach((f) => console.log(`  ${f.id} ${f.name} (기존 주소: ${f.address || "없음"})`));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
