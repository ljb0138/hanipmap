module.exports = async (req, res) => {
  const query = req.query.query;
  if (!query) {
    res.status(400).json({ error: "query is required" });
    return;
  }

  const clientId = process.env.NAVER_SEARCH_CLIENT_ID;
  const clientSecret = process.env.NAVER_SEARCH_CLIENT_SECRET;

  const url = `https://openapi.naver.com/v1/search/local.json?query=${encodeURIComponent(query)}&display=1`;

  try {
    const naverRes = await fetch(url, {
      headers: {
        "X-Naver-Client-Id": clientId,
        "X-Naver-Client-Secret": clientSecret
      }
    });
    const data = await naverRes.json();
    res.status(naverRes.status).json(data);
  } catch (err) {
    res.status(500).json({ error: "search failed" });
  }
};
