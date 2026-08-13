const MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-3.5-flash'];

let flashRateLimited = false;
let flashRateLimitTimer = null;

export function extractTopic(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return text.trim();
  return lines[lines.length - 1].replace(/^["'`*#]+|["'`*#]+$/g, '').trim();
}

export function extractReflection(text) {
  const filtered = text.split('\n').filter(line => !/^\s*[*#\-]/.test(line)).join('\n');
  const blocks = filtered.split(/\n{2,}/).map(b => b.trim()).filter(b => {
    const korean = (b.match(/[가-힣]/g) || []).length;
    return korean / Math.max(b.length, 1) > 0.3 && b.length > 80;
  });
  if (!blocks.length) return text.trim();
  let result = blocks[blocks.length - 1].replace(/\n/g, ' ').trim();
  if (result.length > 200) {
    const anchor = result.slice(0, 40);
    const dupIdx = result.indexOf(anchor, anchor.length);
    if (dupIdx > 0) result = result.slice(dupIdx).trim();
  }
  return result;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('AI 응답 시간 초과')), ms)),
  ]);
}

async function geminiGenerate(modelName, prompt, timeoutMs) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
  const data = await withTimeout(
    fetch(url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': process.env.GEMINI_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
    }).then(res => res.json().then(d => ({ ok: res.ok, status: res.status, data: d }))),
    timeoutMs,
  );
  if (!data.ok) {
    const msg = data.data?.error?.message ?? `HTTP ${data.status}`;
    const err = new Error(msg);
    err.status = data.status;
    throw err;
  }
  const parts = data.data?.candidates?.[0]?.content?.parts ?? [];
  const text = [...parts].reverse().find(p => !p.thought)?.text;
  if (!text) throw new Error('빈 응답');
  return { response: { text: () => text } };
}

export async function generateWithRetry(prompt, timeoutMs, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const modelName = i === retries - 1 ? MODELS[2] : (flashRateLimited ? MODELS[1] : MODELS[0]);
    try {
      return await geminiGenerate(modelName, prompt, timeoutMs);
    } catch (err) {
      const is429 = err.status === 429 || err.message?.includes('429') || err.message?.includes('RESOURCE_EXHAUSTED') || err.message?.includes('quota');
      if (is429 && !flashRateLimited) {
        console.log(`[AI] 429 감지 — ${MODELS[1]}로 전환 (10분)`);
        flashRateLimited = true;
        clearTimeout(flashRateLimitTimer);
        flashRateLimitTimer = setTimeout(() => {
          flashRateLimited = false;
          console.log('[AI] 복구 — 메인 모델로 복귀');
        }, 10 * 60 * 1000);
        if (i < retries - 1) continue;
        throw err;
      }
      const isRetryable = err.status === 500 || err.status === 503 || err.message?.includes('Internal error');
      if (!isRetryable || i === retries - 1) throw err;
      await new Promise(res => setTimeout(res, 2000 * (i + 1)));
    }
  }
}

export async function generateTopicFromKeywords(keywords, recentTopics = []) {
  const avoidStr = recentTopics.length > 0
    ? `\n- 다음 주제들과 겹치지 않게: ${recentTopics.slice(0, 5).join(', ')}`
    : '';
  const result = await generateWithRetry(
    `다음 키워드를 기반으로 개발 학습 회고에 쓸 구체적인 주제 1개만 추천해줘.\n` +
    `- 키워드: ${keywords.join(', ')}\n` +
    `- 키워드들을 조합하거나 하나를 골라 25자 이내의 구체적인 주제를 만들 것\n` +
    `- 한국어만, 주제만 출력 (설명 없이)` +
    avoidStr,
    20_000,
  );
  return extractTopic(result.response.text());
}

export async function generateTopic(recentTopics = []) {
  const areas = ['Java', 'JavaScript', 'Python', 'HTML/CSS', 'SQL', 'Git', '알고리즘', 'TypeScript', 'Spring', 'React', 'Node.js', 'Linux'];
  const area = areas[Math.floor(Math.random() * areas.length)];
  const seed = Math.floor(Math.random() * 99999);
  const avoidStr = recentTopics.length > 0
    ? `\n- 다음 주제들과 겹치지 않게: ${recentTopics.slice(0, 5).join(', ')}`
    : '';
  const result = await generateWithRetry(
    `개발을 막 배우기 시작한 고등학생의 전공 학습을 주제로 뉴로우 회고에 쓸 만한 구체적인 주제 1개만 추천해줘.\n` +
    `- 오늘 분야: ${area} (변형 코드: ${seed})\n` +
    `- 난이도: 기본~중급 수준\n` +
    `- 반드시 특정 기술/개념을 포함할 것 (예: 자바 클래스와 객체 생성, JavaScript 배열 메서드)\n` +
    `- 25자 이내, 한국어만, 주제만 출력 (설명 없이)` +
    avoidStr,
    20_000,
  );
  return extractTopic(result.response.text());
}

export async function generateReflection(topic) {
  const result = await generateWithRetry(
    `당신은 대구 소프트웨어 마이스터고등학교 학생의 일상 회고를 작성하는 어시스턴트입니다.\n\n` +
    `다음 주제를 바탕으로 자유형 회고를 작성해주세요.\n\n주제: ${topic}\n\n` +
    `작성 형식 예시:\n"자바 객체 지향 학습을 통해 자바의 깊은 이해를 목표로 삼았으며, 어려움을 겪으면서도 더 깊이 이해하려는 동기부여를 얻었다. 비록 아쉬움이 남지만, 이는 앞으로의 학습에 긍정적인 원동력이 될 것이다. 시각적 자료를 활용한 객체 지향 이해가 유익했으며, 이를 지속적으로 활용할 계획이다. 어려움을 극복하기 위해 온라인 자료나 도구를 활용하고, 알고리즘적 사고로 코드를 분석하며 그림을 그리는 방법을 통해 코드의 흐름을 명확히 이해하고자 한다."\n\n` +
    `요구사항:\n- 반드시 200자 이상\n- 오직 한국어만 사용할 것, 다른 언어 절대 사용 금지\n` +
    `- 위 예시처럼 담담하고 객관적인 회고 문체로 작성\n` +
    `- 과거형 종결어미("~했다", "~였다", "~이다", "~할 것이다")로 끝낼 것\n` +
    `- 대구 소프트웨어 마이스터고등학교 학생의 시점으로 작성\n` +
    `- 경험 → 느낀 점 → 앞으로의 계획 흐름으로 작성\n` +
    `- 회고 본문만 출력 (제목, 설명 없이)\n- 감정적이거나 오글거리는 표현 금지`,
    45_000,
  );
  return extractReflection(result.response.text());
}

export async function generateThankMessage(topic, reflection, thankType, thankName) {
  const target = thankName || (thankType === '자신' ? '나 자신' : thankType);
  const result = await generateWithRetry(
    `다음 개발 학습 회고를 읽고, ${target}에게 보내는 진심 어린 감사 메시지 1문장을 써줘.\n` +
    `- 회고 주제: ${topic}\n- 회고 내용 요약: ${reflection.slice(0, 200)}\n` +
    `- 30자 이내, 한국어만, 메시지만 출력`,
    20_000,
  );
  return result.response.text().trim();
}
