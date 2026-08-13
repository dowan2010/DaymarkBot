import { submitReflection } from './automation.js';
import 'dotenv/config';

const email = process.env.TEST_EMAIL;
const password = process.env.TEST_PASSWORD;

if (!email || !password) {
  console.error('❌ .env 파일에 TEST_EMAIL, TEST_PASSWORD를 설정해주세요.');
  process.exit(1);
}

const testText = `타입스크립트 학습을 통해 자바스크립트의 단점을 보완하고 코드의 안정성을 높이는 데 집중했다. 처음에는 타입 정의 개념이 낯설었지만, 인터페이스와 제네릭을 학습하며 코드의 가독성이 향상된다는 것을 확인했다. 타입 정의를 명확히 하지 않아 발생하는 오류를 직접 경험하며 타입스크립트의 필요성을 실감했다. 앞으로 고급 기능을 더 학습하고 실제 프로젝트에 적용할 것이다.`;

console.log('\n⏳ 뉴로우 자동 제출 테스트 중...\n');
console.log(`📝 제출할 내용:\n${testText}\n`);

try {
  await submitReflection(testText, email, password, '자바스크립트 학습');
  console.log('✅ 제출 완료!');
} catch (err) {
  console.error('❌ 오류:', err.message);
}
