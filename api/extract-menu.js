// 메뉴판 사진(Storage에 업로드된 파일)을 Upstage Document AI(OCR)로 읽고,
// Solar LLM으로 {name, price} 배열로 정리해 반환한다.
// 실패해도 항상 200 + {menu:[]}로 응답해 제보 폼이 수동 입력으로 자연스럽게 이어지도록 한다.

const SUPABASE_URL = "https://ubvpkldnsadyxnhirjzl.supabase.co";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  const { imagePath } = req.body || {};
  if (!imagePath) {
    res.status(400).json({ error: "imagePath is required" });
    return;
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const upstageKey = process.env.UPSTAGE_API_KEY;

  try {
    const fileRes = await fetch(`${SUPABASE_URL}/storage/v1/object/menu-photos/${imagePath}`, {
      headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey }
    });
    if (!fileRes.ok) {
      res.status(200).json({ menu: [], error: "이미지를 불러오지 못했어요." });
      return;
    }
    const imageBlob = await fileRes.blob();

    const ocrForm = new FormData();
    ocrForm.append("document", imageBlob, "menu.jpg");
    ocrForm.append("model", "document-parse");
    ocrForm.append("ocr", "force");

    const ocrRes = await fetch("https://api.upstage.ai/v1/document-digitization", {
      method: "POST",
      headers: { Authorization: `Bearer ${upstageKey}` },
      body: ocrForm
    });
    if (!ocrRes.ok) {
      res.status(200).json({ menu: [], error: "메뉴판 인식에 실패했어요. 직접 입력해주세요." });
      return;
    }
    const ocrData = await ocrRes.json();
    const rawText = (ocrData && ocrData.content && ocrData.content.text) || "";
    if (!rawText.trim()) {
      res.status(200).json({ menu: [], rawText: "", error: "글자를 읽지 못했어요. 직접 입력해주세요.", debugOcrData: ocrData });
      return;
    }

    const structurePrompt = `다음은 메뉴판을 OCR로 읽은 텍스트야. 메뉴명과 가격(숫자만, 원 단위)을 추출해서 JSON 배열로만 답해.
형식: [{"name":"메뉴명","price":숫자}]
가격을 알 수 없는 항목은 제외해. 다른 설명 없이 JSON 배열만 출력해.

${rawText}`;

    const solarRes = await fetch("https://api.upstage.ai/v1/solar/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${upstageKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "solar-pro", messages: [{ role: "user", content: structurePrompt }] })
    });
    if (!solarRes.ok) {
      res.status(200).json({ menu: [], rawText, error: "메뉴 정리에 실패했어요. 직접 입력해주세요." });
      return;
    }
    const solarData = await solarRes.json();
    const content = (solarData.choices && solarData.choices[0] && solarData.choices[0].message.content) || "[]";
    const jsonMatch = content.match(/\[[\s\S]*\]/);

    let menu = [];
    try {
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
      if (Array.isArray(parsed)) {
        menu = parsed
          .filter((item) => item && typeof item.name === "string" && item.name.trim() && Number(item.price) > 0)
          .map((item) => ({ name: item.name.trim().slice(0, 40), price: Number(item.price) }))
          .slice(0, 30);
      }
    } catch {
      menu = [];
    }

    res.status(200).json({ menu, rawText });
  } catch (err) {
    res.status(200).json({ menu: [], error: "처리 중 오류가 발생했어요. 직접 입력해주세요." });
  }
};
