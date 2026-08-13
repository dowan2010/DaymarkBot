// Daymark CLI — 뉴로우 회고 자동화 (Discord 없이 터미널에서 직접 실행)
// 실행: node cli.js
// .env 필요: GEMINI_API_KEY, EMAIL, PASSWORD
import 'dotenv/config';
import { createInterface } from 'readline/promises';
import { submitReflection, resetReflection, getTasksWithToken, browserCreateTask, browserCreateSchedule } from './automation.js';
import { addSubmissionHistory, removeSubmissionHistory, addRecentTopic, getRecentTopics } from './lib/data.js';
import { generateTopic, generateReflection, generateWithRetry } from './lib/ai.js';

const EMAIL = process.env.EMAIL || process.env.TEST_EMAIL;
const PASSWORD = process.env.PASSWORD || process.env.TEST_PASSWORD;

function requireEnv() {
  const missing = [];
  if (!process.env.GEMINI_API_KEY) missing.push('GEMINI_API_KEY');
  if (!EMAIL) missing.push('EMAIL');
  if (!PASSWORD) missing.push('PASSWORD');
  if (missing.length) {
    console.error(`❌ .env에 다음 값이 없음: ${missing.join(', ')}`);
    process.exit(1);
  }
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => rl.question(q);

function todayKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().split('T')[0];
}

async function doReflect() {
  const dateInput = (await ask('날짜 (엔터=오늘, YYYY-MM-DD): ')).trim();
  const date = dateInput || null;

  const topicInput = (await ask('주제 (엔터=AI 자동 추천): ')).trim();
  const topic = topicInput || await generateTopic(getRecentTopics());
  console.log(`📌 주제: ${topic}`);

  const textInput = (await ask('내용 (엔터=AI 자동 작성): ')).trim();
  const text = textInput || await generateReflection(topic);
  console.log(`📝 내용: ${text.slice(0, 80)}...\n`);

  const result = await submitReflection(
    text, EMAIL, PASSWORD, topic, date,
    async (step) => console.log(`[진행] ${step}`),
    async (msg) => console.warn(`[경고] ${msg}`),
  );

  const dateLabel = date ?? todayKST();
  if (result !== 'already_done') {
    addSubmissionHistory(dateLabel, topic, text);
    addRecentTopic(topic);
  }
  console.log(result === 'already_done' ? '✅ 이미 완료됨' : '✅ 회고 제출 완료');
}

async function doReset() {
  const dateInput = (await ask('초기화할 날짜 (엔터=오늘): ')).trim();
  const dateLabel = dateInput || todayKST();
  const result = await resetReflection(EMAIL, PASSWORD, dateLabel);
  removeSubmissionHistory(result.date);
  console.log(`✅ ${result.date} 초기화 완료`);
}

async function doTasks() {
  const { tasks } = await getTasksWithToken(EMAIL, PASSWORD);
  if (!tasks.length) { console.log('할일 없음'); return; }
  tasks.forEach((t, i) => console.log(`${i + 1}. [id=${t.id ?? t.taskId}] ${t.title ?? t.taskTitle ?? t.name}`));
}

async function doTaskAdd() {
  const title = (await ask('할일 제목: ')).trim();
  if (!title) { console.log('취소됨'); return; }
  const { status, taskId } = await browserCreateTask(EMAIL, PASSWORD, title);
  console.log(`status=${status} taskId=${taskId ?? '(응답에 없음, 할일 목록에서 확인)'}`);
}

async function doSchedule() {
  const taskId = (await ask('taskId: ')).trim();
  const startISO = (await ask('시작 (YYYY-MM-DDTHH:mm:00): ')).trim();
  const endISO = (await ask('종료 (YYYY-MM-DDTHH:mm:00): ')).trim();
  if (!taskId || !startISO || !endISO) { console.log('취소됨'); return; }
  const { status } = await browserCreateSchedule(EMAIL, PASSWORD, taskId, startISO, endISO);
  console.log(`status=${status}`);
}

async function doTopics() {
  const result = await generateWithRetry(
    '개발을 막 배우기 시작한 고등학생의 전공 학습을 주제로 뉴로우 회고에 쓸 만한 구체적인 주제 3개를 추천해줘.\n' +
    '번호 없이 한 줄씩, 25자 이내, 한국어만',
    30_000,
  );
  console.log(result.response.text().trim());
}

const MENU = [
  { label: '오늘 회고 하기', run: doReflect },
  { label: '회고 초기화', run: doReset },
  { label: '할일 목록 보기', run: doTasks },
  { label: '할일 추가', run: doTaskAdd },
  { label: '일정 등록', run: doSchedule },
  { label: '주제 추천만 보기', run: doTopics },
];

async function main() {
  requireEnv();
  console.log('📓 Daymark CLI\n');
  while (true) {
    console.log('');
    MENU.forEach((m, i) => console.log(`${i + 1}. ${m.label}`));
    console.log('0. 종료');
    const choice = (await ask('\n선택: ')).trim();
    if (choice === '0') break;
    const item = MENU[Number(choice) - 1];
    if (!item) { console.log('잘못된 입력'); continue; }
    try {
      await item.run();
    } catch (err) {
      console.error('❌', err.message);
    }
  }
  rl.close();
}

main();
