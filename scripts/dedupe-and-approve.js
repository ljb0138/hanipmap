// collect-places.js는 insert 시점에 이미 승인된(approved) 식당과 중복이면 걸러내지만,
// pending 상태 행은 anon 키로 못 읽어서(RLS) 걸러낼 수 없다. 그래서 collect-places.js를
// 승인 사이에 여러 번 돌리면 pending끼리 서로 중복될 수 있다. 이 스크립트는 service-role
// 키로 pending까지 전부 읽어서:
//   1) 기존 승인 식당과 겹치는 pending -> 삭제
//   2) pending끼리 서로 겹치는 것 -> 하나만 남기고 삭제
//   3) 남은 것 -> approved로 승인
// kakao_id가 있으면 그것으로, 없으면(예전 데이터) 좌표 근접(25m 이내)으로 판별한다.
//
// 기본은 dry-run(무엇을 지우고/승인할지 출력만). 실제로 반영하려면 --apply를 붙인다.
//
// 실행: SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/dedupe-and-approve.js [--apply]

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다. 예: SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/dedupe-and-approve.js");
  process.exit(1);
}

const SUPABASE_URL = "https://ubvpkldnsadyxnhirjzl.supabase.co";
const apply = process.argv.includes("--apply");
const DUPLICATE_DISTANCE_M = 25;

function distanceM(a, b) {
  const dLat = (a.lat - b.lat) * 111320;
  const dLng = (a.lng - b.lng) * 111320 * Math.cos((b.lat * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

function sameRestaurant(a, b) {
  if (a.kakao_id && b.kakao_id) return a.kakao_id === b.kakao_id;
  if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return false;
  return distanceM(a, b) < DUPLICATE_DISTANCE_M;
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

async function main() {
  const approved = await supabaseRequest("restaurants?select=id,name,lat,lng,kakao_id&status=eq.approved");
  const pending = await supabaseRequest(
    "restaurants?select=id,name,lat,lng,kakao_id&status=eq.pending&submitted_by=eq.kakao-bulk-import"
  );

  if (pending.length === 0) {
    console.log("정리할 pending 카카오 수집 데이터가 없습니다.");
    return;
  }

  const dupOfApproved = [];
  const survivors = []; // pending끼리 중복 체크를 통과한 것들
  const dupOfPending = [];

  for (const row of pending) {
    if (approved.some((a) => sameRestaurant(row, a))) {
      dupOfApproved.push(row);
      continue;
    }
    const already = survivors.find((s) => sameRestaurant(row, s));
    if (already) {
      dupOfPending.push({ row, keptAs: already });
      continue;
    }
    survivors.push(row);
  }

  console.log(`신규 수집 pending: ${pending.length}곳`);
  console.log(`  - 기존 승인 식당과 겹쳐 중복(삭제 대상): ${dupOfApproved.length}곳`);
  dupOfApproved.forEach((r) => console.log(`      · [${r.id}] ${r.name}`));
  console.log(`  - pending끼리 서로 겹쳐 중복(삭제 대상): ${dupOfPending.length}곳`);
  dupOfPending.forEach(({ row, keptAs }) => console.log(`      · [${row.id}] ${row.name}  (→ [${keptAs.id}] ${keptAs.name}과 동일 판정, 그쪽을 남김)`));
  console.log(`  - 새로 승인할 곳: ${survivors.length}곳`);
  survivors.forEach((r) => console.log(`      · [${r.id}] ${r.name}`));

  if (!apply) {
    console.log("\n(dry-run) 위 목록을 확인한 뒤, 실제로 반영하려면 --apply 옵션을 붙여 다시 실행하세요.");
    return;
  }

  const toDelete = [...dupOfApproved, ...dupOfPending.map((d) => d.row)];
  if (toDelete.length) {
    const ids = toDelete.map((r) => r.id).join(",");
    await supabaseRequest(`restaurants?id=in.(${ids})`, { method: "DELETE" });
    console.log(`\n중복 ${toDelete.length}곳 삭제 완료.`);
  }

  if (survivors.length) {
    const ids = survivors.map((r) => r.id).join(",");
    await supabaseRequest(`restaurants?id=in.(${ids})`, {
      method: "PATCH",
      body: JSON.stringify({ status: "approved" })
    });
    console.log(`신규 ${survivors.length}곳 승인 완료.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
