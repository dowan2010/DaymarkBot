import { GoogleGenerativeAI } from '@google/generative-ai';
import 'dotenv/config';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemma-3-27b-it' });

import readline from 'readline';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const topic = await new Promise((resolve) => rl.question('📝 주제 입력: ', (ans) => { rl.close(); resolve(ans); }));

console.log(`🔍 API 키: ${process.env.GEMINI_API_KEY?.slice(0, 8)}...`);
console.log('⏳ 회고 생성 중...\n');

const prompt = `당신은 대구 소프트웨어 마이스터고등학교 학생의 일상 회고를 작성하는 어시스턴트입니다.

다음 주제를 바탕으로 자유형 회고를 작성해주세요.

주제: ${topic}

작성 형식 예시:
"자바 객체 지향 학습을 통해 자바의 깊은 이해를 목표로 삼았으며, 어려움을 겪으면서도 더 깊이 이해하려는 동기부여를 얻었다. 비록 아쉬움이 남지만, 이는 앞으로의 학습에 긍정적인 원동력이 될 것이다. 시각적 자료를 활용한 객체 지향 이해가 유익했으며, 이를 지속적으로 활용할 계획이다. 어려움을 극복하기 위해 온라인 자료나 도구를 활용하고, 알고리즘적 사고로 코드를 분석하며 그림을 그리는 방법을 통해 코드의 흐름을 명확히 이해하고자 한다."

요구사항:
- 반드시 200자 이상
- 오직 한국어만 사용할 것, 다른 언어 절대 사용 금지
- 위 예시처럼 담담하고 객관적인 회고 문체로 작성
- 과거형 종결어미("~했다", "~였다", "~이다", "~할 것이다")로 끝낼 것
- 대구 소프트웨어 마이스터고등학교 학생의 시점으로 작성
- 경험 → 느낀 점 → 앞으로의 계획 흐름으로 작성
- 회고 본문만 출력 (제목, 설명 없이)
- 감정적이거나 오글거리는 표현 금지`;

try {
  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  console.log('✅ 생성 완료!\n');
  console.log(text);
  console.log(`\n📊 글자 수: ${text.length}자`);
} catch (err) {
  console.error('❌ 오류:', err.message);
}
