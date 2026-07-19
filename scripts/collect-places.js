// 1회성 대량 수집 스크립트: 카카오 로컬 카테고리 검색 API로 캠퍼스 주변 실제 식당/카페를
// 조회해 Supabase restaurants 테이블에 status='pending'으로 적재한다.
//
// 실행: KAKAO_REST_KEY=xxxx node scripts/collect-places.js
// (KAKAO_REST_KEY는 절대 코드에 하드코딩하지 않는다. 실행 후에는 Supabase SQL Editor에서
//  `update public.restaurants set status='approved' where status='pending';`로 일괄 승인한다.)

const KAKAO_KEY = process.env.KAKAO_REST_KEY;
if (!KAKAO_KEY) {
  console.error("KAKAO_REST_KEY 환경변수가 필요합니다. 예: KAKAO_REST_KEY=xxxx node scripts/collect-places.js");
  process.exit(1);
}

const SUPABASE_URL = "https://ubvpkldnsadyxnhirjzl.supabase.co";
const SUPABASE_KEY = "sb_publishable_bYQBH_FnrYBanG9YufSkBQ_0qPY0nG1";

const CAMPUS = { lat: 37.5856, lng: 126.9897 };
const RADIUS_M = 700;
const CATEGORY_CODES = ["FD6"]; // FD6=음식점만 (CE7=카페는 "한 끼 해결" 추천과 맞지 않아 제외)

async function kakaoCategorySearch(categoryCode, page) {
  const url = new URL("https://dapi.kakao.com/v2/local/search/category.json");
  url.searchParams.set("category_group_code", categoryCode);
  url.searchParams.set("x", CAMPUS.lng);
  url.searchParams.set("y", CAMPUS.lat);
  url.searchParams.set("radius", RADIUS_M);
  url.searchParams.set("sort", "distance");
  url.searchParams.set("page", page);
  url.searchParams.set("size", 15);

  const res = await fetch(url, { headers: { Authorization: `KakaoAK ${KAKAO_KEY}` } });
  return res.json();
}

async function collectPlaces() {
  const seen = new Set();
  const rows = [];

  for (const code of CATEGORY_CODES) {
    for (let page = 1; page <= 3; page++) {
      const data = await kakaoCategorySearch(code, page);
      const documents = data.documents || [];
      if (documents.length === 0) break;

      for (const doc of documents) {
        const key = `${doc.place_name}__${doc.road_address_name || doc.address_name}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const distanceM = Number(doc.distance) || 0;
        rows.push({
          name: doc.place_name,
          address: doc.road_address_name || doc.address_name || "",
          lat: Number(doc.y),
          lng: Number(doc.x),
          walk_minutes: distanceM ? Math.max(1, Math.round(distanceM / 80)) : null,
          typical_price: null,
          tags: [],
          menu: [],
          hours: {},
          base_reason: null,
          submitted_by: "kakao-bulk-import",
          status: "pending"
        });
      }

      if (data.meta && data.meta.is_end) break;
    }
  }

  return rows;
}

async function insertRows(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/restaurants`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify(rows)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase insert failed (${res.status}): ${text}`);
  }
}

async function main() {
  const places = await collectPlaces();
  console.log(`collected ${places.length} places`);
  if (places.length > 0) {
    await insertRows(places);
  }
  console.log("done — Supabase SQL Editor에서 pending -> approved로 일괄 승인해주세요.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
