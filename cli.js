#!/usr/bin/env node
// auto-newrrow CLI — 뉴로우 회고 자동화 (터미널에서 직접 실행)
// 실행: node cli.js
// 최초 실행 시 "설정" 메뉴에서 GEMINI_API_KEY / EMAIL / PASSWORD 입력하면 .env에 저장됨
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config as loadEnv } from 'dotenv';
import { createInterface } from 'readline/promises';
import { emitKeypressEvents } from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '.env');
// newrrow는 전역 명령어라 어느 디렉토리에서 실행될지 모름 — cwd 기준이 아니라
// 항상 이 스크립트가 있는 폴더의 .env를 명시적으로 읽음
loadEnv({ path: ENV_PATH });

import { submitReflection, resetReflection, getTasksWithToken, browserCreateTask, browserCreateSchedule } from './automation.js';
import { addSubmissionHistory, removeSubmissionHistory, addRecentTopic, getRecentTopics } from './lib/data.js';
import { generateTopic, generateReflection, generateWithRetry } from './lib/ai.js';

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

function todayKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().split('T')[0];
}

const TTY = process.stdout.isTTY && process.stdin.isTTY;

// TTY일 땐 raw keypress로만 입력받음(아래 readKey/readLine) — readline Interface는 아예 안 만듦.
// createInterface()는 만들어두기만 해도 내부적으로 같은 stdin에 자기 keypress 리스너를
// 붙여서 몰래 자기만의 입력 버퍼를 쌓아두고, 나중에(resize 등으로) 그 버퍼를 프롬프트
// 스타일로 다시 그리면서 화면을 덮어써버리는 문제가 있었음. !TTY(파이프 입력)일 때만 생성.
const rl = TTY ? null : createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => rl.question(q);
if (TTY) emitKeypressEvents(process.stdin);

function exitApp() {
  if (TTY) process.stdout.write('\x1b[2J\x1b[H');
  console.log('👋 종료함');
  process.exit(0);
}

// 단일 키 입력 (raw mode) — validKeys가 null이면 아무 키나 허용
function readKey(validKeys) {
  if (!TTY) return ask('').then(s => s.trim());
  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onKeypress = (str, key) => {
      if (key?.ctrl && key.name === 'c') { cleanup(); exitApp(); }
      if (!str) return;
      if (validKeys === null || validKeys.includes(str)) { cleanup(); resolve(str); }
    };
    function cleanup() {
      process.stdin.removeListener('keypress', onKeypress);
      if (!process.stdin.destroyed) process.stdin.setRawMode(false);
    }
    process.stdin.on('keypress', onKeypress);
  });
}

// 한 줄 텍스트 입력 (raw mode 직접 구현 — backspace/한글 지원, Enter로 확정)
function readLine() {
  if (!TTY) return ask('').then(s => s.trim());
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    // 커서 이동+부분 지우기(\b 등) 조합은 일부 터미널(macOS 기본 터미널 포함)에서
    // 배경색 렌더링이 깨지는 문제가 있었음 — 매 키 입력마다 입력줄 전체를 고정폭으로
    // 통째로 다시 그리는 방식으로 교체 (버그 재현 안 되던 원격 테스트와 달리 실기기에서
    // 재현됐던 문제라 확실한 방식으로 바꿈)
    function redraw() {
      const pad = ' '.repeat(Math.max(INNER_WIDTH - vwidth(buf), 0));
      process.stdout.write(`\x1b[${inputCol()}G${BG}${C.light}${buf}${FULL_RESET}${BG}${pad}${FULL_RESET}\x1b[${pad.length}D`);
    }
    const onKeypress = (str, key) => {
      if (key?.ctrl && key.name === 'c') { cleanup(); exitApp(); }
      if (key?.name === 'return' || str === '\r' || str === '\n') {
        cleanup();
        process.stdout.write('\n');
        resolve(buf.trim());
        return;
      }
      if (key?.name === 'backspace' || key?.name === 'delete' || str === '\x7f' || str === '\b') {
        if (buf.length > 0) {
          buf = buf.slice(0, -1);
          redraw();
        }
        return;
      }
      // 방향키/esc/tab 등 이름 있는 특수키는 무시 (조각난 이스케이프 시퀀스가 글자로 새는 것 방지)
      if (key?.name && key.name.length > 1) return;
      if (str && !key?.ctrl && !key?.meta && str.charCodeAt(0) >= 0x20 && vwidth(buf) + vwidth(str) <= INNER_WIDTH) {
        buf += str;
        redraw();
      }
    };
    function cleanup() {
      process.stdin.removeListener('keypress', onKeypress);
      if (!process.stdin.destroyed) process.stdin.setRawMode(false);
    }
    process.stdin.on('keypress', onKeypress);
  });
}

