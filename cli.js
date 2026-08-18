#!/usr/bin/env node
// auto-newrrow CLI — 뉴로우 회고 자동화 (터미널에서 직접 실행)
// 실행: node cli.js
// 최초 실행 시 "설정" 메뉴에서 GEMINI_API_KEY / EMAIL / PASSWORD 입력하면 .env에 저장됨
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createInterface } from 'readline/promises';
import { emitKeypressEvents } from 'readline';
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
if (process.stdin.isTTY) emitKeypressEvents(process.stdin, rl);

// 메뉴 번호는 raw keypress로 즉시 받음 (엔터 필요 없음, Claude Code류 TUI 방식)
function readKey(validKeys) {
  const TTY_IN = process.stdin.isTTY;
  if (!TTY_IN) return ask('').then(s => s.trim());
  return new Promise((resolve) => {
    rl.pause();
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onKeypress = (str, key) => {
      if (key?.ctrl && key.name === 'c') { cleanup(); process.exit(0); }
      if (str && validKeys.includes(str)) { cleanup(); resolve(str); }
    };
    function cleanup() {
      process.stdin.removeListener('keypress', onKeypress);
      if (!process.stdin.destroyed) process.stdin.setRawMode(false);
      try { rl.resume(); } catch {}
    }
    process.stdin.on('keypress', onKeypress);
  });
}

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

  const isHeadless = process.env.HEADLESS !== 'false';
  console.log(`\n브라우저 창 표시 현재: ${isHeadless ? '숨김' : '보임'}`);
  const headless = (await ask('브라우저 창 보이게 할까? (y/n, 엔터=유지): ')).trim().toLowerCase();
  if (headless === 'y' || headless === 'yes') upsertEnvValue('HEADLESS', 'false');
  else if (headless === 'n' || headless === 'no') upsertEnvValue('HEADLESS', 'true');

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

  let result;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      result = await submitReflection(
        text, EMAIL, PASSWORD, topic, date,
        async (step) => console.log(`[진행] ${step}`),
        async (msg) => console.warn(`[경고] ${msg}`),
      );
      break;
    } catch (err) {
      if (attempt === 2) throw err;
      console.warn(`⚠️ 1차 시도 실패 — 재시도: ${err.message}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

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

// ── 터미널 UI (ANSI 컬러 + 박스, 전체화면 배경) ──
const TTY = process.stdout.isTTY;
// C.reset은 fg/bold만 끔 (bg 유지) — 화면 전체를 한 배경색으로 깔기 위함
const C = TTY ? {
  reset: '\x1b[39;22m', bold: '\x1b[1m',
  orange: '\x1b[38;5;209m', green: '\x1b[38;5;114m',
  gray: '\x1b[38;5;242m', dim: '\x1b[38;5;238m', light: '\x1b[38;5;253m',
} : { reset: '', bold: '', orange: '', green: '', gray: '', dim: '', light: '' };
const BG = TTY ? '\x1b[48;5;233m' : '';
const FULL_RESET = TTY ? '\x1b[0m' : '';

function vwidth(s) {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    w += (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0x3130 && cp <= 0x318F) ? 2 : 1;
  }
  return w;
}
function row(plainText, coloredText, width, pad = ' ') {
  return `${C.dim}│${C.reset} ${coloredText}${pad.repeat(Math.max(width - vwidth(plainText), 0))} ${C.dim}│${C.reset}`;
}
function center(plainText, coloredText, width) {
  const gap = Math.max(width - vwidth(plainText), 0);
  const left = Math.floor(gap / 2), right = gap - left;
  return `${C.dim}│${C.reset} ${' '.repeat(left)}${coloredText}${' '.repeat(right)} ${C.dim}│${C.reset}`;
}

function innerRow(text, coloredText, innerWidth) {
  const pad = ' '.repeat(Math.max(innerWidth - vwidth(text), 0));
  return { plain: `│ ${text}${pad} │`, colored: `${C.dim}│${C.reset} ${coloredText}${pad} ${C.dim}│${C.reset}` };
}

// 전체 화면을 배경색으로 깔고, 그 위에 카드를 가운데 정렬해서 그림
function fillScreen() {
  if (!TTY) return;
  const term = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  let buf = '\x1b[2J\x1b[H';
  for (let i = 0; i < rows; i++) buf += `${BG}${' '.repeat(term)}${FULL_RESET}\n`;
  buf += '\x1b[H';
  process.stdout.write(buf);
}
function screenCenter(coloredText, plainWidth) {
  const term = process.stdout.columns || 80;
  const left = Math.max(Math.floor((term - plainWidth) / 2), 0);
  const right = Math.max(term - plainWidth - left, 0);
  console.log(`${BG}${' '.repeat(left)}${coloredText}${' '.repeat(right)}${FULL_RESET}`);
}

const WIDTH = 50;
const CARD_WIDTH = WIDTH + 4;

const INNER_WIDTH = WIDTH - 6; // 바깥 여백 2칸씩 + 안쪽 박스 테두리 2칸

// 카드 상단(타이틀 + 전체 메뉴 목록)까지 그리고, 입력 박스는 열어둔 채로 반환
// (입력 박스 안에서 바로 readline으로 받기 위해 박스를 닫지 않음)
const CARD_HEIGHT = 22; // printMenuTop(17줄) + printMenuBottom(5줄)

function printMenuTop() {
  fillScreen();
  const line = '─'.repeat(WIDTH + 2);
  const p = (cardLine) => screenCenter(cardLine, CARD_WIDTH);

  const rows = process.stdout.rows || 24;
  const vPad = Math.max(Math.floor((rows - CARD_HEIGHT) / 2), 0);
  for (let i = 0; i < vPad; i++) screenCenter('', 0);

  if (!TTY) console.log('');
  p(`${C.dim}┌${line}┐${C.reset}`);
  p(row('', '', WIDTH));
  p(center('A U T O - N E W R R O W', `${C.gray}A U T O - N E W R R O W${C.reset}`, WIDTH));
  p(center('AUTO-NEWRROW CLI', `${C.bold}${C.orange}AUTO-NEWRROW${C.reset} ${C.bold}${C.light}CLI${C.reset}`, WIDTH));
  p(row('', '', WIDTH));

  MENU.forEach((m, i) => {
    const color = i === 0 ? C.green : C.light;
    p(row(`  ${i + 1}. ${m.label}`, `  ${C.gray}${i + 1}.${C.reset} ${color}${m.label}${C.reset}`, WIDTH));
  });
  p(row(`  0. 종료`, `  ${C.gray}0.${C.reset} ${C.light}종료${C.reset}`, WIDTH));
  p(row('', '', WIDTH));

  const innerLine = '─'.repeat(INNER_WIDTH + 2);
  p(row(`  ┌${innerLine}┐`, `  ${C.dim}┌${innerLine}┐${C.reset}`, WIDTH));

  // 입력 줄 — 왼쪽 오렌지 악센트바(┃) + placeholder. 실제 입력은 커서를 이 자리로
  // 되돌려서 raw keypress로 받음 (captureMenuChoice)
  const placeholder = '번호 선택 (0=종료)';
  const pad = ' '.repeat(Math.max(INNER_WIDTH - vwidth(placeholder), 0));
  const plainInput = `  │ ${placeholder}${pad} │`;
  const coloredInput = `  ${C.orange}┃${C.reset} ${C.dim}${placeholder}${C.reset}${pad} ${C.dim}│${C.reset}`;
  p(row(plainInput, coloredInput, WIDTH));

  p(row(`  └${innerLine}┘`, `  ${C.dim}└${innerLine}┘${C.reset}`, WIDTH));
  p(row('', '', WIDTH));
  p(`${C.dim}├${line}┤${C.reset}`);
  const tip = '● 뉴로우 회고 자동화 · Gemini';
  p(row(tip, `${C.orange}●${C.reset} ${C.dim}뉴로우 회고 자동화 · Gemini${C.reset}`, WIDTH));
  p(`${C.dim}└${line}┘${C.reset}`);
}

// 입력 줄로 커서를 되돌려 raw keypress로 번호를 받고, 그 자리에 선택 결과를 다시 그림
const ROWS_BELOW_INPUT = 6; // 입력줄 다음에 그려진 5줄(박스하단/공백/구분선/팁/외곽하단) + 마지막 console.log가 만든 개행 1줄
async function captureMenuChoice() {
  const term = process.stdout.columns || 80;
  const leftPad = Math.max(Math.floor((term - CARD_WIDTH) / 2), 0);
  const col = leftPad + 2 /* │+space */ + 2 /* 들여쓰기 */ + 2 /* ┃+space */ + 1;
  if (TTY) process.stdout.write(`\x1b[${ROWS_BELOW_INPUT}A\x1b[${col}G`);

  const validKeys = MENU.map((_, i) => String(i + 1)).concat('0');
  const choice = await readKey(validKeys);

  if (TTY) {
    const item = MENU[Number(choice) - 1];
    const label = choice === '0' ? '종료' : (item ? item.label : '잘못된 입력');
    const confirmPlain = `${choice}. ${label}`;
    const confirmPad = ' '.repeat(Math.max(INNER_WIDTH - vwidth(confirmPlain), 0));
    process.stdout.write(`\x1b[${col}G${C.bold}${C.green}${confirmPlain}${C.reset}${confirmPad}`);
    process.stdout.write(`\x1b[${ROWS_BELOW_INPUT}B\r`);
  }
  return choice;
}

async function main() {
  while (true) {
    printMenuTop();
    const choice = await captureMenuChoice();
    if (choice === '0') break;
    const item = MENU[Number(choice) - 1];
    if (!item) { console.log('잘못된 입력'); continue; }
    if (TTY) console.log(`${FULL_RESET}`);
    try {
      await item.run();
    } catch (err) {
      console.error('❌', err.message);
    }
    await ask(`\n${C.dim}엔터를 누르면 메뉴로 돌아감...${C.reset}`);
  }
  rl.close();
  process.exit(0);
}

main();
