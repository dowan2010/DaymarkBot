import 'dotenv/config';

const res = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`
);
const data = await res.json();

console.log('사용 가능한 모델 목록:\n');
for (const model of data.models ?? []) {
  if (model.supportedGenerationMethods?.includes('generateContent')) {
    console.log(`✅ ${model.name}`);
  }
}