// ── 터미널 UI (ANSI 컬러 + 박스, 전체화면 배경) ──
// C.reset은 fg/bold만 끔 (bg 유지) — 화면 전체를 한 배경색으로 깔기 위함
const C = TTY ? {
  reset: '\x1b[39;22m', bold: '\x1b[1m',
  orange: '\x1b[38;5;209m', green: '\x1b[38;5;114m', red: '\x1b[38;5;203m',
  gray: '\x1b[38;5;242m', dim: '\x1b[38;5;238m', light: '\x1b[38;5;253m',
} : { reset: '', bold: '', orange: '', green: '', red: '', gray: '', dim: '', light: '' };
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

function fillScreen() {
  if (!TTY) return;
  const term = process.stdout.columns > 0 ? process.stdout.columns : 80;
  const rows = process.stdout.rows > 0 ? process.stdout.rows : 24;
  let buf = '\x1b[2J\x1b[H';
  for (let i = 0; i < rows; i++) buf += `${BG}${' '.repeat(term)}${FULL_RESET}\n`;
  buf += '\x1b[H';
  process.stdout.write(buf);
}
function screenLine(coloredText, plainWidth) {
  const term = process.stdout.columns || 80;
  const left = Math.max(Math.floor((term - plainWidth) / 2), 0);
  const right = Math.max(term - plainWidth - left, 0);
  return `${BG}${' '.repeat(left)}${coloredText}${' '.repeat(right)}${FULL_RESET}`;
}
function screenCenter(coloredText, plainWidth) {
  console.log(screenLine(coloredText, plainWidth));
}

// 화면 폭에 비례해서 카드 크기를 정함 (작은 터미널=최소 크기, 큰 터미널=비례해서 커짐)
let WIDTH = 50;
let CARD_WIDTH = WIDTH + 4;
let INNER_WIDTH = WIDTH - 6;
function recomputeLayout() {
  const cols = process.stdout.columns || 80;
  const target = Math.round(cols * 0.8);
  CARD_WIDTH = Math.max(54, Math.min(target, cols - 4, 160));
  WIDTH = CARD_WIDTH - 4;
  INNER_WIDTH = WIDTH - 6; // 바깥 여백 2칸씩 + 안쪽 박스 테두리 2칸
}

const CONTENT_ROWS = 8; // 카드 내용 영역 줄 수 — 모든 화면이 이 높이로 고정돼야 커서 이동 계산이 일정함

// 내용 줄은 폭이 고정되기 전(WIDTH 미확정) 시점에 만들어질 수 있어서, 실제 패딩은
// drawCard가 그릴 때(WIDTH 확정 후) 적용함 — {plain, colored} 형태로만 들고 있음
function padContentRows(lines) {
  const out = lines.slice(0, CONTENT_ROWS);
  while (out.length < CONTENT_ROWS) out.push({ plain: '', colored: '' });
  return out;
}
function contentRow(plainText, coloredText) {
  return { plain: `  ${plainText}`, colored: `  ${coloredText}` };
}
function blankContentRow() {
  return { plain: '', colored: '' };
}

