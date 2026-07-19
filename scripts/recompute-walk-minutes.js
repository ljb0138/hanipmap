// CAMPUS 기준 좌표가 실제 정문 위치와 약 630m 어긋나 있던 걸 바로잡으면서(app.js/
// collect-places.js/remove-cafes.js 동시 수정), 이미 승인된 식당들의 walk_minutes도
// 새 기준점으로 다시 계산해야 한다. Kakao API를 다시 부를 필요는 없다 — 각 식당의
// lat/lng은 이미 DB에 있으니 로컬에서 거리만 재계산하면 된다.
//
// 실행: SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/recompute-walk-minutes.js

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다. 예: SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/recompute-walk-minutes.js");
  process.exit(1);
}

const SUPABASE_URL = "https://ubvpkldnsadyxnhirjzl.supabase.co";
const CAMPUS = { lat: 37.5849237, lng: 126.9967749 }; // 성균관대학교 정문

function estimateWalkMinutes(lat, lng) {
  const dLat = (lat - CAMPUS.lat) * 111320;
  const dLng = (lng - CAMPUS.lng) * 111320 * Math.cos((CAMPUS.lat * Math.PI) / 180);
  const distanceM = Math.sqrt(dLat * dLat + dLng * dLng);
  return Math.max(1, Math.round(distanceM / 80));
}

async function supabaseRequest(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase request failed (${res.status}): ${text}`);
  }
}

async function main() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/restaurants?select=id,name,lat,lng,walk_minutes&status=eq.approved`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
  );
  const restaurants = await res.json();

  console.log(`승인된 식당 ${restaurants.length}곳의 도보시간을 새 기준점으로 재계산합니다...`);

  let changed = 0;
  for (const r of restaurants) {
    const newWalkMinutes = estimateWalkMinutes(r.lat, r.lng);
    if (newWalkMinutes === r.walk_minutes) continue;
    await supabaseRequest(`restaurants?id=eq.${r.id}`, {
      method: "PATCH",
      body: JSON.stringify({ walk_minutes: newWalkMinutes })
    });
    console.log(`${r.name}: ${r.walk_minutes ?? "?"}분 → ${newWalkMinutes}분`);
    changed++;
  }

  console.log(`완료 — ${changed}곳의 도보시간을 갱신했습니다.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
