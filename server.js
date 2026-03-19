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

function extractJson(text) {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  return text.trim();
}

// ──────────────────────────────────────────────────────────────
//  [NEW] 자동 트렌드 수집
// ──────────────────────────────────────────────────────────────
app.post('/search-trends', async (req, res) => {
  const { clientData } = req.body;
  if (!clientData?.clientName) {
    return res.status(400).json({ error: '거래처 정보가 필요합니다.' });
  }

  const buildPrompt = (withSearch) =>
    `당신은 한국 식품·유통 업계 전문 애널리스트입니다.${withSearch ? ' 최신 뉴스와 보고서를 검색하여' : ''}
${clientData.clientName}(${clientData.industry} 업종, ${clientData.channel} 채널) 거래처 영업에 활용할 수 있는 최신 시장 트렌드 5개를 수집하세요.

수집 기준 (우선순위 순):
1. 고객사 업종(${clientData.industry})·채널(${clientData.channel})과의 키워드 연관성
2. 2025~2026년 최신성 (최근 날짜 우선)
3. 조회수·영향도 높은 주요 이슈
4. 출처: 빅카인즈 뉴스, 식품의약품안전처, 한국농수산식품유통공사(aT), KATI 식품산업통계

반드시 아래 JSON 배열 형식으로만 출력하세요 (5개):
[
  {
    "title": "트렌드 제목 (20~40자, 한국어)",
    "summary": "한 줄 요약 (30~50자)",
    "source": "출처 사이트명",
    "date": "YYYY.MM",
    "relevance": 90,
    "url": "해당 기사·보고서의 실제 URL (없으면 출처 사이트 홈페이지 URL)"
  }
]`;

  const tryParse = (text) => {
    try {
      const json = JSON.parse(extractJson(text));
      return Array.isArray(json) && json.length > 0 ? json.slice(0, 5) : null;
    } catch { return null; }
  };

  // 1차: Google Search 그라운딩 시도
  try {
    const searchModel = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      tools: [{ googleSearch: {} }],
      generationConfig: { temperature: 0.2 }
    });
    const result = await searchModel.generateContent(buildPrompt(true));
    const trends = tryParse(result.response.text());
    if (trends) {
      // 그라운딩 메타데이터에서 실제 URL 추출해 보완
      const chunks = result.response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
      chunks.forEach((chunk, idx) => {
        if (chunk.web?.uri && trends[idx] && !trends[idx].url) {
          trends[idx].url = chunk.web.uri;
        }
      });
      return res.json({ trends, method: 'search' });
    }
    throw new Error('파싱 실패');
  } catch {
    // 2차: 일반 AI 폴백
    try {
      const result = await getModel().generateContent(buildPrompt(false));
      const trends = tryParse(result.response.text());
      if (trends) return res.json({ trends, method: 'ai' });
      throw new Error('파싱 실패');
    } catch (e2) {
      console.error('search-trends error:', e2);
      return res.status(500).json({ error: 'AI 트렌드 수집에 실패했습니다.' });
    }
  }
});

// ──────────────────────────────────────────────────────────────
//  [NEW] 트렌드 핵심 3줄 요약
// ──────────────────────────────────────────────────────────────
app.post('/summarize-trend', async (req, res) => {
  const { trendTitle, trendSummary, clientData } = req.body;
  if (!trendTitle || !clientData) {
    return res.status(400).json({ error: '파라미터 누락' });
  }

  try {
    const prompt = `당신은 대상(주) 영업 전문가입니다.
아래 시장 트렌드를 ${clientData.clientName}(${clientData.industry}, ${clientData.channel}) 거래처 영업에 활용할 수 있도록
핵심 포인트 정확히 3줄로 요약하세요.

트렌드: ${trendTitle}
${trendSummary ? `설명: ${trendSummary}` : ''}

출력 규칙:
- 정확히 3개 항목만 출력
- 각 항목은 30~50자 한 문장
- "• " 기호로 시작
- 시장 데이터·소비자 변화·제품 연결점 중심의 영업 인사이트
- 다른 설명 없이 3줄만 출력`;

    const result = await getModel().generateContent(prompt);
    const lines = result.response.text()
      .split('\n')
      .map(l => l.replace(/^[•\-*·\d.]\s*/, '').trim())
      .filter(l => l.length > 5)
      .slice(0, 3);

    res.json({ summary: lines });
  } catch (e) {
    console.error('summarize-trend error:', e);
    res.status(500).json({ error: '요약 생성 실패' });
  }
});

// ──────────────────────────────────────────────────────────────
//  [NEW] 고객 접근 메시지 & 가치제안 메시지
// ──────────────────────────────────────────────────────────────
app.post('/generate-messages', async (req, res) => {
  const { selectedTrends, clientData } = req.body;
  if (!selectedTrends?.length || !clientData?.clientName) {
    return res.status(400).json({ error: '파라미터 누락' });
  }

  try {
    const prompt = `당신은 대상(주) 영업 전문가입니다.
아래 거래처 정보와 트렌드를 바탕으로 실제 영업 방문 시 즉시 활용할 수 있는 두 가지 메시지를 만들어주세요.

거래처: ${clientData.clientName} (${clientData.industry} / ${clientData.channel})
담당자 관심사: ${clientData.interests || '없음'}
활용 트렌드:
${selectedTrends.map((t, i) => `${i + 1}. ${t}`).join('\n')}

반드시 아래 JSON 형식으로만 출력하세요:
{
  "approachMessage": "고객 접근 메시지(4~5문장): 방문 시 트렌드를 자연스럽게 언급하며 대화를 여는 멘트. 담당자 입장에 공감하고 신뢰를 쌓는 내용. 너무 영업적이지 않고 자연스럽게.",
  "valueMessage": "가치제안 메시지(4~5문장): 대상(주) 청정원·해찬들·종가 제품이 이 트렌드에서 어떤 구체적 비즈니스 가치를 제공하는지. 매출·수익 기회를 구체적으로 포함."
}`;

    const result = await getModel().generateContent(prompt);
    const messages = JSON.parse(extractJson(result.response.text()));
    if (!messages.approachMessage || !messages.valueMessage) throw new Error('파싱 실패');
    res.json(messages);
  } catch (e) {
    console.error('generate-messages error:', e);
    res.status(500).json({ error: '메시지 생성 실패' });
  }
});

// ──────────────────────────────────────────────────────────────
//  텍스트 분석 트렌드 추출
// ──────────────────────────────────────────────────────────────
app.post('/analyze-text', async (req, res) => {
  const { rawText, clientData } = req.body;

  if (!rawText || rawText.trim().length < 20) {
    return res.status(400).json({ error: '분석할 텍스트를 입력해주세요 (최소 20자 이상).' });
  }
  if (!clientData || !clientData.clientName) {
    return res.status(400).json({ error: '거래처 정보가 필요합니다.' });
  }

  try {
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

    const result = await getModel().generateContent(prompt);
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

// ──────────────────────────────────────────────────────────────
//  상담 소재 생성
// ──────────────────────────────────────────────────────────────
app.post('/generate-materials', async (req, res) => {
  const { trends, clientData, customPrompt } = req.body;

  if (!trends || !Array.isArray(trends) || trends.length === 0) {
    return res.status(400).json({ error: '트렌드를 1개 이상 선택해주세요.' });
  }
  if (!clientData || !clientData.clientName) {
    return res.status(400).json({ error: '거래처 정보가 필요합니다.' });
  }

  try {
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

    const result = await getModel().generateContent(prompt);
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
