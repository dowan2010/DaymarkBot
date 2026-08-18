#!/usr/bin/env node
// auto-newrrow CLI — 뉴로우 회고 자동화 (터미널에서 직접 실행)
// 실행: node cli.js
// 최초 실행 시 "설정" 메뉴에서 GEMINI_API_KEY / EMAIL / PASSWORD 입력하면 .env에 저장됨
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createInterface } from 'readline/promises';
import { submitReflection, resetReflection, getTasksWithToken, browserCreateTask, browserCreateSchedule } from './automation.js';
import { addSubmissionHistory, removeSubmissionHistory, addRecentTopic, getRecentTopics } from './lib/data.js';
import { generateTopic, generateReflection, generateWithRetry } from './lib/ai.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '.env');

let EMAIL = process.env.EMAIL || process.env.TEST_EMAIL;
let PASSWORD = process.env.PASSWORD || process.env.TEST_PASSWORD;

function upsertEnvValue(key, value) {
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf-8').split('\n') : [];
  const idx = lines.findIndex(l => l.startsWith(`${key}=`));
  const line = `${key}=${value}`;
  if (idx >= 0) lines[idx] = line;
  else lines.push(line);
  writeFileSync(ENV_PATH, lines.filter((l, i) => l !== '' || i === lines.length - 1).join('\n'));
  process.env[key] = value;
}

function mask(v) {
  return v ? `${v.slice(0, 4)}${'*'.repeat(Math.max(v.length - 4, 0))}` : '(설정 안 됨)';
}

function ensureCreds({ gemini = true, account = true } = {}) {
  const missing = [];
  if (gemini && !process.env.GEMINI_API_KEY) missing.push('GEMINI_API_KEY');
  if (account && !EMAIL) missing.push('EMAIL');
  if (account && !PASSWORD) missing.push('PASSWORD');
  if (missing.length) throw new Error(`설정 안 됨: ${missing.join(', ')} — "설정" 메뉴에서 먼저 입력해줘`);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => rl.question(q);

function todayKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().split('T')[0];
}

async function doSettings() {
  console.log('\n엔터 = 기존 값 유지\n');

  console.log(`GEMINI_API_KEY 현재: ${mask(process.env.GEMINI_API_KEY)}`);
  const gemini = (await ask('새 GEMINI_API_KEY: ')).trim();
  if (gemini) upsertEnvValue('GEMINI_API_KEY', gemini);

  console.log(`\nEMAIL 현재: ${mask(EMAIL)}`);
  const email = (await ask('새 뉴로우 EMAIL: ')).trim();
  if (email) { upsertEnvValue('EMAIL', email); EMAIL = email; }

  console.log(`\nPASSWORD 현재: ${mask(PASSWORD)}`);
  const password = (await ask('새 뉴로우 PASSWORD: ')).trim();
  if (password) { upsertEnvValue('PASSWORD', password); PASSWORD = password; }

  console.log('\n✅ 저장 완료 (.env)');
}

async function doReflect() {
  ensureCreds();
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
  ensureCreds({ gemini: false });
  const dateInput = (await ask('초기화할 날짜 (엔터=오늘): ')).trim();
  const dateLabel = dateInput || todayKST();
  const result = await resetReflection(EMAIL, PASSWORD, dateLabel);
  removeSubmissionHistory(result.date);
  console.log(`✅ ${result.date} 초기화 완료`);
}

async function doTasks() {
  ensureCreds({ gemini: false });
  const { tasks } = await getTasksWithToken(EMAIL, PASSWORD);
  if (!tasks.length) { console.log('할일 없음'); return; }
  tasks.forEach((t, i) => console.log(`${i + 1}. [id=${t.id ?? t.taskId}] ${t.title ?? t.taskTitle ?? t.name}`));
}

async function doTaskAdd() {
  ensureCreds({ gemini: false });
  const title = (await ask('할일 제목: ')).trim();
  if (!title) { console.log('취소됨'); return; }
  const { status, taskId } = await browserCreateTask(EMAIL, PASSWORD, title);
  console.log(`status=${status} taskId=${taskId ?? '(응답에 없음, 할일 목록에서 확인)'}`);
}

async function doSchedule() {
  ensureCreds({ gemini: false });
  const taskId = (await ask('taskId: ')).trim();
  const startISO = (await ask('시작 (YYYY-MM-DDTHH:mm:00): ')).trim();
  const endISO = (await ask('종료 (YYYY-MM-DDTHH:mm:00): ')).trim();
  if (!taskId || !startISO || !endISO) { console.log('취소됨'); return; }
  const { status } = await browserCreateSchedule(EMAIL, PASSWORD, taskId, startISO, endISO);
  console.log(`status=${status}`);
}

async function doTopics() {
  ensureCreds({ account: false });
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
  { label: '설정 (API 키 / 계정)', run: doSettings },
];

// ── 터미널 UI (ANSI 컬러 + 박스) ──
const TTY = process.stdout.isTTY;
const C = TTY ? {
  reset: '\x1b[0m', bold: '\x1b[1m',
  orange: '\x1b[38;5;209m', green: '\x1b[38;5;114m',
  gray: '\x1b[38;5;242m', dim: '\x1b[38;5;238m', light: '\x1b[38;5;253m',
} : { reset: '', bold: '', orange: '', green: '', gray: '', dim: '', light: '' };

function vwidth(s) {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    w += (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0x3130 && cp <= 0x318F) ? 2 : 1;
  }
  return w;
}
function row(plainText, coloredText, width) {
  return `${C.dim}│${C.reset} ${coloredText}${' '.repeat(Math.max(width - vwidth(plainText), 0))} ${C.dim}│${C.reset}`;
}

function printMenu() {
  const WIDTH = 40;
  const line = '─'.repeat(WIDTH + 2);
  console.log(`${C.dim}┌${line}┐${C.reset}`);
  console.log(row('AUTO-NEWRROW', `${C.bold}${C.orange}AUTO-NEWRROW${C.reset}`, WIDTH));
  console.log(`${C.dim}├${line}┤${C.reset}`);
  MENU.forEach((m, i) => {
    const color = i === 0 ? C.green : C.light;
    const plain = `${i + 1}. ${m.label}`;
    console.log(row(plain, `${C.gray}${i + 1}.${C.reset} ${color}${m.label}${C.reset}`, WIDTH));
  });
  console.log(row('0. 종료', `${C.gray}0.${C.reset} ${C.light}종료${C.reset}`, WIDTH));
  console.log(`${C.dim}├${line}┤${C.reset}`);
  const tip = '● 뉴로우 회고 자동화 · Gemini';
  console.log(row(tip, `${C.orange}●${C.reset} ${C.dim}뉴로우 회고 자동화 · Gemini${C.reset}`, WIDTH));
  console.log(`${C.dim}└${line}┘${C.reset}`);
}

async function main() {
  console.log(`\n${C.bold}${C.orange}📓 auto-newrrow CLI${C.reset}\n`);
  while (true) {
    console.log('');
    printMenu();
    const choice = (await ask(`\n${C.light}선택: ${C.reset}`)).trim();
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
