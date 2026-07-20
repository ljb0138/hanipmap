// 카카오 로컬 카테고리 검색 API로 캠퍼스 주변 실제 식당을 조회해 Supabase restaurants
// 테이블에 status='pending'으로 적재한다.
//
// 카카오 카테고리 검색은 한 쿼리당 최대 45곳까지만 반환한다(문서화된 API 한계).
// 캠퍼스 주변처럼 밀집 지역은 700m 반경 전체를 한 번에 요청하면 가까운 45곳 이후로는
// 전부 잘려나간다(실측: 700m 반경 total_count=490, 대학로 방향 150m 반경만도 149).
// 그래서 넓은 지역을 촘촘한 격자로 잘게 쪼개 요청하고, 그래도 한 셀에서 45개를 넘기면
// 그 셀을 다시 4분할해서 재귀적으로 더 쪼갠다(적응형 격자).
//
// 4분할 시 반지름을 절반으로 줄이면(0.5배) 대각선 방향 사이(동서남북 방향의 원 경계
// 근처)에 아무 하위 셀도 커버하지 못하는 사각지대가 생긴다 — 하위 셀 4개를 원래 중심에서
// ±반지름/2 만큼 대각선으로 옮겨 배치하는데, 반지름을 절반으로만 줄이면 그 사이 간격을
// 못 덮는다. 그래서 반지름은 0.85배로만 줄여 겹치게 하고(기존 격자 간격 대 반지름 비율
// 200:170=0.85와 동일한 비율), 대신 목표 밀도(45개 이하)에 도달할 때까지 더 깊이(최대
// 6단계) 재귀한다.
//
// 카카오 place id(doc.id)를 kakao_id로 저장해 향후 재수집 시 이름이 아니라 id로
// 정확히 중복을 판별할 수 있게 한다(기존 행은 kakao_id가 없을 수 있어 좌표 근접으로
// 보조 판별). 실행 전 scripts/migration_4_kakao_id.sql을 먼저 적용해야 한다.
//
// 실행: KAKAO_REST_KEY=xxxx node scripts/collect-places.js
// (실행 후에는 scripts/dedupe-and-approve.js로 신규분만 승인)

const KAKAO_KEY = process.env.KAKAO_REST_KEY;
if (!KAKAO_KEY) {
  console.error("KAKAO_REST_KEY 환경변수가 필요합니다. 예: KAKAO_REST_KEY=xxxx node scripts/collect-places.js");
  process.exit(1);
}

const SUPABASE_URL = "https://ubvpkldnsadyxnhirjzl.supabase.co";
const SUPABASE_KEY = "sb_publishable_bYQBH_FnrYBanG9YufSkBQ_0qPY0nG1";

const CAMPUS = { lat: 37.5849237, lng: 126.9967749 }; // 성균관대학교 정문
const COLLECTION_RADIUS_M = 700;
const GRID_STEP_M = 200;
const BASE_CELL_RADIUS_M = 170;
const MIN_CELL_RADIUS_M = 20; // 이 이하로는 더 쪼개지 않고 상위 45개만 받아들임
const MAX_SPLIT_DEPTH = 6;
const SPLIT_RATIO = 0.85; // 4분할 시 절반(0.5)으로 줄이면 대각선 사이 사각지대가 생겨서 0.85 사용
const DUPLICATE_DISTANCE_M = 25; // 이 거리 이내면 같은 곳으로 간주(좌표 근접 판별)
const CONCURRENCY = 5; // 카카오 API에 동시에 보낼 요청 수
const MAX_RETRIES = 2;

function offsetLatLng(centerLat, centerLng, dxM, dyM) {
  return {
    lat: centerLat + dyM / 111320,
    lng: centerLng + dxM / (111320 * Math.cos((centerLat * Math.PI) / 180))
  };
}

