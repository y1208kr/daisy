require('dotenv').config();
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const port = process.env.PORT || 3000;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.use(express.json());
app.use(express.static('.'));

function getModel() {
  return genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: { temperature: 0.4 }
  });
}

// AI 응답에서 마크다운 코드 블록(```json ... ```) 제거
function extractJson(text) {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  return text.trim();
}

// 사용자가 붙여넣은 텍스트를 분석하여 트렌드 추출
app.post('/analyze-text', async (req, res) => {
  const { rawText, clientData } = req.body;

  if (!rawText || rawText.trim().length < 20) {
    return res.status(400).json({ error: '분석할 텍스트를 입력해주세요 (최소 20자 이상).' });
  }
  if (!clientData || !clientData.clientName) {
    return res.status(400).json({ error: '거래처 정보가 필요합니다.' });
  }

  try {
    const model = getModel();
    const prompt = `당신은 대상(주) 영업사원을 돕는 AI 세일즈 어시스턴트입니다.
아래 [참고 텍스트]를 읽고, 거래처 영업 상담에 활용할 수 있는 핵심 트렌드·인사이트 3~5개를 추출하세요.

[거래처 정보]
- 거래처명: ${clientData.clientName}
- 업종: ${clientData.industry}
- 채널: ${clientData.channel}
- 담당자 관심사: ${clientData.interests || '없음'}

[참고 텍스트]
${rawText.substring(0, 4000)}

[출력 규칙]
- 텍스트에서 근거 있는 내용만 사용 (없는 내용 지어내지 말 것)
- 각 트렌드는 한 문장(20~40자)으로 간결하게 작성
- 거래처 업종·채널과 연관성이 높은 것을 우선 선별
- 반드시 번호 목록(1. 2. 3. ...) 형식만 출력하고 다른 설명은 쓰지 말 것`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    let trendLines = text
      .split('\n')
      .filter(t => /^\d+[.。)]\s*\S/.test(t.trim()))
      .map(t => t.replace(/^\d+[.。)]\s*/, '').trim())
      .filter(t => t.length > 0);

    if (trendLines.length === 0) {
      trendLines = text
        .split('\n')
        .map(t => t.replace(/^[-•*]\s*/, '').trim())
        .filter(t => t.length > 5)
        .slice(0, 5);
    }

    res.json({ trends: trendLines });
  } catch (error) {
    console.error('Analyze error:', error);
    res.status(500).json({ error: 'AI 분석에 실패했습니다.' });
  }
});

app.post('/generate-materials', async (req, res) => {
  const { trends, clientData, customPrompt } = req.body;

  if (!trends || !Array.isArray(trends) || trends.length === 0) {
    return res.status(400).json({ error: '트렌드를 1개 이상 선택해주세요.' });
  }
  if (!clientData || !clientData.clientName) {
    return res.status(400).json({ error: '거래처 정보가 필요합니다.' });
  }

  try {
    const model = getModel();
    const customInstruction = customPrompt ? `\n추가 지시사항: ${customPrompt}` : '';

    const prompt = `당신은 대상(주) 영업사원을 돕는 AI 세일즈 어시스턴트입니다.
아래 거래처 정보와 선택된 트렌드를 바탕으로 실제 영업 방문 시 바로 활용할 수 있는 상담 소재 2~3개를 생성하세요.

거래처 정보:
- 거래처명: ${clientData.clientName}
- 업종: ${clientData.industry}
- 채널: ${clientData.channel}
- 담당자 관심사: ${clientData.interests || '없음'}

선택된 트렌드:
${trends.map((t, i) => `${i + 1}. ${t}`).join('\n')}
${customInstruction}

각 소재는 다음 3가지 요소를 포함하여 JSON 배열로 출력하세요:
- opening: 상담 시작 시 자연스럽게 꺼낼 수 있는 오프닝 한 마디 (1~2문장)
- empathy: 거래처 담당자 입장에서 공감할 수 있는 포인트 (1~2문장)
- connection: 대상(주) 제품(청정원, 해찬들, 종가 등)과의 연결 포인트 (1~2문장)

출처가 없는 사실은 추측임을 명시하고, 반드시 JSON 배열만 출력하세요:
[{"opening":"...", "empathy":"...", "connection":"..."}]`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    let materials;
    try {
      materials = JSON.parse(extractJson(text));
      if (!Array.isArray(materials)) throw new Error('Not an array');
    } catch {
      materials = trends.slice(0, 3).map((trend) => ({
        opening: `"요즘 ${trend} 관련해서 업계 분위기가 많이 바뀌고 있더라고요. 혹시 영향 받으시는 부분 있으세요?"`,
        empathy: `${clientData.channel} 입장에서 ${trend} 흐름에 선제적으로 대응하는 것이 중요한 시점이죠.`,
        connection: `대상 청정원 신제품 라인이 이 트렌드에 잘 맞아서, 한번 소개드리면 어떨까 싶습니다.`
      }));
    }

    res.json({ materials });
  } catch (error) {
    console.error('Materials error:', error);
    res.status(500).json({ error: 'AI 소재 생성에 실패했습니다.' });
  }
});

app.listen(port, () => {
  console.log(`DAISY 서버 실행 중: http://localhost:${port}`);
});
