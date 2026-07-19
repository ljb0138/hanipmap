// 정규식(parseBudget/parseWalkMax)이 아무것도 못 찾았을 때만 호출되는 폴백.
// Solar LLM으로 자유 문장에서 예산/도보시간/태그를 뽑아 구조화된 JSON으로 반환한다.
// 실패해도 항상 200 + 빈 결과로 응답해 기존 검색 결과가 그대로 유지되게 한다.

const KNOWN_TAGS = ["lonely", "budget10k", "walk5", "exam247", "hangover", "formal", "splurge"];

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  const { query } = req.body || {};
  if (!query || !query.trim()) {
    res.status(200).json({ budget: null, walkMax: null, tags: [] });
    return;
  }

  const upstageKey = process.env.UPSTAGE_API_KEY;

  const prompt = `다음 한국어 문장에서 예산(원 단위 숫자), 도보 최대 시간(분), 상황 태그를 추출해줘.
태그는 이 목록 중에서만 골라야 해:
- lonely: 혼밥
- budget10k: 1만원 이하 저렴한 식사
- walk5: 도보 5분 이내 가까운 곳
- exam247: 시험기간 24시간 영업
- hangover: 해장, 얼큰한 국물
- formal: 교수님과 격식있는 식사
- splurge: 선배가 사주는 비싼 회식

반드시 아래 JSON 형식으로만 답해. 다른 설명은 붙이지 마.
{"budget": 숫자또는null, "walkMax": 숫자또는null, "tags": ["태그"]}

문장: "${query}"`;

  try {
    const solarRes = await fetch("https://api.upstage.ai/v1/solar/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${upstageKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "solar-pro", messages: [{ role: "user", content: prompt }] })
    });
    if (!solarRes.ok) {
      res.status(200).json({ budget: null, walkMax: null, tags: [] });
      return;
    }

    const data = await solarRes.json();
    const content = (data.choices && data.choices[0] && data.choices[0].message.content) || "{}";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);

    const budget = Number.isFinite(parsed.budget) && parsed.budget > 0 && parsed.budget <= 200000 ? parsed.budget : null;
    const walkMax = Number.isFinite(parsed.walkMax) && parsed.walkMax > 0 && parsed.walkMax <= 60 ? parsed.walkMax : null;
    const tags = Array.isArray(parsed.tags) ? parsed.tags.filter((tag) => KNOWN_TAGS.includes(tag)) : [];

    res.status(200).json({ budget, walkMax, tags });
  } catch {
    res.status(200).json({ budget: null, walkMax: null, tags: [] });
  }
};
