// 제보 폼에서 "이미 등록된 식당"으로 인식돼 target_restaurant_id가 채워진 채 저장된
// 메뉴 업데이트 제안들을 정리하는 스크립트.
//
// 흐름:
//   1) 운영자가 Supabase Table Editor에서 pending 상태인 제안들을 훑어보고,
//      스팸/장난이 아닌 것들만 status='approved'로 바꿔둔다 (기존 승인 절차와 동일).
//   2) 이 스크립트를 실행하면, target_restaurant_id가 있고 status='approved'인 제안들을
//      대상 식당별로 묶어서 "메뉴 항목이 가장 많은(가장 포괄적인) 제안"을 골라
//      대상 식당의 menu/menu_photo_url에 반영(덮어쓰기)하고, 그 그룹의 제안 행들은 삭제한다.
//      (메뉴는 이미 대상 식당에 반영됐으므로 별도 리스팅으로 남겨둘 필요가 없음)
//
// 실행: SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/apply-menu-updates.js
// (SUPABASE_SERVICE_ROLE_KEY는 절대 코드에 하드코딩하지 않는다 — anon 키와 달리
//  RLS를 무시하고 DB를 전부 읽고 쓸 수 있는 키이므로 각별히 주의)

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다. 예: SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/apply-menu-updates.js");
  process.exit(1);
}

const SUPABASE_URL = "https://ubvpkldnsadyxnhirjzl.supabase.co";

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
  const proposals = await supabaseRequest(
    "restaurants?select=id,menu,menu_photo_url,target_restaurant_id&status=eq.approved&target_restaurant_id=not.is.null"
  );

  if (proposals.length === 0) {
    console.log("반영할 메뉴 업데이트 제안이 없습니다.");
    return;
  }

  const byTarget = new Map();
  for (const proposal of proposals) {
    const list = byTarget.get(proposal.target_restaurant_id) || [];
    list.push(proposal);
    byTarget.set(proposal.target_restaurant_id, list);
  }

  for (const [targetId, group] of byTarget) {
    const winner = group.reduce((best, cur) =>
      (cur.menu || []).length > (best.menu || []).length ? cur : best
    );

    await supabaseRequest(`restaurants?id=eq.${targetId}`, {
      method: "PATCH",
      body: JSON.stringify({
        menu: winner.menu,
        menu_photo_url: winner.menu_photo_url
      })
    });
    console.log(`식당 #${targetId}: 메뉴 ${(winner.menu || []).length}개 항목으로 반영 (제안 ${group.length}건 중 채택)`);

    const idsToDelete = group.map((p) => p.id).join(",");
    await supabaseRequest(`restaurants?id=in.(${idsToDelete})`, { method: "DELETE" });
  }

  console.log(`완료 — 식당 ${byTarget.size}곳에 메뉴 업데이트를 반영했습니다.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
