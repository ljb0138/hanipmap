// 자유 문장을 Upstage Solar Embedding으로 벡터화해, DB의 match_restaurants() 함수로
// 의미가 가까운 식당 id를 유사도 순으로 반환한다. 실패해도 항상 200 + 빈 배열로
// 응답해 프론트가 기존(거리순) 정렬을 그대로 유지하도록 한다.

const SUPABASE_URL = "https://ubvpkldnsadyxnhirjzl.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_bYQBH_FnrYBanG9YufSkBQ_0qPY0nG1";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  const { query } = req.body || {};
  if (!query || !query.trim()) {
    res.status(200).json({ ids: [] });
    return;
  }

  const upstageKey = process.env.UPSTAGE_API_KEY;

  try {
    const embedRes = await fetch("https://api.upstage.ai/v1/solar/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${upstageKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "solar-embedding-1-large-query", input: query })
    });
    if (!embedRes.ok) {
      res.status(200).json({ ids: [] });
      return;
    }
    const embedData = await embedRes.json();
    const queryEmbedding = embedData.data && embedData.data[0] && embedData.data[0].embedding;
    if (!queryEmbedding) {
      res.status(200).json({ ids: [] });
      return;
    }

    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_restaurants`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query_embedding: queryEmbedding, match_count: 40 })
    });
    if (!rpcRes.ok) {
      res.status(200).json({ ids: [] });
      return;
    }
    const matches = await rpcRes.json();
    const ids = Array.isArray(matches) ? matches.map((m) => m.id) : [];

    res.status(200).json({ ids });
  } catch {
    res.status(200).json({ ids: [] });
  }
};
