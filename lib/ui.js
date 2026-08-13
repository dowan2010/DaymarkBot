import {
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} from 'discord.js';
import { getSubmissionHistory } from './data.js';

export const CV2 = MessageFlags.IsComponentsV2;
export const CV2E = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;

export const PROGRESS_STEPS = [
  '브라우저 시작', '뉴로우 접속', '로그인', '자가 점검', '하루 돌아보기',
  '회고 주제 입력', '회고 유형 선택', '회고 내용 입력', '생각 정리', '저장', '공유', '감사 카드',
];

export const STEP_MAP = {
  '브라우저 시작 중...': '브라우저 시작',
  '뉴로우 접속 중...': '뉴로우 접속',
  '로그인 중...': '로그인',
  '자가 점검 진행 중...': '자가 점검',
  '하루 돌아보기 진행 중...': '하루 돌아보기',
  '회고 주제 입력 중...': '회고 주제 입력',
  '회고 유형 선택 중...': '회고 유형 선택',
  '회고 내용 입력 중...': '회고 내용 입력',
  '더 생각해 보기 처리 중...': '생각 정리',
  '회고 저장 중...': '저장',
  '회고 공유 중...': '공유',
  '감사 카드 작성 중...': '감사 카드',
};

export const THANK_TYPES = new Set(['선생님', '친구', '자신']);

const STEP_DURATIONS = {
  '브라우저 시작': 5, '뉴로우 접속': 5, '로그인': 10, '자가 점검': 15,
  '하루 돌아보기': 10, '회고 주제 입력': 5, '회고 유형 선택': 5,
  '회고 내용 입력': 10, '생각 정리': 15, '저장': 5, '공유': 5, '감사 카드': 15,
};

// 앱 이모지 (clientReady에서 로드, 없으면 유니코드 폴백)
export const EMOJI = {
  DONE:     '✅',
  ERROR:    '❌',
  PROGRESS: '⏳',
  PENDING:  '🕐',
  SEARCH:   '🔍',
};

export function getNowKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

export function getTodayKST() {
  return getNowKST().toISOString().split('T')[0];
}

function pgBar(done, total) {
  return '█'.repeat(done) + '░'.repeat(total - done);
}

function getRemainingSeconds(doneSet, stepStartTime) {
  let result = 0;
  let passedCurrent = false;
  for (const step of PROGRESS_STEPS) {
    if (doneSet.has(step)) continue;
    if (!passedCurrent) {
      passedCurrent = true;
      const elapsed = Math.floor((Date.now() - stepStartTime) / 1000);
      result += Math.max(0, (STEP_DURATIONS[step] ?? 10) - elapsed);
    } else {
      result += STEP_DURATIONS[step] ?? 10;
    }
  }
  return result;
}

export function cProgress(current, doneSet, stepStartTime = Date.now()) {
  const remaining = getRemainingSeconds(doneSet, stepStartTime);
  const doneCount = doneSet.size;
  const total = PROGRESS_STEPS.length;
  const timeStr = remaining >= 60
    ? `${Math.floor(remaining / 60)}분 ${remaining % 60}초`
    : `${remaining}초`;
  const lines = [
    `## ${EMOJI.PROGRESS} 회고 제출 중`,
    `-# ${pgBar(doneCount, total)}  ${doneCount} / ${total} 단계 · 잔여 약 ${timeStr}`,
    '',
  ];
  for (const step of PROGRESS_STEPS) {
    if (doneSet.has(step)) lines.push(`${EMOJI.DONE}  ${step}`);
    else if (step === current) lines.push(`${EMOJI.PROGRESS}  **${step}**`);
    else lines.push(`${EMOJI.PENDING}  ${step}`);
  }
  return new ContainerBuilder()
    .setAccentColor(0x5865F2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cancel_reflection').setLabel('회고 중지').setStyle(ButtonStyle.Danger)
      )
    );
}