function distanceM(a, b) {
  const dLat = (a.lat - b.lat) * 111320;
  const dLng = (a.lng - b.lng) * 111320 * Math.cos((b.lat * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

async function kakaoCategorySearchRaw(lat, lng, radius, page) {
  const url = new URL("https://dapi.kakao.com/v2/local/search/category.json");
  url.searchParams.set("category_group_code", "FD6");
  url.searchParams.set("x", lng);
  url.searchParams.set("y", lat);
  url.searchParams.set("radius", Math.round(radius));
  url.searchParams.set("sort", "distance");
  url.searchParams.set("page", page);
  url.searchParams.set("size", 15);

  const res = await fetch(url, { headers: { Authorization: `KakaoAK ${KAKAO_KEY}` } });
  const data = await res.json();
  if (!res.ok || !data.meta) {
    throw new Error(`kakao search failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

async function kakaoCategorySearch(lat, lng, radius, page) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await kakaoCategorySearchRaw(lat, lng, radius, page);
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        console.warn(`  [건너뜀] lat=${lat.toFixed(5)} lng=${lng.toFixed(5)} radius=${Math.round(radius)}: ${err.message}`);
        return { documents: [], meta: { total_count: 0, is_end: true } };
      }
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
}

async function collectCell(lat, lng, radius, depth, sink) {
  const first = await kakaoCategorySearch(lat, lng, radius, 1);
  const totalCount = (first.meta && first.meta.total_count) || 0;
  (first.documents || []).forEach((doc) => sink.set(doc.id, doc));

  const childRadius = radius * SPLIT_RATIO;
  if (totalCount > 45 && depth < MAX_SPLIT_DEPTH && childRadius >= MIN_CELL_RADIUS_M) {
    const offset = radius / 2;
    const offsets = [[-offset, -offset], [-offset, offset], [offset, -offset], [offset, offset]];
    for (const [dx, dy] of offsets) {
      const sub = offsetLatLng(lat, lng, dx, dy);
      await collectCell(sub.lat, sub.lng, childRadius, depth + 1, sink);
    }
    return;
  }

  for (let page = 2; page <= 3; page++) {
    if (first.meta && first.meta.is_end) break;
    const data = await kakaoCategorySearch(lat, lng, radius, page);
    (data.documents || []).forEach((doc) => sink.set(doc.id, doc));
    if (data.meta && data.meta.is_end) break;
  }
}

async function mapWithConcurrency(items, limit, fn) {
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index++;
      await fn(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function collectPlaces() {
  const sink = new Map(); // kakao id -> doc (자동 중복 제거, 동시 실행에도 안전)
  const halfSpan = COLLECTION_RADIUS_M + GRID_STEP_M; // 경계 근처 누락 방지용 여유

  const gridPoints = [];
  for (let dy = -halfSpan; dy <= halfSpan; dy += GRID_STEP_M) {
    for (let dx = -halfSpan; dx <= halfSpan; dx += GRID_STEP_M) {
      gridPoints.push(offsetLatLng(CAMPUS.lat, CAMPUS.lng, dx, dy));
    }
  }
  console.log(`기본 격자 ${gridPoints.length}개 셀을 동시 ${CONCURRENCY}개씩 탐색합니다...`);

  await mapWithConcurrency(gridPoints, CONCURRENCY, (cell) =>
    collectCell(cell.lat, cell.lng, BASE_CELL_RADIUS_M, 0, sink)
  );

  const rows = [];
  for (const doc of sink.values()) {
    const docLatLng = { lat: Number(doc.y), lng: Number(doc.x) };
    const dist = distanceM(docLatLng, CAMPUS);
    if (dist > COLLECTION_RADIUS_M) continue; // 격자 여유분 중 실제로는 반경 밖인 것 제외

    rows.push({
      kakao_id: doc.id,
      name: doc.place_name,
      address: doc.road_address_name || doc.address_name || "",
      lat: docLatLng.lat,
      lng: docLatLng.lng,
      walk_minutes: Math.max(1, Math.round(dist / 80)),
      typical_price: null,
      tags: [],
      menu: [],
      hours: {},
      base_reason: null,
      submitted_by: "kakao-bulk-import",
      status: "pending"
    });
  }
  return rows;
}

async function fetchExistingApproved() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/restaurants?select=id,name,lat,lng,kakao_id&status=eq.approved`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  return res.json();
}

function isDuplicateOfExisting(row, existing) {
  return existing.some((e) => {
    if (e.kakao_id && e.kakao_id === row.kakao_id) return true;
    if (e.lat == null || e.lng == null) return false;
    return distanceM({ lat: e.lat, lng: e.lng }, { lat: row.lat, lng: row.lng }) < DUPLICATE_DISTANCE_M;
  });
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
  console.log(`카카오에서 격자 탐색으로 ${places.length}곳을 찾았습니다 (id 기준 중복 제거 완료).`);

  const existing = await fetchExistingApproved();
  const fresh = places.filter((row) => !isDuplicateOfExisting(row, existing));
  const skipped = places.length - fresh.length;
  console.log(`이미 승인된 식당과 좌표/id가 겹쳐 건너뜀: ${skipped}곳`);
  console.log(`새로 pending 등록: ${fresh.length}곳`);

  if (fresh.length > 0) {
    // Supabase REST 한 번 insert에 너무 많은 행을 보내지 않도록 묶어서 전송
    const CHUNK = 200;
    for (let i = 0; i < fresh.length; i += CHUNK) {
      await insertRows(fresh.slice(i, i + CHUNK));
    }
  }
  console.log("done — scripts/dedupe-and-approve.js로 신규분을 검토 후 승인해주세요.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