// 카드 전체 그리기: contentLines(최대 CONTENT_ROWS줄) + 입력/상태 박스(placeholder)
// 구조가 항상 동일해야 ROWS_BELOW_INPUT / CONTENT_TOP_OFFSET 같은 상대 커서 이동이 맞음
let currentScreen = null;
let cursorAtInput = false;
function drawCard(contentLines, placeholder) {
  currentScreen = { contentLines, placeholder };
  cursorAtInput = false;
  recomputeLayout();
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

  padContentRows(contentLines).forEach(l => p(row(l.plain, l.colored, WIDTH)));
  p(row('', '', WIDTH));

  const innerLine = '─'.repeat(INNER_WIDTH + 2);
  p(row(`  ┌${innerLine}┐`, `  ${C.dim}┌${innerLine}┐${C.reset}`, WIDTH));
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

// drawCard가 그리는 줄 순서(0-index, vPad 이후 기준):
// 0 상단테두리 1 공백 2 라벨 3 타이틀 4 공백 5..12 내용(8줄) 13 공백
// 14 입력박스상단 15 입력줄 16 입력박스하단 17 공백 18 구분선 19 팁 20 하단테두리
// drawCard 종료 직후(마지막 console.log의 개행 포함) 커서는 21번째 줄(인덱스21)에 있음
const CARD_HEIGHT = 21;
const RESTING_INDEX = 21;
const INPUT_ROW_INDEX = 15;
const CONTENT_FIRST_INDEX = 5;
const ROWS_BELOW_INPUT = RESTING_INDEX - INPUT_ROW_INDEX; // 6
const CONTENT_TOP_OFFSET = RESTING_INDEX - CONTENT_FIRST_INDEX; // 16

function inputCol() {
  const term = process.stdout.columns || 80;
  const leftPad = Math.max(Math.floor((term - CARD_WIDTH) / 2), 0);
  return leftPad + 2 /* │+space */ + 2 /* 들여쓰기 */ + 2 /* ┃+space */ + 1;
}

// 터미널 창 크기가 바뀌면 현재 화면을 새 크기에 맞춰 다시 그림
if (TTY) {
  let resizeTimer = null;
  process.stdout.on('resize', () => {
    clearTimeout(resizeTimer);
    // 리사이즈 중 연달아 뜨는 이벤트 중 크기값이 순간적으로 이상하게 잡히는 경우가 있어
    // 살짝 debounce 후 그림 (드래그 리사이즈 도중 깜빡임/부분렌더 방지)
    resizeTimer = setTimeout(() => {
      if (!currentScreen) return;
      if ((process.stdout.columns || 0) < 20 || (process.stdout.rows || 0) < 10) return;
      const wasAtInput = cursorAtInput;
      drawCard(currentScreen.contentLines, currentScreen.placeholder);
      if (wasAtInput) {
        process.stdout.write(`\x1b[${ROWS_BELOW_INPUT}A\x1b[${inputCol()}G`);
        cursorAtInput = true;
      }
    }, 80);
  });
}

// 카드 내용 영역만 라이브 갱신 (자동화 진행 로그처럼 반복적으로 바뀌는 화면용)
function updateContent(contentLines) {
  if (!TTY) return;
  const padded = padContentRows(contentLines);
  process.stdout.write(`\x1b[${CONTENT_TOP_OFFSET}A`);
  padded.forEach((l, i) => {
    process.stdout.write(`\r${screenLine(row(l.plain, l.colored, WIDTH), CARD_WIDTH)}\x1b[K`);
    if (i < padded.length - 1) process.stdout.write('\n');
  });
  process.stdout.write(`\x1b[${CONTENT_TOP_OFFSET - (CONTENT_ROWS - 1)}B\r`);
}

// 카드 하단 입력박스로 커서를 옮겨 raw keypress로 번호 하나 받고, 그 자리에 선택 결과 표시
async function cardChoice(contentLines, placeholder, validKeys) {
  drawCard(contentLines, placeholder);
  if (TTY) { process.stdout.write(`\x1b[${ROWS_BELOW_INPUT}A\x1b[${inputCol()}G`); cursorAtInput = true; }
  const choice = await readKey(validKeys);
  cursorAtInput = false;
  if (TTY) {
    const confirmPad = ' '.repeat(Math.max(INNER_WIDTH - vwidth(choice), 0));
    process.stdout.write(`\x1b[${inputCol()}G${C.bold}${C.green}${choice}${C.reset}${confirmPad}`);
    process.stdout.write(`\x1b[${ROWS_BELOW_INPUT}B\r`);
  }
  return choice;
}

// 카드 하단 입력박스로 커서를 옮겨 일반 텍스트를 받음 (줄 편집 가능, Enter로 종료)
async function cardAsk(contentLines, placeholder) {
  drawCard(contentLines, placeholder);
  if (TTY) { process.stdout.write(`\x1b[${ROWS_BELOW_INPUT}A\x1b[${inputCol()}G`); cursorAtInput = true; }
  const value = await readLine();
  cursorAtInput = false;
  if (TTY) process.stdout.write(`\x1b[${ROWS_BELOW_INPUT - 1}B\r`); // Enter가 이미 개행 1줄 만듦
  return value;
}

// 상태만 보여주고 아무 키나 눌러야 넘어가는 화면
async function cardWait(contentLines, placeholder = '아무 키나 눌러 메뉴로 돌아가기') {
  drawCard(contentLines, placeholder);
  if (TTY) await readKey(null);
}

function textLine(label, value, color = C.light) {
  return contentRow(`${label}: ${value}`, `${C.gray}${label}:${C.reset} ${color}${value}${C.reset}`);
}
function errorLines(err) {
  const msg = (err?.message ?? String(err)).slice(0, 200);
  return [contentRow('오류', `${C.red}❌ 오류${C.reset}`), blankContentRow(), contentRow(msg, `${C.light}${msg}${C.reset}`)];
}

// ── 각 기능 ──

async function doSettings() {
  const currentLines = () => [
    textLine('GEMINI_API_KEY', mask(process.env.GEMINI_API_KEY)),
    textLine('EMAIL', mask(EMAIL)),
    textLine('PASSWORD', mask(PASSWORD)),
    textLine('HEADLESS', process.env.HEADLESS !== 'false' ? '숨김' : '보임'),
    blankContentRow(),
    contentRow('엔터만 치면 값 유지', `${C.dim}엔터만 치면 값 유지${C.reset}`),
  ];

  const gemini = await cardAsk(currentLines(), '새 GEMINI_API_KEY (엔터=유지)');
  if (gemini) upsertEnvValue('GEMINI_API_KEY', gemini);

  const email = await cardAsk(currentLines(), '새 뉴로우 EMAIL (엔터=유지)');
  if (email) { upsertEnvValue('EMAIL', email); EMAIL = email; }

  const password = await cardAsk(currentLines(), '새 뉴로우 PASSWORD (엔터=유지)');
  if (password) { upsertEnvValue('PASSWORD', password); PASSWORD = password; }

  const headless = (await cardAsk(currentLines(), '브라우저 창 보이게? y/n (엔터=유지)')).toLowerCase();
  if (headless === 'y' || headless === 'yes') upsertEnvValue('HEADLESS', 'false');
  else if (headless === 'n' || headless === 'no') upsertEnvValue('HEADLESS', 'true');

  await cardWait([
    contentRow('✅ 저장 완료', `${C.green}✅ 저장 완료${C.reset}`),
    blankContentRow(),
    ...currentLines(),
  ]);
}

async function doReflect() {
  ensureCreds();

  const date = await cardAsk([contentRow('오늘 회고 작성', `${C.bold}오늘 회고 작성${C.reset}`)], '날짜 (엔터=오늘, YYYY-MM-DD)') || null;

  let topic = await cardAsk([textLine('날짜', date ?? '오늘')], '주제 (엔터=AI 자동 추천)');
  if (!topic) {
    drawCard([textLine('날짜', date ?? '오늘')], 'AI가 주제 생성 중...');
    topic = await generateTopic(getRecentTopics());
  }

  let text = await cardAsk([textLine('날짜', date ?? '오늘'), textLine('주제', topic)], '내용 (엔터=AI 자동 작성)');
  if (!text) {
    drawCard([textLine('날짜', date ?? '오늘'), textLine('주제', topic)], 'AI가 내용 작성 중...');
    text = await generateReflection(topic);
  }

  const log = [];
  const pushLog = (l) => { log.push(l); if (log.length > CONTENT_ROWS) log.shift(); };
  const renderLog = () => log.map(l => contentRow(l, `${C.light}${l}${C.reset}`));

  pushLog(`📌 ${topic}`);
  drawCard(renderLog(), '자동화 진행 중...');

  let result;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      result = await submitReflection(
        text, EMAIL, PASSWORD, topic, date,
        async (step) => { pushLog(`▸ ${step}`); updateContent(renderLog()); },
        async (msg) => { pushLog(`⚠ ${msg}`); updateContent(renderLog()); },
      );
      break;
    } catch (err) {
      if (attempt === 2) throw err;
      pushLog(`⚠ 1차 시도 실패 — 재시도: ${err.message.slice(0, 40)}`);
      updateContent(renderLog());
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  const dateLabel = date ?? todayKST();
  if (result !== 'already_done') {
    addSubmissionHistory(dateLabel, topic, text);
    addRecentTopic(topic);
  }
  await cardWait([
    contentRow(result === 'already_done' ? '이미 완료됨' : '회고 완료', `${C.green}✅ ${result === 'already_done' ? '이미 완료됨' : '회고 완료'}${C.reset}`),
    blankContentRow(),
    textLine('날짜', dateLabel),
    textLine('주제', topic),
  ]);
}

async function doReset() {
  ensureCreds({ gemini: false });
  const dateLabel = (await cardAsk([contentRow('회고 초기화', `${C.bold}회고 초기화${C.reset}`)], '초기화할 날짜 (엔터=오늘)')) || todayKST();
  drawCard([textLine('날짜', dateLabel)], '초기화 중...');
  const result = await resetReflection(EMAIL, PASSWORD, dateLabel);
  removeSubmissionHistory(result.date);
  await cardWait([contentRow('초기화 완료', `${C.green}✅ ${result.date} 초기화 완료${C.reset}`)]);
}

async function doTasks() {
  ensureCreds({ gemini: false });
  drawCard([], '할일 불러오는 중...');
  const { tasks } = await getTasksWithToken(EMAIL, PASSWORD);
  const lines = tasks.length
    ? tasks.slice(0, CONTENT_ROWS).map((t, i) => contentRow(`${i + 1}. ${t.title ?? t.taskTitle ?? t.name}`, `${C.gray}${i + 1}.${C.reset} ${C.light}${t.title ?? t.taskTitle ?? t.name}${C.reset}`))
    : [contentRow('할일 없음', `${C.dim}할일 없음${C.reset}`)];
  await cardWait(lines);
}

async function doTaskAdd() {
  ensureCreds({ gemini: false });
  const title = await cardAsk([contentRow('할일 추가', `${C.bold}할일 추가${C.reset}`)], '할일 제목');
  if (!title) return;
  drawCard([textLine('제목', title)], '추가 중...');
  const { status, taskId } = await browserCreateTask(EMAIL, PASSWORD, title);
  await cardWait([
    contentRow('추가 완료', `${C.green}✅ status=${status}${C.reset}`),
    textLine('taskId', taskId ?? '(할일 목록에서 확인)'),
  ]);
}

async function doSchedule() {
  ensureCreds({ gemini: false });
  const taskId = await cardAsk([contentRow('일정 등록', `${C.bold}일정 등록${C.reset}`)], 'taskId');
  if (!taskId) return;
  const startISO = await cardAsk([textLine('taskId', taskId)], '시작 (YYYY-MM-DDTHH:mm:00)');
  if (!startISO) return;
  const endISO = await cardAsk([textLine('taskId', taskId), textLine('시작', startISO)], '종료 (YYYY-MM-DDTHH:mm:00)');
  if (!endISO) return;
  drawCard([textLine('taskId', taskId), textLine('시작', startISO), textLine('종료', endISO)], '등록 중...');
  const { status } = await browserCreateSchedule(EMAIL, PASSWORD, taskId, startISO, endISO);
  await cardWait([contentRow('등록 완료', `${C.green}✅ status=${status}${C.reset}`)]);
}

async function doTopics() {
  ensureCreds({ account: false });
  drawCard([], 'AI가 주제 추천 생성 중...');
  const result = await generateWithRetry(
    '개발을 막 배우기 시작한 고등학생의 전공 학습을 주제로 뉴로우 회고에 쓸 만한 구체적인 주제 3개를 추천해줘.\n' +
    '번호 없이 한 줄씩, 25자 이내, 한국어만',
    30_000,
  );
  const topics = result.response.text().trim().split('\n').filter(Boolean);
  await cardWait(topics.map((t, i) => contentRow(`${i + 1}. ${t}`, `${C.light}${i + 1}. ${t}${C.reset}`)));
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

function menuContentLines() {
  return [
    ...MENU.map((m, i) => contentRow(`${i + 1}. ${m.label}`, `${C.gray}${i + 1}.${C.reset} ${i === 0 ? C.green : C.light}${m.label}${C.reset}`)),
    contentRow('0. 종료', `${C.gray}0.${C.reset} ${C.light}종료${C.reset}`),
  ];
}

async function main() {
  while (true) {
    let choice;
    try {
      const validKeys = MENU.map((_, i) => String(i + 1)).concat('0');
      choice = await cardChoice(menuContentLines(), '번호 선택 (0=종료)', validKeys);
    } catch {
      break; // 입력 스트림이 끊기면 그냥 종료
    }
    if (choice === '0') break;
    const item = MENU[Number(choice) - 1];
    if (!item) continue;
    try {
      await item.run();
    } catch (err) {
      try {
        await cardWait(errorLines(err));
      } catch {
        console.error('❌', err.message);
        break;
      }
    }
  }
  if (rl) rl.close();
  exitApp();
}

// 예상 못 한 에러로 죽을 때 화면 지우고 실제 에러 보여줌 (그냥 검게 멈춘 채 죽는 것 방지)
process.on('uncaughtException', (err) => {
  if (TTY) process.stdout.write('\x1b[2J\x1b[H\x1b[0m');
  console.error('❌ 예상 못 한 오류로 종료됨:\n');
  console.error(err.stack || err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  if (TTY) process.stdout.write('\x1b[2J\x1b[H\x1b[0m');
  console.error('❌ 예상 못 한 오류로 종료됨:\n');
  console.error(err?.stack || err);
  process.exit(1);
});

main();