export function cResult(success, title, desc) {
  return new ContainerBuilder()
    .setAccentColor(success ? 0x57F287 : 0xED4245)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${success ? EMOJI.DONE : EMOJI.ERROR} ${title}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(desc));
}

export function cInfo(title, desc = '', withCancel = false) {
  const text = desc ? `## ${title}\n-# ${desc}` : `## ${title}`;
  const c = new ContainerBuilder()
    .setAccentColor(0x5865F2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  if (withCancel) {
    c.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cancel_reflection').setLabel('회고 중지').setStyle(ButtonStyle.Danger)
      )
    );
  }
  return c;
}

export function cPreview(topic, reflection, retryLeft = 3, secondsLeft = null) {
  const preview = reflection.length > 350 ? reflection.slice(0, 350) + '...' : reflection;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('preview_confirm').setLabel('이대로 제출').setStyle(ButtonStyle.Success),
  );
  if (retryLeft > 0) {
    row.addComponents(
      new ButtonBuilder().setCustomId('preview_regenerate').setLabel(`다시 생성 (${retryLeft}회 남음)`).setStyle(ButtonStyle.Secondary),
    );
  }
  row.addComponents(
    new ButtonBuilder().setCustomId('preview_cancel').setLabel('취소').setStyle(ButtonStyle.Danger),
  );
  const footerText = secondsLeft !== null
    ? `-# 전체 ${reflection.length}자 · ⏱️ ${secondsLeft}초 후 자동 제출`
    : `-# 전체 ${reflection.length}자`;
  return new ContainerBuilder()
    .setAccentColor(0x5865F2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `## 📝 회고 미리보기\n📌 **${topic}**\n\n> ${preview}`
    ))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(footerText))
    .addActionRowComponents(row);
}

export function buildCalendarText(year, month, submittedDates) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDay = new Date(year, month - 1, 1).getDay();
  const offset = firstDay === 0 ? 6 : firstDay - 1;

  const prefix = `${year}-${String(month).padStart(2, '0')}-`;
  const submittedSet = new Set(
    submittedDates
      .map(e => typeof e === 'string' ? e : e.date)
      .filter(d => d.startsWith(prefix))
      .map(d => parseInt(d.slice(-2)))
  );

  let cells = Array(offset).fill('    ');
  for (let d = 1; d <= daysInMonth; d++) {
    const mark = submittedSet.has(d) ? '●' : ' ';
    cells.push(mark + String(d).padStart(3, ' '));
  }

  const rows = ['월   화   수   목   금   토   일'];
  for (let i = 0; i < cells.length; i += 7) {
    rows.push(cells.slice(i, i + 7).join(' '));
  }

  const count = submittedSet.size;
  return '```\n' + rows.join('\n') + '\n```\n' +
    `-# ● 제출 완료 · 이번 달 ${count > 0 ? `${count}회` : '제출 없음'}`;
}

export function buildHistoryContainer(userId, year, month) {
  const history = getSubmissionHistory(userId);
  const calText = buildCalendarText(year, month, history);
  const totalCount = history.length;

  const now = getNowKST();
  const prevDate = new Date(year, month - 2, 1);
  const nextDate = new Date(year, month, 1);
  const [py, pm] = [prevDate.getFullYear(), prevDate.getMonth() + 1];
  const [ny, nm] = [nextDate.getFullYear(), nextDate.getMonth() + 1];

  const nextIsFuture = ny > now.getFullYear() || (ny === now.getFullYear() && nm > now.getMonth() + 1);

  return new ContainerBuilder()
    .setAccentColor(0x5865F2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `## 📅 ${year}년 ${month}월 회고 히스토리\n${calText}\n-# 전체 누적 ${totalCount}회`
    ))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`history_${py}_${String(pm).padStart(2, '0')}`)
          .setLabel(`◀  ${py}년 ${pm}월`)
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`history_${ny}_${String(nm).padStart(2, '0')}`)
          .setLabel(`${ny}년 ${nm}월  ▶`)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(nextIsFuture),
      )
    );
}
