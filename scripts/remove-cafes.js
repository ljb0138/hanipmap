// collect-places.js가 예전에 카카오 CE7(카페) 카테고리까지 같이 수집해서 DB에 카페가 섞여
// 들어갔다. "한 끼 해결" 추천 목적과 맞지 않아 정리해야 하는데, DB에는 어떤 카테고리로
// 수집됐는지 기록이 없어서(당시 insert에 category_group_code를 안 남겼음) 카카오 CE7
// 검색을 다시 돌려 이름을 대조하는 방식으로 식별한다.
//
// 이 스크립트는 읽기 전용이다 — DB를 직접 건드리지 않고, 지울 대상 목록과 SQL을 출력만
// 한다. 출력된 SQL을 검토한 뒤 Supabase SQL Editor에서 직접 실행할 것.
//
// 실행: KAKAO_REST_KEY=xxxx node scripts/remove-cafes.js

const KAKAO_KEY = process.env.KAKAO_REST_KEY;
if (!KAKAO_KEY) {
  console.error("KAKAO_REST_KEY 환경변수가 필요합니다. 예: KAKAO_REST_KEY=xxxx node scripts/remove-cafes.js");
  process.exit(1);
}

const CAMPUS = { lat: 37.5856, lng: 126.9897 };
const RADIUS_M = 700;

async function kakaoCategorySearch(page) {
  const url = new URL("https://dapi.kakao.com/v2/local/search/category.json");
  url.searchParams.set("category_group_code", "CE7");
  url.searchParams.set("x", CAMPUS.lng);
  url.searchParams.set("y", CAMPUS.lat);
  url.searchParams.set("radius", RADIUS_M);
  url.searchParams.set("sort", "distance");
  url.searchParams.set("page", page);
  url.searchParams.set("size", 15);

  const res = await fetch(url, { headers: { Authorization: `KakaoAK ${KAKAO_KEY}` } });
  return res.json();
}

function sqlEscape(text) {
  return text.replace(/'/g, "''");
}

async function main() {
  const names = new Set();

  for (let page = 1; page <= 3; page++) {
    const data = await kakaoCategorySearch(page);
    const documents = data.documents || [];
    if (documents.length === 0) break;
    documents.forEach((doc) => names.add(doc.place_name));
    if (data.meta && data.meta.is_end) break;
  }

  if (names.size === 0) {
    console.log("카페로 식별된 곳이 없습니다.");
    return;
  }

  const nameList = [...names];
  console.log(`카카오 CE7(카페)로 확인된 ${nameList.length}곳:`);
  nameList.forEach((name) => console.log(`  - ${name}`));

  const valuesSql = nameList.map((name) => `'${sqlEscape(name)}'`).join(", ");
  console.log("\n아래 SQL을 Supabase SQL Editor에서 검토 후 실행하세요.");
  console.log("(submitted_by='kakao-bulk-import' 조건으로 자동 수집분만 지우고, 수동 제보/큐레이션 데이터는 건드리지 않습니다)\n");
  console.log(
    `delete from restaurants\n  where submitted_by = 'kakao-bulk-import'\n  and name in (${valuesSql});`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
