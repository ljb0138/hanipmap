// 승인된 식당 중 embedding이 아직 없는(또는 --all 옵션 시 전체) 곳을 대상으로,
// "이름 + 메뉴 + 한줄설명 + 태그"를 합친 텍스트를 Upstage Solar Embedding으로 벡터화해
// embedding 컬럼에 채운다. 메뉴/설명이 갱신될 때마다(예: apply-menu-updates.js 실행 후)
// 다시 돌려서 최신 상태로 유지해야 한다.
//
// 식당 하나 처리할 때마다 바로 저장하므로, 중간에 Ctrl+C로 멈춰도 이미 처리된 곳은
// 안전하게 남고, 다시 실행하면 embedding이 비어있는(아직 처리 안 된) 곳만 이어서
// 처리한다. 동시 요청(기본 5개)으로 처리해 대량 백필 시간을 줄인다.
//
// 실행: SUPABASE_SERVICE_ROLE_KEY=xxxx UPSTAGE_API_KEY=xxxx node scripts/embed-restaurants.js [--all]

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const UPSTAGE_KEY = process.env.UPSTAGE_API_KEY;
if (!SERVICE_KEY || !UPSTAGE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY, UPSTAGE_API_KEY 환경변수가 모두 필요합니다.");
  console.error("예: SUPABASE_SERVICE_ROLE_KEY=xxxx UPSTAGE_API_KEY=xxxx node scripts/embed-restaurants.js");
  process.exit(1);
}

const SUPABASE_URL = "https://ubvpkldnsadyxnhirjzl.supabase.co";
const reembedAll = process.argv.includes("--all");
const CONCURRENCY = 5;
const MAX_RETRIES = 2;

function buildEmbeddingText(r) {
  const menuText = (r.menu || []).map((item) => item.name).join(", ");
  return [r.name, menuText, r.base_reason, (r.tags || []).join(", ")].filter(Boolean).join(" · ");
}

async function embedRaw(text) {
  const res = await fetch("https://api.upstage.ai/v1/solar/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTAGE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "solar-embedding-1-large-passage", input: text })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`embeddings API failed (${res.status}): ${errText}`);
  }
  const data = await res.json();
  return data.data[0].embedding;
}

async function embed(text) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await embedRaw(text);
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
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

async function main() {
  const filter = reembedAll ? "" : "&embedding=is.null";
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/restaurants?select=id,name,menu,base_reason,tags&status=eq.approved${filter}`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
  );
  const restaurants = await res.json();

  if (!Array.isArray(restaurants)) {
    console.error("식당 목록을 불러오지 못했습니다:", restaurants);
    process.exit(1);
  }

  console.log(`${restaurants.length}곳의 임베딩을 동시 ${CONCURRENCY}개씩 계산합니다...`);

  let done = 0, failed = 0;

  await mapWithConcurrency(restaurants, CONCURRENCY, async (r) => {
    const text = buildEmbeddingText(r);
    if (!text) {
      console.log(`${r.name}: 임베딩할 텍스트가 없어 건너뜀`);
      return;
    }
    try {
      const embedding = await embed(text);
      const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/restaurants?id=eq.${r.id}`, {
        method: "PATCH",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({ embedding })
      });
      if (!patchRes.ok) {
        console.error(`${r.name}: 저장 실패 (${patchRes.status})`, await patchRes.text());
        failed++;
        return;
      }
      done++;
      console.log(`[${done}/${restaurants.length}] ${r.name}: 완료`);
    } catch (err) {
      console.error(`${r.name}: 임베딩 실패 — ${err.message}`);
      failed++;
    }
  });

  console.log(`모든 식당의 임베딩 계산을 마쳤습니다. (완료 ${done}곳, 실패 ${failed}곳)`);
  if (failed > 0) console.log("실패한 곳은 다시 이 스크립트를 실행하면 자동으로 재시도됩니다.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
