import {
  Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder,
  AttachmentBuilder, ContainerBuilder, TextDisplayBuilder, SeparatorBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ButtonBuilder, ButtonStyle,
} from 'discord.js';
import PQueue from 'p-queue';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config as dotenvConfig } from 'dotenv';
import { createServer } from 'http';
import { submitReflection, resetReflection, getTasksWithToken, browserCreateTask, browserCreateSchedule } from './automation.js';
import {
  loadUsers, saveUser, saveThankConfig, getThankConfig, savePremiumSettings, getPremiumSettings,
  deleteUser, getUser, getSubmissionHistory, addSubmissionHistory, hasSubmittedFor, removeSubmissionHistory,
  getStreak, updateBestStreak, getRecentTopics, addRecentTopic, trackApi, getApiStats,
} from './lib/data.js';
import {
  ADMIN_IDS, isAdmin, isStealthUser, loadKeys, saveKeys, isSuspended, isActivated,
  isProOrAbove, isPremiumUser, purgeExpiredKeys, keyRemainingStr, generateKey,
  activateUserDirect, revokeUser, activateUser,
} from './lib/keys.js';
import {
  CV2, CV2E, PROGRESS_STEPS, STEP_MAP, THANK_TYPES, EMOJI,
  getNowKST, getTodayKST, cProgress, cResult, cInfo, cPreview,
  buildCalendarText, buildHistoryContainer,
} from './lib/ui.js';
import {
  generateWithRetry, generateTopicFromKeywords, generateTopic,
  generateReflection, generateThankMessage, extractTopic, extractReflection,
} from './lib/ai.js';
import { sendCmdLog, sendAdminLog, sendExpiryLog, REFLECTION_LOG_WEBHOOK } from './lib/webhooks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: join(__dirname, '.env'), override: true });

// Modal/슬래시 명령어만 사용하므로 Guilds 인텐트만 필요
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User],
});


const queue = new PQueue({ concurrency: 3 });
const activeReflections = new Map(); // userId → submitted interaction
const pendingPreviews = new Map();   // userId → resolve function
const pendingLogs = new Map();       // userId → { steps, error }
const pendingTaskSelections = new Map(); // userId → { tasks, exp }
const taskTokenCache = new Map();        // userId → { token, exp }
const pendingDirectKey = new Map();      // adminId → { plan, days }


const STREAK_MILESTONES = new Set([7, 14, 30, 50, 100]);

async function checkStreakMilestone(userId) {
  const streak = getStreak(userId);
  updateBestStreak(userId);
  if (!STREAK_MILESTONES.has(streak)) return;
  const msgs = {
    7:   ['🔥 7일 연속 달성!',   '일주일 내내 빠짐없이 회고했어요. 꾸준함이 성장의 비결이에요!'],
    14:  ['🔥 14일 연속 달성!',  '2주 연속! 벌써 습관이 잡혀가고 있어요. 대단해요!'],
    30:  ['🏆 30일 연속 달성!',  '한 달 내내 회고를 이어갔어요. 정말 놀라운 꾸준함이에요!'],
    50:  ['🏆 50일 연속 달성!',  '무려 50일! 이미 회고가 일상이 된 거예요. 👏'],
    100: ['👑 100일 연속 달성!', '100일을 이어왔어요. 진짜 전설적인 기록이에요! 🎉'],
  };
  const [title, desc] = msgs[streak];
  try {
    const dUser = await client.users.fetch(userId);
    await dUser.send({
      components: [
        new ContainerBuilder()
          .setAccentColor(0xF1C40F)
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `## ${title}\n${desc}\n\n-# 연속 ${streak}일 달성 · Daymark`
          )),
      ],
      flags: CV2,
    });
  } catch (e) { console.error('[마일스톤 DM 실패]', userId, e.message); }
}


// ── 오류 채널 알림 헬퍼 ───────────────────────────────────────────────
async function notifyErrorChannel(userId, error) {
  if (!process.env.ERROR_CHANNEL_ID) return;
  try {
    const ch = await client.channels.fetch(process.env.ERROR_CHANNEL_ID);
    const base = `⚠️ **회고 오류 발생**\n유저: <@${userId}>\n오류: \`${error.message.slice(0, 500)}\``;
    if (error.screenshotBuffer) {
      const att = new AttachmentBuilder(error.screenshotBuffer, { name: 'error-screenshot.png' });
      await ch.send({ content: base, files: [att] });
    } else if (error.screenshotError) {
      await ch.send({ content: `${base}\n📵 스크린샷 캡처도 실패: \`${error.screenshotError}\`` });
    } else {
      await ch.send({ content: base });
    }
  } catch (e) {
    console.error('오류 채널 전송 실패:', e.message);
  }
}


// ── 점 애니메이션 ─────────────────────────────────────────────────────
function startDotAnimation(editFn, title, subtitle, flags = CV2E, withCancel = false) {
  let count = 1;
  let busy = false;
  const interval = setInterval(async () => {
    if (busy) return;
    busy = true;
    await editFn({
      components: [cInfo(title + '.'.repeat(count), subtitle, withCancel)],
      flags,
    }).catch(() => {});
    count = count >= 4 ? 1 : count + 1;
    busy = false;
  }, 600);
  return () => clearInterval(interval);
}

// 인터랙션 토큰 만료 시 DM으로 폴백
const TOKEN_EXPIRED_MSGS = ['Invalid Webhook Token', 'Unknown interaction', 'Interaction has already been acknowledged'];
function isTokenExpired(e) {
  return TOKEN_EXPIRED_MSGS.some(m => e?.message?.includes(m));
}
async function safeEditReply(submitted, payload, userId = null) {
  try {
    await submitted.editReply(payload);
  } catch (e) {
    if (!isTokenExpired(e)) throw e;
    if (userId) {
      try {
        const u = await client.users.fetch(userId);
        await u.send(payload);
      } catch {}
    }
  }
}

// ── 계정 Modal 공통 헬퍼 (/등록·/변경 공유) ──────────────────────────
async function showAccountModal(interaction, { isUpdate = false } = {}) {
  const existing = isUpdate ? getUser(interaction.user.id) : null;
  if (isUpdate && !existing) {
    return interaction.reply({
      components: [cResult(false, '등록된 계정 없음', '먼저 `/등록` 으로 계정을 등록해주세요.')],
      flags: CV2E,
    });
  }

  const emailInput = new TextInputBuilder()
    .setCustomId('email')
    .setLabel('이메일')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  if (existing) emailInput.setValue(existing.email);
  else emailInput.setPlaceholder('example@dgsw.hs.kr');

  const passwordInput = new TextInputBuilder()
    .setCustomId('password')
    .setLabel('비밀번호')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(isUpdate ? '새 비밀번호 입력' : '뉴로우 비밀번호')
    .setRequired(true);

  const customId = isUpdate ? 'account_modal_update' : 'account_modal_register';
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle(isUpdate ? '뉴로우 계정 변경' : '뉴로우 계정 등록')
    .addComponents(
      new ActionRowBuilder().addComponents(emailInput),
      new ActionRowBuilder().addComponents(passwordInput),
    );

  await interaction.showModal(modal);

  const submitted = await interaction.awaitModalSubmit({
    filter: (i) => i.customId === customId && i.user.id === interaction.user.id,
    time: 300_000,
  }).catch(() => null);
  if (!submitted) return;

  const email = submitted.fields.getTextInputValue('email').trim();
  const password = submitted.fields.getTextInputValue('password');
  saveUser(interaction.user.id, email, password);

  await submitted.reply({
    components: [cResult(true, isUpdate ? '계정 변경 완료' : '계정 등록 완료', `📧 \`${email}\`\n-# 정보는 암호화되어 안전하게 저장됩니다.`)],
    flags: CV2E,
  });
}

async function handleRegister(interaction) {
  if (getUser(interaction.user.id)) {
    return interaction.reply({
      components: [cResult(false, '이미 등록됨', '이미 계정이 등록되어 있어요.\n-# 계정 정보를 수정하려면 `/변경` 을 사용해주세요.')],
      flags: CV2E,
    });
  }
  return showAccountModal(interaction);
}
async function handleUpdate(interaction) { return showAccountModal(interaction, { isUpdate: true }); }

// ── /회고 ─────────────────────────────────────────────────────────────
async function handleReflection(interaction) {
  const user = getUser(interaction.user.id);
  if (!user) {
    return interaction.reply({
      components: [cResult(false, '계정 없음', '먼저 `/등록` 으로 계정을 등록해주세요.')],
      flags: CV2E,
    });
  }

  let topic = interaction.options.getString('주제');
  const dateInput = interaction.options.getString('날짜');

  // 날짜 파싱 및 검증
  let targetDate = null;
  if (dateInput) {
    const fullMatch = dateInput.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const shortMatch = dateInput.match(/^(\d{2})-(\d{2})$/);
    if (fullMatch) {
      targetDate = dateInput;
    } else if (shortMatch) {
      targetDate = `${getNowKST().getFullYear()}-${shortMatch[1]}-${shortMatch[2]}`;
    } else {
      return interaction.reply({
        components: [cResult(false, '날짜 형식 오류', '`YYYY-MM-DD` 또는 `MM-DD` 형식으로 입력해주세요.\n예: `2026-05-01` 또는 `05-01`')],
        flags: CV2E,
      });
    }
    // 미래 날짜 차단
    if (targetDate > getTodayKST()) {
      return interaction.reply({
        components: [cResult(false, '미래 날짜 불가', `미래 날짜의 회고는 제출할 수 없어요.\n📅 오늘: \`${getTodayKST()}\``)],
        flags: CV2E,
      });
    }
  }

  const isPastDate = targetDate && targetDate < getTodayKST();

  // 이미 진행 중인 회고가 있으면 차단 — 과거 날짜는 예외 (10분 초과 시 자동 해제)
  if (!isPastDate && activeReflections.has(interaction.user.id)) {
    const entry = activeReflections.get(interaction.user.id);
    const elapsedMs = Date.now() - (entry.startedAt ?? 0);
    const elapsedMin = Math.floor(elapsedMs / 60000);
    if (elapsedMs > 10 * 60 * 1000) {
      // 10분 이상 → stuck으로 간주하고 자동 해제
      clearInterval(entry.interval);
      activeReflections.delete(interaction.user.id);
      console.log(`[회고] ${interaction.user.id} — 잠금 10분 초과, 자동 해제 후 재시작`);
    } else {
      const cancelBtn = new ButtonBuilder()
        .setCustomId('cancel_reflection')
        .setLabel('회고 취소')
        .setStyle(ButtonStyle.Danger);
      const row = new ActionRowBuilder().addComponents(cancelBtn);
      const container = new ContainerBuilder()
        .setAccentColor(0xED4245)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          `## ${EMOJI.ERROR} 이미 진행 중\n회고가 이미 진행 중이에요.\n-# ${elapsedMin}분 전에 시작됨 • 완료 후 다시 시도하거나 취소 버튼을 눌러주세요.`
        ))
        .addActionRowComponents(row);
      return interaction.reply({ components: [container], flags: CV2E });
    }
  }

  // 미등록 유저는 주제 필수 (AI 주제 추천 불가)
  if (!topic && !isProOrAbove(interaction.user.id)) {
    return interaction.reply({
      components: [cResult(false, '주제를 입력해주세요', '`/회고 주제:오늘 배운 것` 처럼 주제를 직접 입력해주세요.')],
      flags: CV2E,
    });
  }

  // 주말 차단 — 오늘 날짜 회고만 (과거 날짜 지정 시 주말이어도 허용)
  if (!targetDate || targetDate === getTodayKST()) {
    const _dow = new Date(getTodayKST() + 'T00:00:00Z').getUTCDay();
    if (_dow === 0 || _dow === 6) {
      return interaction.reply({
        components: [cResult(false, '주말 휴식 중', '주말에는 오늘 회고를 쉬어요. 월요일에 다시 만나요! 😊\n-# 과거 날짜 회고는 `날짜` 옵션으로 가능해요.')],
        flags: CV2E,
      });
    }
  }

  // 미래 날짜 차단
  const checkDate = targetDate ?? getTodayKST();
  if (checkDate > getTodayKST()) {
    return interaction.reply({
      components: [cResult(false, '미래 날짜 불가', `📅 **${checkDate}** 는 아직 오지 않은 날짜예요.\n-# 오늘 또는 과거 날짜만 제출할 수 있어요.`)],
      flags: CV2E,
    });
  }

  // 중복 제출 방지 체크 (Feature 8)
  if (hasSubmittedFor(interaction.user.id, checkDate)) {
    return interaction.reply({
      components: [cResult(false, '이미 제출됨', `📅 **${checkDate}** 날짜의 회고는 이미 제출됐어요.\n-# 다른 날짜로 제출하려면 \`날짜\` 옵션을 사용해주세요.`)],
      flags: CV2E,
    });
  }

  // 감사 카드 설정 — 저장된 설정 있으면 모달 스킵
  const savedThank = getThankConfig(interaction.user.id);
  let thankConfig;
  let submitted;

  const isProUser = isProOrAbove(interaction.user.id);

  if (savedThank) {
    thankConfig = { ...savedThank };
    submitted = {
      editReply: (opts) => interaction.editReply(opts),
      reply: (opts) => interaction.reply(opts),
      user: interaction.user,
    };
  } else {
    const premSettings = getPremiumSettings(interaction.user.id);
    const defaultThankType = (isPremiumUser(interaction.user.id) && premSettings.thankTargetName) ? '친구' : '자신';
    const defaultThankName = (isPremiumUser(interaction.user.id) && premSettings.thankTargetName) ? premSettings.thankTargetName : '';

    const modalComponents = [
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('thank_type')
          .setLabel('받는 사람 유형')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('선생님 / 친구 / 자신')
          .setValue(defaultThankType)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('thank_name')
          .setLabel('받는 사람 이름 (자신이면 비워도 돼요)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('예: 홍길동')
          .setValue(defaultThankName)
          .setRequired(false)
      ),
    ];

    if (!isProUser) {
      modalComponents.push(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('thank_message')
            .setLabel('감사 메시지')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('오늘도 수고하셨어요!')
            .setRequired(true)
        ),
      );
    }

    const modal = new ModalBuilder()
      .setCustomId('reflection_modal')
      .setTitle('감사 카드 설정')
      .addComponents(...modalComponents);

    await interaction.showModal(modal);

    submitted = await interaction.awaitModalSubmit({
      filter: (i) => i.customId === 'reflection_modal' && i.user.id === interaction.user.id,
      time: 300_000,
    }).catch(() => null);
    if (!submitted) return;

    const thankType = submitted.fields.getTextInputValue('thank_type').trim();
    const thankName = submitted.fields.getTextInputValue('thank_name').trim();
    const thankMessage = isProUser ? '' : submitted.fields.getTextInputValue('thank_message').trim();

    if (!THANK_TYPES.has(thankType)) {
      return submitted.reply({
        components: [cResult(false, '유형 오류', '받는 사람 유형은 **선생님**, **친구**, **자신** 중 하나로 입력해주세요.')],
        flags: CV2E,
      });
    }

    if (!isPremiumUser(interaction.user.id) && thankType !== '자신') {
      return submitted.reply({
        components: [cResult(false, '등록 필요', '먼저 `/등록` 으로 계정을 등록해주세요.')],
        flags: CV2E,
      });
    }

    thankConfig = { type: thankType, name: thankName, message: thankMessage };
    saveThankConfig(interaction.user.id, thankConfig);
  }

  const _stealthKeys = loadKeys().stealth || {};
  const _userKey = loadKeys().activated[interaction.user.id] || '';
  const isStealth = !!_stealthKeys[_userKey];

  const queueSize = queue.size;
  const wasWaiting = queueSize > 0;
  await submitted.reply({
    components: [wasWaiting
      ? cInfo(`${EMOJI.PENDING} 대기 중  (${queueSize}명)`, `내 순서까지 잠시만 기다려주세요.`, true)
      : cInfo(`${EMOJI.PROGRESS} AI 회고 준비 중`, '주제와 회고 내용을 생성하고 있어요.', true)
    ],
    flags: CV2E,
  });

  const queuePriority = isStealth ? 2 : isProOrAbove(interaction.user.id) ? 1 : 0;
  const progressLog = [];
  activeReflections.set(interaction.user.id, { submitted, interval: null, startedAt: Date.now() });
  let countdownInterval;

  try {
    // ── Phase 1: AI 생성 (큐 적용) ──
    const recentTopics = getRecentTopics(interaction.user.id);
    const genResult = await queue.add(async () => {
      if (wasWaiting) {
        try {
          const dm = await interaction.user.createDM();
          await dm.send({ components: [cInfo('🔔 내 차례가 됐어요!', 'AI 회고 자동화가 곧 시작돼요.')], flags: CV2 });
        } catch {}
      }
      let genTopic = topic;
      if (!genTopic) {
        await submitted.editReply({
          components: [cInfo(`${EMOJI.SEARCH} 주제 추천 중.`, 'AI가 오늘의 학습 주제를 고르고 있어요.', true)],
          flags: CV2,
        });
        const stopTopic = startDotAnimation(
          opts => submitted.editReply(opts),
          `${EMOJI.SEARCH} 주제 추천 중`,
          'AI가 오늘의 학습 주제를 고르고 있어요.',
          CV2, true,
        );
        genTopic = await generateTopic(recentTopics);
        trackApi(interaction.user.id, 'topic');
        stopTopic();
      }
      await submitted.editReply({
        components: [cInfo(`${EMOJI.PROGRESS} AI 회고 생성 중.`, `📌 ${genTopic}`, true)],
        flags: CV2,
      });
      const stopReflection = startDotAnimation(
        opts => submitted.editReply(opts),
        `${EMOJI.PROGRESS} AI 회고 생성 중`,
        `📌 ${genTopic}`, CV2, true,
      );
      let genReflection = await generateReflection(genTopic);
      for (let i = 0; i < 2 && genReflection.length < 200; i++) {
        if (!isStealth) console.log(`[회고 생성] ${genReflection.length}자 — 200자 미만, 재시도 ${i + 1}`);
        genReflection = await generateReflection(genTopic);
      }
      trackApi(interaction.user.id, 'reflection');
      stopReflection();
      let genThankConfig = thankConfig;
      if (isProUser) {
        try {
          genThankConfig = { ...thankConfig, message: await generateThankMessage(genTopic, genReflection, thankConfig.type, thankConfig.name) };
        } catch { genThankConfig = { ...thankConfig, message: '오늘도 수고했어!' }; }
      }
      return { topic: genTopic, reflection: genReflection, thankConfig: genThankConfig };
    }, { priority: queuePriority });

    topic = genResult.topic;
    let reflection = genResult.reflection;
    thankConfig = genResult.thankConfig;

    // ── Phase 2: 미리보기 (큐 없음) ──
    const MAX_PREVIEW_RETRIES = 3;
    let previewRetryCount = 0;
    while (true) {
      const retryLeft = MAX_PREVIEW_RETRIES - previewRetryCount;
      let previewSecondsLeft = 60;
      await submitted.editReply({ components: [cPreview(topic, reflection, retryLeft, previewSecondsLeft)], flags: CV2 });
      let previewCountdown = null;
      const choice = await new Promise((resolve) => {
        const wrappedResolve = (val) => { clearInterval(previewCountdown); resolve(val); };
        pendingPreviews.set(interaction.user.id, wrappedResolve);
        previewCountdown = setInterval(async () => {
          previewSecondsLeft -= 5;
          await submitted.editReply({ components: [cPreview(topic, reflection, retryLeft, previewSecondsLeft)], flags: CV2 }).catch(() => {});
        }, 5_000);
        setTimeout(() => { if (pendingPreviews.delete(interaction.user.id)) wrappedResolve('timeout'); }, 60_000);
      });
      if (choice === 'preview_confirm' || choice === 'timeout') break;
      if (choice === 'preview_cancel') {
        activeReflections.delete(interaction.user.id);
        await submitted.editReply({ components: [cResult(false, '회고 취소됨', '회고를 취소했어요.')], flags: CV2 }).catch(() => {});
        return;
      }
      // 다시 생성 (재생성은 큐 없이 바로 실행)
      previewRetryCount++;
      await submitted.editReply({
        components: [cInfo(`${EMOJI.SEARCH} 다시 생성 중.`, `${previewRetryCount} / ${MAX_PREVIEW_RETRIES}회 재생성`)],
        flags: CV2,
      });
      const stopRegen = startDotAnimation(
        opts => submitted.editReply(opts),
        `${EMOJI.SEARCH} 다시 생성 중`,
        `${previewRetryCount} / ${MAX_PREVIEW_RETRIES}회 재생성`, CV2,
      );
      topic = await generateTopic(recentTopics);
      trackApi(interaction.user.id, 'topic');
      reflection = await generateReflection(topic);
      for (let i = 0; i < 2 && reflection.length < 200; i++) reflection = await generateReflection(topic);
      trackApi(interaction.user.id, 'reflection');
      stopRegen();
    }

    // ── Phase 3: 제출 (큐 없음) ──
    let currentStep = PROGRESS_STEPS[0];
    const doneSet = new Set();
    let stepStartTime = Date.now();
    let countdownBusy = false;
    const onProgress = async (step) => {
      progressLog.push(step);
      const mapped = STEP_MAP[step] ?? step;
      if (currentStep && currentStep !== mapped) {
        doneSet.add(currentStep);
        const fromIdx = PROGRESS_STEPS.indexOf(currentStep);
        const toIdx   = PROGRESS_STEPS.indexOf(mapped);
        if (fromIdx !== -1 && toIdx > fromIdx + 1) {
          for (let i = fromIdx + 1; i < toIdx; i++) doneSet.add(PROGRESS_STEPS[i]);
        }
      }
      currentStep = mapped;
      stepStartTime = Date.now();
      await submitted.editReply({ components: [cProgress(currentStep, doneSet, stepStartTime)], flags: CV2 }).catch(() => {});
    };
    const onWarning = async () => {};
    let result;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt > 1) {
        clearInterval(countdownInterval);
        if (!activeReflections.has(interaction.user.id)) return;
        await submitted.editReply({ components: [cInfo('⚠️ 일시적 오류 — 재시도 중...', '잠시 후 다시 시도할게요.')], flags: CV2 }).catch(() => {});
        await new Promise(r => setTimeout(r, 3000));
        if (!activeReflections.has(interaction.user.id)) return;
        currentStep = PROGRESS_STEPS[0];
        doneSet.clear();
        stepStartTime = Date.now();
        countdownBusy = false;
      }
      await submitted.editReply({ components: [cProgress(currentStep, doneSet, stepStartTime)], flags: CV2 });
      clearInterval(countdownInterval);
      countdownInterval = setInterval(async () => {
        if (countdownBusy) return;
        countdownBusy = true;
        await submitted.editReply({ components: [cProgress(currentStep, doneSet, stepStartTime)], flags: CV2 }).catch(() => {});
        countdownBusy = false;
      }, 1_000);
      const entry = activeReflections.get(interaction.user.id);
      if (entry) entry.interval = countdownInterval;
      if (!activeReflections.has(interaction.user.id)) {
        await submitted.editReply({ components: [cResult(false, '회고 중지됨', '회고가 중지됐어요.')], flags: CV2 }).catch(() => {});
        return;
      }
      try {
        result = await submitReflection(reflection, user.email, user.password, topic, targetDate, onProgress, onWarning, thankConfig, isStealth);
        break;
      } catch (err) {
        if (attempt < 2) {
          if (!isStealth) console.error('[자동화] 1차 시도 실패 — 재시도 예정:', err.message);
        } else { throw err; }
      }
    }

    const dateLabel = targetDate ?? getTodayKST();
    clearInterval(countdownInterval);
    if (!activeReflections.has(interaction.user.id)) return;
    if (result === 'already_done') {
      addSubmissionHistory(interaction.user.id, dateLabel);
      await submitted.editReply({ components: [cResult(true, '이미 완료됨', `📅 **${dateLabel}** 회고는 이미 완료되어 있어요.`)], flags: CV2 });
      return;
    }
    const completionScreenshot = result?.screenshot ?? null;
    addRecentTopic(interaction.user.id, topic);
    addSubmissionHistory(interaction.user.id, dateLabel, topic, reflection);
    checkStreakMilestone(interaction.user.id).catch(() => {});
    const contentPreview = reflection.length > 400 ? reflection.slice(0, 400) + '...' : reflection;
    await submitted.editReply({
      components: [cResult(true, '회고 완료', `📅 **${dateLabel}**  ·  📌 ${topic}\n\n> ${contentPreview}\n\n-# Daymark · 자동 제출 완료`)],
      flags: CV2,
    });
    interaction.user.send({
      content: `✅ **회고 완료!**\n📅 \`${dateLabel}\`  ·  📌 ${topic}\n\n> ${contentPreview}\n\n-# Daymark · 자동 제출 완료`,
      ...(completionScreenshot ? { files: [{ attachment: completionScreenshot, name: 'completion.png' }] } : {}),
    }).catch(e => console.error('[DM] 전송 실패:', e.message));
    if (isStealth) return;
    const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
    const discordUser = interaction.user;
    const webhookPayload = {
      content: `<@${discordUser.id}>`,
      allowed_mentions: { users: [discordUser.id] },
      embeds: [{ title: '✅ 회고 완료', color: 0x57F287, fields: [
        { name: '유저', value: `${discordUser.username} (\`${discordUser.id}\`)`, inline: true },
        { name: '날짜', value: dateLabel, inline: true },
        { name: '주제', value: topic, inline: true },
        { name: '시간', value: now, inline: false },
      ], ...(completionScreenshot ? { image: { url: 'attachment://completion.png' } } : {}) }],
    };
    if (completionScreenshot) {
      const formData = new FormData();
      formData.append('payload_json', JSON.stringify(webhookPayload));
      formData.append('files[0]', new Blob([completionScreenshot], { type: 'image/png' }), 'completion.png');
      fetch(REFLECTION_LOG_WEBHOOK, { method: 'POST', body: formData })
        .then(r => { if (!r.ok) r.text().then(t => console.error('[웹훅] 로그 실패:', r.status, t)); })
        .catch(e => console.error('[웹훅] 로그 전송 오류:', e.message));
    } else {
      fetch(REFLECTION_LOG_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(webhookPayload) })
        .then(r => { if (!r.ok) r.text().then(t => console.error('[웹훅] 로그 실패:', r.status, t)); })
        .catch(e => console.error('[웹훅] 로그 전송 오류:', e.message));
    }
  } catch (error) {
    console.error(error);
    const rawMsg = error?.message ?? String(error);
    // Playwright call log 제거 — "Timeout Nms exceeded.\nCall log:\n  - waiting for..." → 첫 줄만
    const errMsg = rawMsg.includes('Call log:')
      ? rawMsg.split('\n')[0].trim()
      : rawMsg.split('\n')[0].trim();
    pendingLogs.set(interaction.user.id, { steps: progressLog, error: rawMsg });
    const errContainer = new ContainerBuilder()
      .setAccentColor(0xED4245)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `## ${EMOJI.ERROR} 오류 발생\n> ${errMsg.slice(0, 200)}\n\n-# 문제가 반복되면 관리자에게 문의해 주세요.`
      ))
      .addActionRowComponents(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('view_log').setLabel('자세히 보기').setStyle(ButtonStyle.Secondary)
      ));
    if (!isStealth) {
      if (isTokenExpired(error)) {
        try {
          const u = await client.users.fetch(interaction.user.id);
          await u.send({ content: '⚠️ 응답 시간이 초과돼 결과를 채팅창에 표시하지 못했어요. 잠시 후 다시 시도해 주세요.', flags: CV2 });
        } catch {}
      } else {
        await submitted.editReply({ components: [errContainer], flags: CV2 }).catch(() => {});
      }
    }
    // 오류 발생 시 /회고초기화 안내 DM (스텔스 포함 전체)
    try {
      const u = await client.users.fetch(interaction.user.id);
      await u.send({ content: '⚠️ 회고 중 오류가 발생했어요.\n`/회고초기화` 명령어로 오늘 회고를 초기화한 후 다시 시도해 주세요.' });
    } catch {}
    await notifyErrorChannel(interaction.user.id, error);
  } finally {
    clearInterval(countdownInterval);
    activeReflections.delete(interaction.user.id);
  }
}

// ── /히스토리 ─────────────────────────────────────────────────────────
async function handleReflectionReset(interaction) {
  const user = getUser(interaction.user.id);
  if (!user) {
    return interaction.reply({
      components: [cResult(false, '계정 없음', '먼저 `/등록` 으로 계정을 등록해주세요.')],
      flags: CV2E,
    });
  }

  const dateInput = interaction.options.getString('날짜');
  let targetDate = null;
  if (dateInput) {
    const fullMatch = dateInput.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const shortMatch = dateInput.match(/^(\d{2})-(\d{2})$/);
    if (fullMatch) targetDate = dateInput;
    else if (shortMatch) targetDate = `${getNowKST().getFullYear()}-${shortMatch[1]}-${shortMatch[2]}`;
    else return interaction.reply({
      components: [cResult(false, '날짜 형식 오류', '`YYYY-MM-DD` 또는 `MM-DD` 형식으로 입력해주세요.')],
      flags: CV2E,
    });
  }
  const dateLabel = targetDate ?? getTodayKST();

  const confirmBtn = new ButtonBuilder()
    .setCustomId(`reset_confirm:${interaction.user.id}:${dateLabel}`)
    .setLabel('초기화')
    .setStyle(ButtonStyle.Danger);
  const cancelBtn = new ButtonBuilder()
    .setCustomId('reset_cancel')
    .setLabel('취소')
    .setStyle(ButtonStyle.Secondary);

  return interaction.reply({
    components: [
      new ContainerBuilder()
        .setAccentColor(0xED4245)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          `## ⚠️ 회고 초기화\n📅 **${dateLabel}** 회고를 초기화하면 작성된 내용이 모두 삭제됩니다.\n정말 초기화하시겠어요?`
        ))
        .addActionRowComponents(new ActionRowBuilder().addComponents(confirmBtn, cancelBtn)),
    ],
    flags: CV2E,
  });
}

async function handleHistory(interaction) {
  if (!getUser(interaction.user.id)) {
    return interaction.reply({
      components: [cResult(false, '계정 없음', '먼저 `/등록` 으로 계정을 등록해주세요.')],
      flags: CV2E,
    });
  }
  const now = getNowKST();
  return interaction.reply({
    components: [buildHistoryContainer(interaction.user.id, now.getFullYear(), now.getMonth() + 1)],
    flags: CV2E,
  });
}

// ── /기록 ──────────────────────────────────────────────────────────────
async function handleRecords(interaction) {
  if (!getUser(interaction.user.id)) {
    return interaction.reply({
      components: [cResult(false, '계정 없음', '먼저 `/등록` 으로 계정을 등록해주세요.')],
      flags: CV2E,
    });
  }
  const page = Math.max(1, interaction.options.getInteger('페이지') ?? 1);
  const PAGE_SIZE = 5;
  const history = getSubmissionHistory(interaction.user.id)
    .filter(e => typeof e === 'object' && e.topic); // 내용 있는 것만

  if (history.length === 0) {
    return interaction.reply({
      components: [cResult(false, '기록 없음', '아직 제출된 회고 기록이 없어요.')],
      flags: CV2E,
    });
  }

  const totalPages = Math.ceil(history.length / PAGE_SIZE);
  const clampedPage = Math.min(page, totalPages);
  const slice = history.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);

  const lines = slice.map(e => {
    const preview = (e.content ?? '').length > 100 ? e.content.slice(0, 100) + '...' : (e.content ?? '내용 없음');
    return `### 📅 ${e.date} · 📌 ${e.topic}\n> ${preview}`;
  }).join('\n\n');

  const container = new ContainerBuilder()
    .setAccentColor(0x5865F2)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## 📋 회고 기록 (${clampedPage}/${totalPages} 페이지)\n\n${lines}\n\n-# 총 ${history.length}건 · \`/기록 페이지:${clampedPage}\` 로 조회 중`
      )
    );

  if (totalPages > 1) {
    const row = new ActionRowBuilder();
    if (clampedPage > 1)
      row.addComponents(new ButtonBuilder().setCustomId(`records_${clampedPage - 1}`).setLabel('◀ 이전').setStyle(ButtonStyle.Secondary));
    if (clampedPage < totalPages)
      row.addComponents(new ButtonBuilder().setCustomId(`records_${clampedPage + 1}`).setLabel('다음 ▶').setStyle(ButtonStyle.Secondary));
    container.addActionRowComponents(row);
  }

  return interaction.reply({ components: [container], flags: CV2E });
}

// ── /감사카드 ──────────────────────────────────────────────────────────
async function handleThankConfig(interaction) {
  if (!getUser(interaction.user.id)) {
    return interaction.reply({
      components: [cResult(false, '계정 없음', '/등록 명령어로 먼저 등록해주세요.')],
      flags: CV2E,
    });
  }

  const existing = getThankConfig(interaction.user.id);
  const modal = new ModalBuilder()
    .setCustomId('thank_config_modal')
    .setTitle('감사 카드 설정')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('thank_type')
          .setLabel('받는 사람 유형')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('선생님 / 친구 / 자신')
          .setValue(existing?.type ?? '자신')
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('thank_name')
          .setLabel('받는 사람 이름 (자신이면 비워도 돼요)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('예: 홍길동')
          .setValue(existing?.name ?? '')
          .setRequired(false)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('thank_message')
          .setLabel('감사 메시지')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('오늘도 수고하셨어요!')
          .setValue(existing?.message ?? '')
          .setRequired(true)
      ),
    );

  await interaction.showModal(modal);

  const submitted = await interaction.awaitModalSubmit({
    filter: (i) => i.customId === 'thank_config_modal' && i.user.id === interaction.user.id,
    time: 300_000,
  }).catch(() => null);
  if (!submitted) return;

  const thankType = submitted.fields.getTextInputValue('thank_type').trim();
  const thankName = submitted.fields.getTextInputValue('thank_name').trim();
  const thankMessage = submitted.fields.getTextInputValue('thank_message').trim();

  if (!THANK_TYPES.has(thankType)) {
    return submitted.reply({
      components: [cResult(false, '유형 오류', '받는 사람 유형은 **선생님**, **친구**, **자신** 중 하나로 입력해주세요.')],
      flags: CV2E,
    });
  }

  if (!isPremiumUser(interaction.user.id) && thankType !== '자신') {
    return submitted.reply({
      components: [cResult(false, '플랜 제한', '**친구** / **선생님**에게 보내는 감사카드는 프리미엄 전용이에요.\n-# 일반 유저는 **자신**만 선택할 수 있어요.')],
      flags: CV2E,
    });
  }

  saveThankConfig(interaction.user.id, { type: thankType, name: thankName, message: thankMessage });

  const nameDisplay = thankName ? ` **(${thankName})**에게` : '';
  return submitted.reply({
    components: [cResult(true, '감사 카드 설정 완료', `💌 **${thankType}**${nameDisplay} 보내는 카드로 저장됐어요.\n\n> ${thankMessage}\n\n-# \`/회고\` 시 자동으로 적용됩니다.`)],
    flags: CV2E,
  });
}

// ── /통계 (프리미엄) ──────────────────────────────────────────────────
async function handleStats(interaction) {
  if (!isProOrAbove(interaction.user.id)) {
    return interaction.reply({
      components: [cResult(false, '등록 필요', '먼저 `/등록` 으로 계정을 등록해주세요.')],
      flags: CV2E,
    });
  }
  const userId = interaction.user.id;
  const history = getSubmissionHistory(userId);
  const now = getNowKST();
  const todayStr = getTodayKST();
  const monthPrefix = todayStr.slice(0, 7);

  // 이번 주 월요일 기준 (KST 날짜 문자열 비교로 timezone 오차 방지)
  const dayOfWeek = now.getDay() === 0 ? 6 : now.getDay() - 1; // 월=0
  const weekStartStr = new Date(now.getTime() - dayOfWeek * 86400000).toISOString().split('T')[0];

  const total = history.length;
  const thisMonth = history.filter(e => (typeof e === 'string' ? e : e.date).startsWith(monthPrefix)).length;
  const thisWeek = history.filter(e => (typeof e === 'string' ? e : e.date) >= weekStartStr).length;
  const streak = getStreak(userId);
  const users = loadUsers();
  const bestStreak = users[userId]?.bestStreak ?? streak;

  // 이번 달 달성률
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const passedDays = now.getDate();
  const monthRate = passedDays > 0 ? Math.round(thisMonth / passedDays * 100) : 0;

  // 주간 평균 (최근 4주) — KST 날짜 기준
  const fourWeeksAgoStr = new Date(now.getTime() - 28 * 86400000).toISOString().split('T')[0];
  const past28 = history.filter(e => (typeof e === 'string' ? e : e.date) >= fourWeeksAgoStr).length;
  const weeklyAvg = (past28 / 4).toFixed(1);

  return interaction.reply({
    components: [
      new ContainerBuilder()
        .setAccentColor(0xF1C40F)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('## 📊 내 회고 통계'))
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          `🔥  현재 스트릭: **${streak}일**\n` +
          `🏆  최고 스트릭: **${bestStreak}일**\n` +
          `📅  이번 주: **${thisWeek}회**\n` +
          `📅  이번 달: **${thisMonth}회** (달성률 ${monthRate}%)\n` +
          `📊  주간 평균: **${weeklyAvg}회** (최근 4주)\n` +
          `📋  전체 누적: **${total}회**`
        ))
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('-# Daymark 프리미엄')),
    ],
    flags: CV2E,
  });
}

// ── 할일 예약 헬퍼 ────────────────────────────────────────────────────
function getTaskName(t) {
  return t.title ?? t.taskTitle ?? t.name ?? `Task ${t.id ?? t.taskId}`;
}

async function createTaskAPI(token, title) {
  const res = await fetch('https://api-agw.newrrow.com/main/api/v1/tasks', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Tenant': 'dgsm',
      'Origin': 'https://dgsm.newrrow.com',
      'Accept': 'application/json, text/plain, */*',
    },
    body: JSON.stringify({ goalId: null, title }),
  });
  const data = await res.json();
  return { status: res.status, taskId: data.contents?.taskId ?? data.contents?.id ?? null };
}

async function createScheduleAPI(token, taskId, startDateTime, endDateTime) {
  const res = await fetch('https://api-agw.newrrow.com/main/api/v2/schedules', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Tenant': 'dgsm',
      'Origin': 'https://dgsm.newrrow.com',
      'Accept': 'application/json, text/plain, */*',
    },
    body: JSON.stringify({
      taskId: Number(taskId),
      isAllDay: false,
      startDateTime,
      endDateTime,
      endType: 'NONE',
      repeatEnabled: false,
      repeatType: 'NONE',
    }),
  });
  return res.status;
}

async function fetchAndCacheTasks(userId, email, password) {
  const { token, tasks } = await getTasksWithToken(email, password);
  taskTokenCache.set(userId, { token, exp: Date.now() + 5 * 60 * 1000 });
  pendingTaskSelections.set(userId, { tasks, exp: Date.now() + 5 * 60 * 1000 });
  return { token, tasks };
}

function buildTaskSelectMenu(tasks) {
  return new StringSelectMenuBuilder()
    .setCustomId('task_schedule_select')
    .setPlaceholder('예약할 할일 선택...')
    .addOptions(
      tasks.slice(0, 25).map(t =>
        new StringSelectMenuOptionBuilder()
          .setLabel(getTaskName(t).slice(0, 100))
          .setValue(String(t.id ?? t.taskId))
      )
    );
}


// ── /할일예약 ─────────────────────────────────────────────────────────
async function handleTaskSchedule(interaction, editReply = false) {
  if (!isProOrAbove(interaction.user.id)) {
    const payload = { components: [cResult(false, '등록 필요', '먼저 `/등록` 으로 계정을 등록해주세요.')], flags: CV2E };
    return editReply ? interaction.editReply(payload) : interaction.reply(payload);
  }
  const user = getUser(interaction.user.id);
  if (!user) {
    const payload = { components: [cResult(false, '계정 없음', '먼저 `/등록` 으로 계정을 등록해주세요.')], flags: CV2E };
    return editReply ? interaction.editReply(payload) : interaction.reply(payload);
  }

  const loadingPayload = { components: [cInfo('📋 할일 불러오는 중...', '잠시만 기다려주세요.')], flags: CV2E };
  if (editReply) await interaction.editReply(loadingPayload);
  else await interaction.reply(loadingPayload);

  try {
    const { tasks } = await fetchAndCacheTasks(interaction.user.id, user.email, user.password);
    const listText = tasks.length
      ? tasks.slice(0, 25).map((t, i) => `**${i + 1}.** ${getTaskName(t)}`).join('\n')
      : '-# 아직 할일이 없어요. 추가해보세요!';

    const container = new ContainerBuilder()
      .setAccentColor(0x5865F2)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 📅 할일 예약\n${listText}`))
      .addSeparatorComponents(new SeparatorBuilder())
      .addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('task_add_btn').setLabel('📝 할일 추가').setStyle(ButtonStyle.Success),
          ...(tasks.length ? [new ButtonBuilder().setCustomId('task_schedule_btn').setLabel('📅 예약하기').setStyle(ButtonStyle.Primary)] : []),
        ),
      );

    return interaction.editReply({ components: [container], flags: CV2E });
  } catch (e) {
    return interaction.editReply({ components: [cResult(false, '불러오기 실패', `오류: \`${e.message?.slice(0, 200)}\``)], flags: CV2E });
  }
}

// ── /사용법 ───────────────────────────────────────────────────────────
async function handleHelp(interaction) {
  await interaction.reply({
    components: [
      new ContainerBuilder()
        .setAccentColor(0x5865F2)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('## 📓 Daymark'))
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          '**🔵 Basic**\n' +
          '`/회고 주제:내용` — 주제 직접 입력 후 AI가 내용 생성·제출\n' +
          '`/회고초기화` — 오늘 회고 초기화\n' +
          '-# 매일 오후 8:40 미제출 시 알림 (Basic·Pro)'
        ))
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          '**⚡ Pro**\n' +
          '`/회고` — 주제 없이 실행 시 AI가 주제까지 자동 추천\n' +
          '`/계획하기` — 할일을 선택해 캘린더에 일정 등록\n' +
          '`/설정` → ⏰ 자동 회고 — 매일 설정한 시각에 자동 실행\n' +
          '-# 주간 요약 매주 일요일 자동 발송'
        ))
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          '**✨ Premium**\n' +
          '`/설정` → 📋 자동 계획 — 시간대 설정 시 매일 랜덤 시각에 자동 등록 (30일)\n' +
          '`/설정` → 📌 키워드 — 주제 추천 키워드 맞춤 설정\n' +
          '`/설정` → 💌 감사카드 — 감사 카드 수신자 설정\n' +
          '-# 월간 리포트 매월 1일 자동 발송'
        ))
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          '**👤 공통**\n' +
          '`/등록` — 최초 계정 등록\n' +
          '`/변경` — 이메일·비밀번호 수정\n' +
          '`/내정보` — 계정 정보·플랜·키 확인\n' +
          '`/키입력` — 구매 후 키 활성화\n' +
          '`/삭제` — 계정 삭제\n' +
          '`/주제추천` — AI 주제 3개 추천\n' +
          '`/히스토리` — 회고 달력\n' +
          '`/기록` — 회고 내용 조회\n' +
          '`/통계` — 스트릭·달성률 (⚡Pro 이상)\n' +
          '`/대기` — 현재 대기열 확인'
        ))
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          `-# 자가점검 · 하루돌아보기 · 회고작성 · 공유 · 감사카드 자동 처리 → 완료 ${EMOJI.DONE}`
        )),
    ],
    flags: CV2E,
  });
}

// ── /주제추천 ─────────────────────────────────────────────────────────
async function handleTopicSuggest(interaction) {
  await interaction.reply({
    components: [cInfo(`${EMOJI.SEARCH} 주제 추천 중.`, 'AI가 오늘의 학습 주제를 고르고 있어요.')],
    flags: CV2E,
  });
  const stopAnim = startDotAnimation(
    opts => interaction.editReply(opts),
    `${EMOJI.SEARCH} 주제 추천 중`,
    'AI가 오늘의 학습 주제를 고르고 있어요.',
    CV2E,
  );
  try {
    const premSettings = getPremiumSettings(interaction.user.id);
    const keywords = Array.isArray(premSettings.keywords) && premSettings.keywords.length > 0
      ? premSettings.keywords : null;

    let prompt;
    if (keywords) {
      prompt =
        `다음 키워드를 기반으로 개발 학습 회고에 쓸 구체적인 주제 3개를 추천해줘.\n` +
        `- 키워드: ${keywords.join(', ')}\n` +
        `- 키워드들을 조합하거나 각각 골라 구체적인 주제로\n` +
        `- 번호 없이 한 줄씩, 25자 이내, 한국어만`;
    } else {
      prompt =
        `개발을 막 배우기 시작한 고등학생의 전공 학습을 주제로 뉴로우 회고에 쓸 만한 구체적인 주제 3개를 추천해줘.\n` +
        `- 난이도: 기본~중급 수준 (기본 문법은 알고 있으며 클래스, 함수, 자료구조 등 응용 개념 학습 중)\n` +
        `- 반드시 특정 기술/개념을 포함할 것 (예: 자바 클래스와 객체 생성, JavaScript 배열 메서드, Python 함수 활용)\n` +
        `- 번호 없이 한 줄씩, 25자 이내, 한국어만\n` +
        `- 매번 다양한 분야에서 추천 (Java, JavaScript, Python, HTML/CSS, SQL, Git, 알고리즘 등)\n` +
        `- 너무 고급 개념 금지 (디자인패턴, 마이크로서비스, 최적화 등)`;
    }

    const result = await generateWithRetry(prompt, 30_000);
    const topics = result.response.text().trim()
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .slice(-3)
      .map((t, i) => `${['1️⃣', '2️⃣', '3️⃣'][i] ?? `**${i + 1}.**`}  ${t}`)
      .join('\n');
    const footerNote = keywords
      ? `-# 📌 키워드 기반 추천: ${keywords.join(', ')}`
      : '-# `/회고 주제:[주제]` 로 바로 사용해보세요!';
    stopAnim();
    await interaction.editReply({
      components: [
        new ContainerBuilder()
          .setAccentColor(keywords ? 0xF1C40F : 0x5865F2)
          .addTextDisplayComponents(new TextDisplayBuilder().setContent('## 💡 오늘의 회고 주제 추천'))
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(topics))
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(footerNote)),
      ],
      flags: CV2,
    });
  } catch (err) {
    stopAnim();
    console.error('[주제추천 오류]', err);
    await interaction.editReply({
      components: [cResult(false, '추천 실패', `주제 추천 중 오류가 발생했어요.\n-# ${err.message?.slice(0, 100) ?? '알 수 없는 오류'}`)],
      flags: CV2E,
    });
  }
}

// ── 관리자 ! 명령어 ───────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.partial) {
    try { await message.fetch(); } catch { return; }
  }
  if (message.channel?.partial) {
    try { await message.channel.fetch(); } catch {}
  }
  if (!message.author || message.author.bot) return;
  if (!message.content?.startsWith('!')) return;
  if (!isAdmin(message.author.id)) return;
  console.log(`[!명령어] userId=${message.author.id} content=${message.content}`);

  const [cmd, ...args] = message.content.slice(1).trim().split(/\s+/);

  const HELP_MSG =
    '**📋 관리자 명령어 목록**\n' +
    '-# 서버 채널 또는 DM에서 사용 가능 · 응답은 항상 DM으로 전송\n\n' +
    '`!` 또는 `!명령어` — 이 목록 보기\n\n' +
    '**키 관리**\n' +
    '`!키발급 [수량]` — 키 발급 후 available 풀에 추가 (3시간 유효)\n' +
    '`!키직접발급` — 유저 선택 → DM으로 키 전송\n' +
    '`!키목록` — 미사용 키 목록\n' +
    '`!사용중키` — 사용 중인 키 + 유저 목록\n' +
    '`!정지목록` — 정지된 키 목록\n' +
    '`!전체키` — 전체 키 현황\n' +
    '`!키삭제 <키>` — 키 삭제\n' +
    '`!키정지 <키>` — 키 정지\n' +
    '`!키정지해제 <키>` — 키 정지 해제\n' +
    '`!키상태 <유저ID>` — 특정 유저 키 상태 조회\n\n' +
    '**비밀키 관리**\n' +
    '`!비밀키발급` — 스텔스 키 발급 (로그 없음, 만료 없음)\n' +
    '`!전체비밀키` — 스텔스 키 목록 + 잔여 시간\n' +
    '`!비밀키삭제 <키>` — 스텔스 키 삭제\n\n' +
    '**계정 조회**\n' +
    '`!계정조회` — 등록된 전체 계정 목록\n' +
    '`!유저검색` — 드롭다운으로 유저 선택 후 계정 조회\n' +
    '`!계정검색 <이메일>` — 이메일로 계정 검색\n\n' +
    '**통계**\n' +
    '`!api` — 유저별 AI 생성 횟수 (누적)\n\n' +
    '**공지**\n' +
    '`!공지` — 서버 채널 공지 작성 팝업\n' +
    '`!DM공지` — 등록된 전체 유저에게 DM 공지\n\n' +
    '**회고 현황**\n' +
    '`!회고목록` — 날짜별 회고 완료/미완료 현황\n\n' +
    '**DM 관리**\n' +
    '`!DM삭제` — 유저 선택 후 봇이 보낸 DM 삭제';

  const SECRET_OWNER_ID = '1435515394436632668';

  if (cmd === '전체비밀키') {
    if (message.author.id !== SECRET_OWNER_ID) return;
    const keys = loadKeys();
    const stealth = keys.stealth ?? {};
    if (!Object.keys(stealth).length) return message.author.send('스텔스 키 없음.');
    const lines = await Promise.all(Object.keys(stealth).map(async k => {
      const uid = Object.entries(keys.activated).find(([, v]) => v === k)?.[0];
      const expiry = keys.expiry?.[k];
      let expiryStr = '';
      if (expiry) {
        const rem = expiry - Date.now();
        if (rem <= 0) expiryStr = ' *(만료)*';
        else {
          const h = Math.floor(rem / 3600000);
          const m = Math.floor((rem % 3600000) / 60000);
          expiryStr = ` *(${h}시간 ${m}분 남음)*`;
        }
      }
      if (!uid) return `\`${k}\`${expiryStr} — 미사용`;
      try {
        const u = await client.users.fetch(uid);
        return `\`${k}\`${expiryStr} — ${u.globalName ?? u.username}`;
      } catch { return `\`${k}\`${expiryStr} — \`${uid}\``; }
    }));
    return message.author.send(`**스텔스 키 ${lines.length}개**\n${lines.join('\n')}`);
  }

  if (cmd === '비밀키삭제') {
    if (message.author.id !== SECRET_OWNER_ID) return;
    const key = args[0];
    if (!key) return message.author.send('사용법: `!비밀키삭제 키값`');
    const keys = loadKeys();
    if (!keys.stealth?.[key]) return message.author.send(`\`${key}\` — 스텔스 키 없음.`);
    delete keys.stealth[key];
    const idx = keys.available.indexOf(key);
    if (idx !== -1) keys.available.splice(idx, 1);
    delete keys.expiry?.[key];
    saveKeys(keys);
    return message.author.send(`\`${key}\` 삭제 완료.`);
  }

  if (cmd === '비밀키발급') {
    if (message.author.id !== SECRET_OWNER_ID) return; // 무반응
    const keys = loadKeys();
    let key;
    do { key = generateKey(); } while (keys.available.includes(key));
    keys.available.push(key);
    keys.expiry[key] = Date.now() + KEY_TTL;
    keys.stealth = keys.stealth || {};
    keys.stealth[key] = true;
    saveKeys();
    return message.author.send(`🔒 **비밀 키 발급 완료**\n\`${key}\`\n-# 이 키로 /회고 시 로그 없음`);
  }

  const VALID_CMDS = new Set(['', '명령어', '키발급', '키목록', '사용중키', '정지목록', '전체키', '키삭제', '키정지', '키정지해제', '계정조회', '유저검색', '계정검색', 'api', '공지', '회고목록', 'DM삭제', '전체베이직', '전체만료', '키상태', '만료삭제', '등급설정', '전체등급', '전체비밀키', '비밀키삭제', '비밀키발급', '키직접발급', 'DM공지']);
  if (!VALID_CMDS.has(cmd)) return;

  try {
    sendAdminLog(message, cmd, args);
    message.react('✅').catch(() => {}); // fire-and-forget — await 하면 DM에서 hang 가능성

    // ! 또는 !명령어
    if (cmd === '' || cmd === '명령어') {
      await message.author.send(HELP_MSG);
      return;
    }

    // !키발급 [수량]
    if (cmd === '키발급') {
      const countArg = args.find(a => /^\d+$/.test(a));
      const count = Math.min(10, Math.max(1, parseInt(countArg) || 1));
      const keys = loadKeys();
      const newKeys = [];
      const expiresAt = Date.now() + KEY_TTL;
      for (let i = 0; i < count; i++) {
        let key;
        do { key = generateKey(); } while (keys.available.includes(key));
        keys.available.push(key);
        keys.expiry[key] = expiresAt;
        newKeys.push(key);
      }
      saveKeys();
      const lines = newKeys.map(k => `\`${k}\``).join('\n');
      return message.author.send(`🔑 **키 ${count}개 발급 완료** -# 3시간 내 미입력 시 만료\n${lines}\n-# 미사용 키: ${keys.available.length}개`);
    }

    // !키직접발급 [일수]
    if (cmd === '키직접발급') {
      const users = loadUsers();
      const userEntries = Object.entries(users);
      if (!userEntries.length) return message.author.send('등록된 유저가 없어요.');

      const options = [];
      for (const [uid, u] of userEntries) {
        let label = u.email;
        try {
          const dUser = await client.users.fetch(uid);
          label = dUser.globalName ?? dUser.username;
        } catch {}
        options.push(
          new StringSelectMenuOptionBuilder()
            .setLabel(`${label} (${u.email})`.slice(0, 100))
            .setValue(uid)
        );
      }

      pendingDirectKey.set(message.author.id, {});
      const menu = new StringSelectMenuBuilder()
        .setCustomId('direct_key_assign_select')
        .setPlaceholder('유저 선택...')
        .addOptions(options.slice(0, 25));
      const row = new ActionRowBuilder().addComponents(menu);
      return message.author.send({
        content: '키를 발급할 유저를 선택해주세요.',
        components: [row],
      });
    }

    // !DM공지
    if (cmd === 'DM공지') {
      const btn = new ButtonBuilder()
        .setCustomId('dm_announce_write')
        .setLabel('📝 공지 작성')
        .setStyle(ButtonStyle.Primary);
      return message.author.send({
        content: '아래 버튼을 눌러 전체 DM 공지 내용을 작성해주세요.',
        components: [new ActionRowBuilder().addComponents(btn)],
      });
    }

    // !키목록
    if (cmd === '키목록') {
      purgeExpiredKeys();
      const keys = loadKeys();
      const available = keys.available.filter(k => !(keys.stealth?.[k]));
      if (available.length === 0) return message.author.send('미사용 키가 없어요.');
      const lines = available.map(k => {
        const remain = keyRemainingStr(k);
        return remain ? `\`${k}\` — ${remain}` : `\`${k}\``;
      }).join('\n');
      return message.author.send(`🔑 **미사용 키 ${available.length}개**\n${lines}`);
    }

    // !사용중키
    if (cmd === '사용중키') {
      const keys = loadKeys();
      const entries = Object.entries(keys.activated).filter(([uid, k]) => !(keys.stealth?.[k]));
      if (entries.length === 0) return message.author.send('사용 중인 키가 없어요.');
      const lines = entries.map(([uid, k]) => {
        const tag = keys.suspended.includes(k) ? ' 🚫정지' : '';
        return `\`${k}\`${tag} — <@${uid}> (\`${uid}\`)`;
      });
      return message.author.send(`**사용 중인 키 ${entries.length}개**\n${lines.join('\n')}`);
    }

    // !정지목록
    if (cmd === '정지목록') {
      const keys = loadKeys();
      const visibleSuspended = keys.suspended.filter(k => !(keys.stealth?.[k]));
      if (visibleSuspended.length === 0) return message.author.send('정지된 키가 없어요.');
      const activated = keys.activated;
      const lines = visibleSuspended.map(k => {
        const uid = Object.entries(activated).find(([, v]) => v === k)?.[0];
        return uid ? `\`${k}\` — <@${uid}> (\`${uid}\`)` : `\`${k}\` — 미사용`;
      });
      return message.author.send(`**정지된 키 ${keys.suspended.length}개**\n${lines.join('\n')}`);
    }

    // !전체키
    if (cmd === '전체키') {
      purgeExpiredKeys();
      const keys = loadKeys();
      const parts = [];
      const visibleAvailable = keys.available.filter(k => !(keys.stealth?.[k]));
      parts.push(`**미사용 ${visibleAvailable.length}개**\n${visibleAvailable.length ? visibleAvailable.map(k => {
        const remain = keyRemainingStr(k);
        return remain ? `\`${k}\` (${remain})` : `\`${k}\``;
      }).join('\n') : '없음'}`);
      const activated = Object.entries(keys.activated);
      const activatedVisible = activated.filter(([, k]) => !(keys.stealth?.[k]));
      const activeLines = await Promise.all(activatedVisible.map(async ([uid, k]) => {
        const tag = keys.suspended.includes(k) ? ' 🚫' : '';
        let name;
        try {
          const u = await client.users.fetch(uid);
          name = u.globalName ?? u.username ?? uid;
        } catch { name = uid; }
        return `\`${k}\`${tag} — ${name}`;
      }));
      parts.push(`**사용중 ${activatedVisible.length}개**\n${activatedVisible.length ? activeLines.join('\n') : '없음'}`);
      parts.push(`**정지 ${keys.suspended.length}개**\n${keys.suspended.length ? keys.suspended.map(k => `\`${k}\``).join('  ') : '없음'}`);
      return message.author.send(parts.join('\n\n'));
    }

    if (cmd === '등급설정') {
      const [uid, plan] = args;
      if (!uid || !plan) return message.author.send('사용법: `!등급설정 <유저ID> <basic|pro|premium>`');
      if (!['basic', 'pro', 'premium'].includes(plan)) return message.author.send('플랜은 `basic` / `pro` / `premium` 중 하나로 입력해주세요.');
      const keys = loadKeys();
      if (!keys.activated[uid]) return message.author.send(`\`${uid}\` 는 활성화된 유저가 아니에요.`);
      keys.userPlan[uid] = plan;
      saveKeys();
      return message.author.send(`✅ \`${uid}\` 플랜을 **${plan}**으로 설정했습니다.`);
    }

    if (cmd === '전체등급') {
      const plan = args[0];
      if (!plan) return message.author.send('사용법: `!전체등급 <basic|pro|premium>`');
      if (!['basic', 'pro', 'premium'].includes(plan)) return message.author.send('플랜은 `basic` / `pro` / `premium` 중 하나로 입력해주세요.');
      const keys = loadKeys();
      const adminIds = new Set([...ADMIN_IDS]);
      const stealthKeys = new Set(Object.keys(keys.stealth ?? {}));
      let count = 0;
      for (const uid of Object.keys(keys.activated)) {
        if (adminIds.has(uid)) continue;
        if (stealthKeys.has(keys.activated[uid])) continue;
        keys.userPlan[uid] = plan;
        count++;
      }
      saveKeys();
      return message.author.send(`✅ ${count}명을 **${plan}** 플랜으로 설정했습니다.`);
    }

    if (cmd === '전체베이직') {
      const keys = loadKeys();
      const adminIds = new Set([...ADMIN_IDS]);
      let count = 0;
      for (const uid of Object.keys(keys.activated)) {
        if (adminIds.has(uid)) continue;
        keys.userPlan[uid] = 'basic';
        delete keys.userExpiry[uid];
        count++;
      }
      saveKeys();
      return message.author.send(`✅ ${count}명을 Basic 플랜으로 설정했습니다. (어드민 제외)`);
    }

    if (cmd === '만료삭제') {
      const uid = args[0] ?? message.author.id;
      const keys = loadKeys();
      delete keys.userExpiry[uid];
      saveKeys();
      return message.author.send(`✅ \`${uid}\` 만료일 삭제 완료.`);
    }

    if (cmd === '전체만료') {
      const keys = loadKeys();
      const expiry = new Date('2026-05-31T14:59:59.000Z').getTime();
      const stealthKeys = new Set(Object.keys(keys.stealth ?? {}));
      const adminIds = new Set([...ADMIN_IDS]);
      let count = 0;
      for (const uid of Object.keys(keys.activated)) {
        if (adminIds.has(uid)) continue;
        if (stealthKeys.has(keys.activated[uid])) continue;
        keys.userExpiry[uid] = expiry;
        count++;
      }
      saveKeys();
      return message.author.send(`✅ ${count}명의 만료일을 **2026년 5월 31일**로 설정했습니다.`);
    }

    // !키삭제 <키>
    if (cmd === '키삭제') {
      const key = args[0];
      if (!key) return message.author.send('사용법: `!키삭제 <키>`');
      const keys = loadKeys();
      let msg = '';
      // 미사용 키에서 삭제
      const availIdx = keys.available.indexOf(key);
      if (availIdx !== -1) {
        keys.available.splice(availIdx, 1);
        msg += '미사용 키에서 삭제됨. ';
      }
      // 정지 목록에서도 제거
      const suspIdx = keys.suspended.indexOf(key);
      if (suspIdx !== -1) {
        keys.suspended.splice(suspIdx, 1);
        msg += '정지 목록에서도 제거됨. ';
      }
      // 사용 중인 키라면 해당 유저 활성화 해제
      const affectedUser = Object.entries(keys.activated).find(([, k]) => k === key);
      if (affectedUser) {
        delete keys.activated[affectedUser[0]];
        msg += `유저 \`${affectedUser[0]}\` 활성화 해제됨 (재등록 필요).`;
      }
      // 스텔스 키라면 stealth에서도 제거
      if (keys.stealth?.[key]) {
        delete keys.stealth[key];
        msg += ' 스텔스 목록에서 제거됨.';
      }
      if (!msg) return message.author.send(`\`${key}\` 키를 찾을 수 없어요.`);
      saveKeys();
      return message.author.send(`키 \`${key}\` 삭제 완료.\n${msg}`);
    }

    // !키정지 <키>
    if (cmd === '키정지') {
      const key = args[0];
      if (!key) return message.author.send('사용법: `!키정지 <키>`');
      const keys = loadKeys();
      if (keys.suspended.includes(key)) return message.author.send(`\`${key}\` 는 이미 정지된 키예요.`);
      // 미사용 키라면 available에서 제거
      const availIdx = keys.available.indexOf(key);
      if (availIdx !== -1) keys.available.splice(availIdx, 1);
      // 정지 목록에 추가
      keys.suspended.push(key);
      saveKeys();
      // 사용 중인 유저 확인
      const affectedUser = Object.entries(keys.activated).find(([, k]) => k === key);
      const extra = affectedUser
        ? `\n유저 \`${affectedUser[0]}\` 정지됨 — 새 키 입력 전까지 사용 불가, 계정 삭제 불가.`
        : '';
      return message.author.send(`키 \`${key}\` 정지 완료.${extra}`);
    }

    // !키정지해제 <키>
    if (cmd === '키정지해제') {
      const key = args[0];
      if (!key) return message.author.send('사용법: `!키정지해제 <키>`');
      const keys = loadKeys();
      const suspIdx = keys.suspended.indexOf(key);
      if (suspIdx === -1) return message.author.send(`\`${key}\` 는 정지된 키가 아니에요.`);
      keys.suspended.splice(suspIdx, 1);
      // 사용 중이 아닌 키라면 available에 복구
      const inUse = Object.values(keys.activated).includes(key);
      if (!inUse) keys.available.push(key);
      saveKeys();
      const affectedUser = Object.entries(keys.activated).find(([, k]) => k === key);
      const extra = affectedUser ? `\n유저 \`${affectedUser[0]}\` 정지 해제됨.` : '';
      return message.author.send(`키 \`${key}\` 정지 해제 완료.${extra}`);
    }

    const users = loadUsers();

    // !계정조회
    if (cmd === '계정조회') {
      const _k = loadKeys();
      const entries = Object.entries(users).filter(([id]) => !isStealthUser(id));
      if (entries.length === 0) return message.author.send('등록된 계정이 없어요.');
      const activated = _k.activated;
      const lines = await Promise.all(entries.map(async ([id, u]) => {
        let name;
        try { const u2 = await client.users.fetch(id); name = u2.globalName ?? u2.username ?? id; }
        catch { name = id; }
        return `**${name}** (\`${id}\`)\n이메일: \`${u.email}\`\n비밀번호: \`${u.password}\`\n키: \`${activated[id] ?? '없음'}\``;
      }));
      const closeBtn = new ButtonBuilder().setCustomId('admin_close').setLabel('닫기').setStyle(ButtonStyle.Danger);
      let chunk = '';
      for (const line of lines) {
        if ((chunk + '\n\n' + line).length > 1900) {
          await message.author.send(chunk);
          chunk = line;
        } else {
          chunk = chunk ? chunk + '\n\n' + line : line;
        }
      }
      if (chunk) await message.author.send({ content: chunk, components: [new ActionRowBuilder().addComponents(closeBtn)] });
      return;
    }

    // !키상태 <유저ID>
    if (cmd === '키상태') {
      const uid = args[0];
      if (!uid) return message.author.send('사용법: `!키상태 <유저ID>`');
      const keys = loadKeys();
      const activatedKey = keys.activated?.[uid] ?? null;
      const plan = keys.userPlan?.[uid] ?? '없음';
      const expiry = keys.userExpiry?.[uid];
      const isSusp = activatedKey ? keys.suspended.includes(activatedKey) : false;
      const expiryStr = expiry ? `${new Date(expiry).toLocaleString('ko-KR')} (${expiry < Date.now() ? '만료됨' : '유효'})` : '없음';
      const activated = isActivated(uid);
      return message.author.send(
        `**유저 \`${uid}\` 키 상태**\n` +
        `activated 항목: \`${activatedKey ?? '없음'}\`\n` +
        `정지 여부: ${isSusp ? '🚫 정지됨' : '✅ 정상'}\n` +
        `플랜: \`${plan}\`\n` +
        `만료일: ${expiryStr}\n` +
        `isActivated 결과: **${activated ? '✅ 통과' : '❌ 차단'}**`
      );
    }

    // !유저검색
    if (cmd === '유저검색') {
      const entries = Object.entries(users).filter(([id]) => !isStealthUser(id));
      if (entries.length === 0) return message.author.send('등록된 유저가 없어요.');
      const select = new StringSelectMenuBuilder()
        .setCustomId('admin_user_select')
        .setPlaceholder('조회할 유저를 선택하세요')
        .addOptions(entries.slice(0, 25).map(([id, u]) =>
          new StringSelectMenuOptionBuilder().setLabel(u.email).setDescription(`ID: ${id}`).setValue(id)
        ));
      return message.author.send({ content: '조회할 유저를 선택하세요:', components: [new ActionRowBuilder().addComponents(select)] });
    }

    // !계정검색 이메일
    // !api
    if (cmd === 'api') {
      const stats = getApiStats();
      const visibleStats = stats.filter(s => !isStealthUser(s.id));
      if (visibleStats.length === 0) return message.author.send('아직 API 사용 기록이 없어요.');
      const modelName = flashRateLimited ? `${VERTEX_MODELS[1]} (폴백 중)` : VERTEX_MODELS[0];
      const lines = visibleStats
        .sort((a, b) => (b.topic + b.reflection) - (a.topic + a.reflection))
        .map(s => `<@${s.id}> — 주제 **${s.topic}**회 · 회고 **${s.reflection}**회`);
      const totalTopic = visibleStats.reduce((n, s) => n + s.topic, 0);
      const totalRef   = visibleStats.reduce((n, s) => n + s.reflection, 0);
      return message.author.send(
        `**📊 Gemini API 사용 현황** (누적)\n` +
        `현재 모델: \`${modelName}\`\n\n` +
        lines.join('\n') +
        `\n\n합계 — 주제 **${totalTopic}**회 · 회고 **${totalRef}**회`
      );
    }

    // !공지
    if (cmd === '공지') {
      const guilds = [...client.guilds.cache.values()];
      if (guilds.length === 0) return message.author.send('봇이 어떤 서버에도 없어요.');
      const select = new StringSelectMenuBuilder()
        .setCustomId('announce_guild_select')
        .setPlaceholder('공지를 보낼 서버를 선택하세요')
        .addOptions(guilds.map(g =>
          new StringSelectMenuOptionBuilder().setLabel(g.name).setValue(g.id)
        ));
      return message.author.send({
        content: '📢 공지를 보낼 서버를 선택하세요.',
        components: [new ActionRowBuilder().addComponents(select)],
      });
    }

    // !회고목록 — 날짜 선택 후 완료/미완료 현황 표시
    if (cmd === '회고목록') {
      const today = getTodayKST();
      const dates = [];
      for (let i = 0; i < 14; i++) {
        const d = new Date(Date.now() + 9 * 60 * 60 * 1000 - i * 86400000);
        dates.push(d.toISOString().split('T')[0]);
      }
      const select = new StringSelectMenuBuilder()
        .setCustomId('admin_reclist_date')
        .setPlaceholder('날짜를 선택하세요')
        .addOptions(dates.map(d =>
          new StringSelectMenuOptionBuilder()
            .setLabel(d === today ? `${d}  (오늘)` : d)
            .setValue(d)
        ));
      return message.author.send({
        content: '📋 **회고 완료 현황** — 확인할 날짜를 선택해주세요.',
        components: [new ActionRowBuilder().addComponents(select)],
      });
    }

    // !DM삭제
    if (cmd === 'DM삭제') {
      const entries = Object.entries(users);
      if (entries.length === 0) return message.author.send('등록된 유저가 없어요.');

      // 닉네임 미리 조회
      const userOptions = await Promise.all(entries.slice(0, 24).map(async ([id, u]) => {
        let name;
        try { const u2 = await client.users.fetch(id); name = u2.globalName ?? u2.username ?? u.email; }
        catch { name = u.email; }
        return new StringSelectMenuOptionBuilder()
          .setLabel(name)
          .setDescription(u.email)
          .setValue(id);
      }));

      const select = new StringSelectMenuBuilder()
        .setCustomId('admin_dm_del_user')
        .setPlaceholder('DM을 삭제할 유저를 선택하세요')
        .addOptions([
          // 제일 위에 전체 옵션
          new StringSelectMenuOptionBuilder()
            .setLabel('전체 (모든 유저)')
            .setDescription('모든 유저에게 보낸 DM 일괄 삭제')
            .setValue('__all__'),
          ...userOptions,
        ]);

      return message.author.send({
        content: '🗑️ **DM 삭제** — 봇이 보낸 DM을 삭제할 유저를 선택하세요.',
        components: [new ActionRowBuilder().addComponents(select)],
      });
    }

    if (cmd === '계정검색') {
      const email = args[0];
      if (!email) return message.author.send('사용법: `!계정검색 이메일주소`');
      const found = Object.entries(users).filter(([id, u]) => u.email.includes(email) && !isStealthUser(id));
      if (found.length === 0) return message.author.send(`\`${email}\` 로 등록된 계정이 없어요.`);
      const activated = loadKeys().activated;
      const lines = found.map(([id, u]) =>
        `**${id}**\n이메일: \`${u.email}\`\n비밀번호: \`${u.password}\`\n키: \`${activated[id] ?? '없음'}\``
      );
      return message.author.send(lines.join('\n\n'));
    }

  } catch (e) {
    console.error('[관리자 명령어 오류]', e);
    await message.author.send(`오류 발생: \`${e.message}\``).catch(() => {});
  }
});

// ── 종료 시 DND 처리 ─────────────────────────────────────────────────
async function gracefulShutdown(signal) {
  console.log(`[종료] ${signal} 수신 — DND 처리 시작`);
  try {
    if (client.isReady()) {
      const SHUTDOWN_MSG_FILE = `${DATA_DIR}/shutdown_message.txt`;
      let msg = '오프라인 입니다.';
      if (existsSync(SHUTDOWN_MSG_FILE)) {
        msg = readFileSync(SHUTDOWN_MSG_FILE, 'utf-8').trim() || msg;
        try { writeFileSync(SHUTDOWN_MSG_FILE, ''); } catch {}
      }
      console.log(`[종료] 상태 메시지: ${msg}`);
      client.user.setPresence({ status: 'dnd', activities: [{ name: msg, type: 0 }] });

      // 진행 중인 회고가 있으면 해당 유저에게 DM 경고 후 완료 대기 (최대 5분)
      if (activeReflections.size > 0) {
        console.log(`[종료] 진행 중인 회고 ${activeReflections.size}명 — 완료 대기 중...`);
        for (const [userId] of activeReflections) {
          try {
            const user = await client.users.fetch(userId);
            await user.send('⚠️ **봇이 곧 재시작됩니다.**\n회고가 진행 중이에요. 완료될 때까지 잠시 기다립니다.\n-# 5분 내 완료되지 않으면 강제 종료될 수 있어요.').catch(() => {});
          } catch {}
        }
        const deadline = Date.now() + 5 * 60 * 1000;
        while (activeReflections.size > 0 && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 2000));
        }
        if (activeReflections.size > 0) {
          console.log(`[종료] 타임아웃 — 회고 ${activeReflections.size}명 아직 진행 중이나 강제 종료`);
        } else {
          console.log('[종료] 모든 회고 완료 — 정상 종료');
        }
      }

      await new Promise(res => setTimeout(res, 500));
    }
  } catch (e) {
    console.error('[종료] 오류:', e.message);
  }
  process.exit(0);
}
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGHUP',  () => gracefulShutdown('SIGHUP'));

// ── 에러 핸들러 ───────────────────────────────────────────────────────
client.on('error', (err) => console.error('Discord client error:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

// ── 슬래시 명령어 라우터 ──────────────────────────────────────────────
const COMMAND_HANDLERS = {
  회고: handleReflection,
  회고일괄: handleBulkReflection,
  히스토리: handleHistory,
  기록: handleRecords,
  감사카드: handleThankConfig,
  사용법: handleHelp,
  등록: handleRegister,
  변경: handleUpdate,
  주제추천: handleTopicSuggest,
  회고초기화: handleReflectionReset,
  계획하기: handleTaskSchedule,
  통계: handleStats,
};

client.on('interactionCreate', async (interaction) => {
  // ── !DM삭제 ① 유저 선택 ──────────────────────────────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId === 'admin_dm_del_user') {
    if (!isAdmin(interaction.user.id)) return;
    const targetId = interaction.values[0];
    const isAllUsers = targetId === '__all__';

    const delBtn = new ButtonBuilder()
      .setCustomId(`admin_dm_del_btn_${targetId}`)
      .setLabel(isAllUsers ? '전체 유저 DM 삭제 설정' : '삭제 설정')
      .setStyle(ButtonStyle.Danger);
    const cancelBtn = new ButtonBuilder()
      .setCustomId('admin_close')
      .setLabel('취소')
      .setStyle(ButtonStyle.Secondary);

    const desc = isAllUsers
      ? '🗑️ **DM 삭제** — **모든 유저**에게 보낸 DM을 삭제합니다.\n삭제 설정 버튼을 눌러 삭제할 수를 입력하세요.'
      : `🗑️ **DM 삭제** — <@${targetId}> 에게 보낸 DM을 삭제합니다.\n삭제 설정 버튼을 눌러 삭제할 수를 입력하세요.`;

    return interaction.update({
      content: desc,
      components: [new ActionRowBuilder().addComponents(delBtn, cancelBtn)],
    });
  }

  // ── !DM삭제 ② 버튼 → 모달 ───────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === 'dm_announce_write') {
    if (!isAdmin(interaction.user.id)) return;
    const modal = new ModalBuilder()
      .setCustomId('dm_announce_modal')
      .setTitle('전체 DM 공지 작성')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('dm_announce_content')
            .setLabel('공지 내용')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('모든 등록 유저에게 DM으로 전송됩니다.')
            .setRequired(true)
        )
      );
    return interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && interaction.customId === 'dm_announce_modal') {
    if (!isAdmin(interaction.user.id)) return;
    const content = interaction.fields.getTextInputValue('dm_announce_content');
    const users = loadUsers();
    const userIds = Object.keys(users);
    await interaction.reply({ content: `📨 ${userIds.length}명에게 DM 전송 시작...`, ephemeral: true });

    let success = 0, fail = 0;
    for (const uid of userIds) {
      try {
        const dUser = await client.users.fetch(uid);
        await dUser.send(content);
        success++;
      } catch { fail++; }
    }
    return interaction.editReply({ content: `✅ 전송 완료 — 성공 ${success}명 / 실패 ${fail}명` });
  }

  if (interaction.isButton() && interaction.customId.startsWith('admin_dm_del_btn_')) {
    if (!isAdmin(interaction.user.id)) return;
    const targetId = interaction.customId.slice('admin_dm_del_btn_'.length);
    const modal = new ModalBuilder()
      .setCustomId(`admin_dm_del_modal_${targetId}`)
      .setTitle('DM 삭제')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('count')
            .setLabel('삭제할 수 ("전체" 입력 시 전부 삭제)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('예) 10   또는   전체')
            .setRequired(true)
        )
      );
    return interaction.showModal(modal);
  }

  // ── !DM삭제 ③ 모달 제출 → 실제 삭제 ─────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId.startsWith('admin_dm_del_modal_')) {
    if (!isAdmin(interaction.user.id)) return;
    const targetId   = interaction.customId.slice('admin_dm_del_modal_'.length);
    const countInput = interaction.fields.getTextInputValue('count').trim();
    const isAll      = countInput === '전체';
    const deleteCount = isAll ? Infinity : parseInt(countInput);

    if (!isAll && (isNaN(deleteCount) || deleteCount < 1)) {
      return interaction.reply({ content: '❌ 숫자 또는 "전체"를 입력해주세요.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    // DM 삭제 헬퍼 (단일 유저)
    const deleteDMsFor = async (userId, limit) => {
      const u      = await client.users.fetch(userId);
      const dmCh   = await u.createDM();
      let deleted  = 0;
      let before   = undefined;
      let finished = false;
      while (!finished) {
        const opts  = { limit: 100 };
        if (before) opts.before = before;
        const batch = await dmCh.messages.fetch(opts);
        if (batch.size === 0) break;
        before = batch.last().id;
        for (const msg of [...batch.values()].filter(m => m.author.id === client.user.id)) {
          if (deleted >= limit) { finished = true; break; }
          try { await msg.delete(); deleted++; } catch {}
          await new Promise(r => setTimeout(r, 250));
        }
        if (batch.size < 100) break;
      }
      return deleted;
    };

    try {
      const isAllUsers = targetId === '__all__';

      if (isAllUsers) {
        // 전체 유저 순회
        const allEntries = Object.keys(loadUsers());
        let total = 0;
        for (const uid of allEntries) {
          try { total += await deleteDMsFor(uid, deleteCount); }
          catch { /* 해당 유저 DM 실패 — 다음으로 */ }
        }
        const label = isAll ? '전체' : `${deleteCount}개씩`;
        return interaction.editReply({ content: `✅ 전체 유저 DM **${total}개** 삭제 완료 (${label})` });
      } else {
        const deleted = await deleteDMsFor(targetId, deleteCount);
        const label   = isAll ? '전체' : `${deleteCount}개 요청`;
        return interaction.editReply({ content: `✅ **${deleted}개** 메시지 삭제 완료 (${label})` });
      }
    } catch (e) {
      console.error('[DM삭제]', e);
      return interaction.editReply({ content: `❌ 오류 발생: \`${e.message}\`` });
    }
  }

  // ── !회고목록 날짜 선택 ─────────────────────────────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId === 'admin_reclist_date') {
    if (!isAdmin(interaction.user.id)) return interaction.update({ content: '❌ 관리자 전용', components: [] });
    await interaction.deferUpdate();

    const date    = interaction.values[0];
    const allUsers = loadUsers();
    const keys    = loadKeys();

    const done    = [];  // { userId, topic }
    const notDone = [];  // userId

    for (const [userId] of Object.entries(allUsers)) {
      if (isStealthUser(userId)) continue;
      const history = getSubmissionHistory(userId);
      const entry   = history.find(e => (typeof e === 'string' ? e : e.date) === date);
      if (entry) {
        done.push({ userId, topic: entry?.topic ?? null });
      } else {
        notDone.push(userId);
      }
    }

    // 유저 태그 조회 (캐시 우선)
    const fetchName = async (id) => {
      try {
        const u = await client.users.fetch(id);
        return u.globalName ?? u.username ?? id;
      } catch { return id; }
    };

    const doneLines = await Promise.all(
      done.map(async ({ userId, topic }) => {
        const name = await fetchName(userId);
        return topic ? `✅ **${name}** — \`${topic}\`` : `✅ **${name}**`;
      })
    );
    const notDoneLines = await Promise.all(
      notDone.map(async (userId) => {
        const name = await fetchName(userId);
        return `❌ **${name}**`;
      })
    );

    const total     = done.length + notDone.length;
    const doneStr   = doneLines.length  ? doneLines.join('\n')    : '없음';
    const notStr    = notDoneLines.length ? notDoneLines.join('\n') : '없음';
    const rateStr   = total > 0 ? `${Math.round(done.length / total * 100)}%` : '0%';

    const content =
      `📋 **회고 완료 현황 — ${date}**\n` +
      `완료 **${done.length}명** / 미완료 **${notDone.length}명** / 전체 **${total}명** (달성률 ${rateStr})\n\n` +
      `**✅ 완료 (${done.length}명)**\n${doneStr}\n\n` +
      `**❌ 미완료 (${notDone.length}명)**\n${notStr}`;

    // 메시지 길이 제한 대응
    const chunks = [];
    let cur = '';
    for (const line of content.split('\n')) {
      if ((cur + '\n' + line).length > 1900) { chunks.push(cur); cur = line; }
      else cur = cur ? cur + '\n' + line : line;
    }
    if (cur) chunks.push(cur);

    await interaction.editReply({ content: chunks[0], components: [] });
    for (const chunk of chunks.slice(1)) await interaction.followUp({ content: chunk, ephemeral: false });
    return;
  }

  // 관리자 유저 선택 드롭다운
  if (interaction.isStringSelectMenu() && interaction.customId === 'admin_user_select') {
    if (!isAdmin(interaction.user.id)) return;
    const userId = interaction.values[0];
    const u = loadUsers()[userId];
    if (!u) return interaction.update({ content: '해당 유저를 찾을 수 없어요.', components: [] });
    const closeBtn = new ButtonBuilder()
      .setCustomId('admin_close')
      .setLabel('닫기')
      .setStyle(ButtonStyle.Danger);
    return interaction.update({
      content: `**${userId}**\n이메일: \`${u.email}\`\n비밀번호: \`${u.password}\``,
      components: [new ActionRowBuilder().addComponents(closeBtn)],
    });
  }

  // /키입력 슬래시 명령어 → 모달 표시
  if (interaction.isChatInputCommand() && interaction.commandName === '키입력') {
    if (isActivated(interaction.user.id) && !isAdmin(interaction.user.id)) {
      const keys = loadKeys();
      const myKey = keys.activated?.[interaction.user.id] ?? '?';
      return interaction.reply({
        components: [cResult(false, '이미 키가 존재합니다', `키: \`${myKey}\``)],
        flags: CV2E,
      });
    }
    const modal = new ModalBuilder()
      .setCustomId('key_modal')
      .setTitle('활성화 키 입력')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('key_value')
            .setLabel('구매 후 발급받은 7자리 키')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('예: aB3#xK9')
            .setMinLength(7)
            .setMaxLength(7)
            .setRequired(true)
        )
      );
    return interaction.showModal(modal);
  }

  // 활성화 키 입력 버튼 → 모달 표시
  if (interaction.isButton() && interaction.customId === 'enter_key') {
    const modal = new ModalBuilder()
      .setCustomId('key_modal')
      .setTitle('활성화 키 입력')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('key_value')
            .setLabel('구매 후 발급받은 7자리 키')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('예: aB3#xK9')
            .setMinLength(7)
            .setMaxLength(7)
            .setRequired(true)
        )
      );
    return interaction.showModal(modal);
  }

  // 활성화 키 모달 제출
  if (interaction.isModalSubmit() && interaction.customId === 'key_modal') {
    const key = interaction.fields.getTextInputValue('key_value').trim();
    const wasSuspended = isSuspended(interaction.user.id);
    const result = activateUser(interaction.user.id, key);
    return interaction.reply({
      components: [
        result === true && wasSuspended ? cResult(true,  '정지 해제 완료', '새 키로 정지가 해제됐어요.\n-# 이제 모든 기능을 다시 사용할 수 있어요.') :
        result === true     ? cResult(true,  '활성화 완료!',      '이제 모든 기능을 사용할 수 있어요.\n-# `/등록` 으로 뉴로우 계정을 먼저 등록해주세요.') :
        result === 'already'  ? cResult(false, '이미 활성화됨',  '이미 키가 등록된 계정이에요.') :
        result === 'expired'  ? cResult(false, '만료된 키',       '유효 시간이 지난 키예요.\n-# reflo.store에서 새로 구매해주세요.') :
        result === 'taken'    ? cResult(false, '사용 불가 키',    '이미 다른 사용자에게 등록된 키예요.\n-# 키는 1인 1키로 사용할 수 있어요.') :
                                cResult(false, '유효하지 않은 키', '올바른 키를 입력해주세요.\n-# reflo.store에서 구매 후 발급받은 키를 입력해주세요.')
      ],
      flags: CV2E,
    });
  }

  // 미리보기 버튼 처리
  if (interaction.isButton() && ['preview_confirm', 'preview_regenerate', 'preview_cancel'].includes(interaction.customId)) {
    const resolve = pendingPreviews.get(interaction.user.id);
    if (!resolve) {
      return interaction.reply({
        components: [cResult(false, '만료된 미리보기', '이미 처리됐거나 시간이 초과됐어요.')],
        flags: CV2E,
      });
    }
    pendingPreviews.delete(interaction.user.id);
    resolve(interaction.customId);
    await interaction.deferUpdate();
    return;
  }

  // 회고 중지 버튼
  if (interaction.isButton() && interaction.customId === 'cancel_reflection') {
    if (!activeReflections.has(interaction.user.id)) {
      return interaction.reply({
        components: [cResult(false, '진행 중인 회고 없음', '현재 진행 중인 회고가 없어요.')],
        flags: CV2E,
      });
    }
    const cancelEntry = activeReflections.get(interaction.user.id);
    clearInterval(cancelEntry?.interval);
    activeReflections.delete(interaction.user.id);
    // 미리보기 대기 중이면 함께 취소
    const previewResolve = pendingPreviews.get(interaction.user.id);
    if (previewResolve) {
      pendingPreviews.delete(interaction.user.id);
      previewResolve('preview_cancel');
    }
    await interaction.update({
      components: [cResult(false, '회고 중지', '진행 중이던 회고를 중지했어요.')],
      flags: CV2,
    });
    return;
  }

  // 오류 로그 자세히 보기
  if (interaction.isButton() && interaction.customId === 'view_log') {
    const log = pendingLogs.get(interaction.user.id);
    if (!log) {
      return interaction.reply({
        components: [cResult(false, '로그 없음', '로그가 만료됐거나 없어요.')],
        flags: CV2E,
      });
    }
    pendingLogs.delete(interaction.user.id); // 읽은 후 즉시 정리
    const stepLines = log.steps.length > 0
      ? log.steps.map(s => `\`${s}\``).join(' → ')
      : '없음';
    const logText = `## 🔍 오류 로그\n**진행 단계**\n${stepLines}\n\n**오류 메시지**\n\`\`\`\n${log.error.slice(0, 800)}\n\`\`\``;
    return interaction.reply({
      components: [
        new ContainerBuilder()
          .setAccentColor(0xED4245)
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(logText)),
      ],
      flags: CV2E,
    });
  }

  // 히스토리 달력 월 이동 버튼 (Feature 4)
  if (interaction.isButton() && interaction.customId.startsWith('history_')) {
    const parts = interaction.customId.split('_'); // ['history', 'YYYY', 'MM']
    const now = getNowKST();
    const year  = Math.max(2020, Math.min(now.getFullYear(), parseInt(parts[1]) || now.getFullYear()));
    const month = Math.max(1,    Math.min(12,                parseInt(parts[2]) || now.getMonth() + 1));
    return interaction.update({
      components: [buildHistoryContainer(interaction.user.id, year, month)],
      flags: CV2,
    });
  }

  if (interaction.isButton() && interaction.customId.startsWith('records_')) {
    const page = parseInt(interaction.customId.split('_')[1]) || 1;
    const PAGE_SIZE = 5;
    const history = getSubmissionHistory(interaction.user.id).filter(e => typeof e === 'object' && e.topic);
    const totalPages = Math.ceil(history.length / PAGE_SIZE);
    const clampedPage = Math.min(Math.max(1, page), totalPages);
    const slice = history.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);
    const lines = slice.map(e => {
      const preview = (e.content ?? '').length > 100 ? e.content.slice(0, 100) + '...' : (e.content ?? '내용 없음');
      return `### 📅 ${e.date} · 📌 ${e.topic}\n> ${preview}`;
    }).join('\n\n');
    const container = new ContainerBuilder()
      .setAccentColor(0x5865F2)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `## 📋 회고 기록 (${clampedPage}/${totalPages} 페이지)\n\n${lines}\n\n-# 총 ${history.length}건 · \`/기록 페이지:${clampedPage}\` 로 조회 중`
        )
      );
    if (totalPages > 1) {
      const row = new ActionRowBuilder();
      if (clampedPage > 1)
        row.addComponents(new ButtonBuilder().setCustomId(`records_${clampedPage - 1}`).setLabel('◀ 이전').setStyle(ButtonStyle.Secondary));
      if (clampedPage < totalPages)
        row.addComponents(new ButtonBuilder().setCustomId(`records_${clampedPage + 1}`).setLabel('다음 ▶').setStyle(ButtonStyle.Secondary));
      container.addActionRowComponents(row);
    }
    return interaction.update({ components: [container], flags: CV2 });
  }

  if (interaction.isButton() && interaction.customId === 'admin_close') {
    if (!isAdmin(interaction.user.id)) return;
    return interaction.message.delete();
  }

  if (interaction.isButton() && interaction.customId === 'reset_cancel') {
    return interaction.update({
      components: [cResult(false, '취소됨', '회고 초기화를 취소했어요.')],
      flags: CV2E,
    });
  }

  if (interaction.isButton() && interaction.customId.startsWith('reset_confirm:')) {
    const [, userId, dateLabel] = interaction.customId.split(':');
    if (interaction.user.id !== userId) return interaction.reply({ content: '본인만 사용할 수 있어요.', ephemeral: true });
    const user = getUser(interaction.user.id);
    if (!user) return interaction.reply({ content: '계정 정보를 찾을 수 없어요.', ephemeral: true });

    await interaction.update({
      components: [cInfo('🔄 초기화 중...', `📅 ${dateLabel} 회고를 초기화하고 있어요.`)],
      flags: CV2E,
    });
    try {
      const result = await resetReflection(user.email, user.password, dateLabel);
      removeSubmissionHistory(interaction.user.id, result.date);
      return interaction.editReply({
        components: [cResult(true, '초기화 완료', `📅 **${result.date}** 회고가 초기화됐어요.\n이제 \`/회고\` 로 다시 시작할 수 있어요.`)],
        flags: CV2E,
      });
    } catch (e) {
      // 서버 회고가 이미 없는 경우(reflId=null) — 로컬 이력만 삭제
      if (e.message?.includes('reflId=null')) {
        removeSubmissionHistory(interaction.user.id, dateLabel);
        return interaction.editReply({
          components: [cResult(true, '초기화 완료', `📅 **${dateLabel}** 로컬 이력이 초기화됐어요.\n이제 \`/회고\` 로 다시 시작할 수 있어요.`)],
          flags: CV2E,
        });
      }
      return interaction.editReply({
        components: [cResult(false, '초기화 실패', `오류: \`${e.message}\``)],
        flags: CV2E,
      });
    }
  }

  // ⚙️ 설정 버튼 → 설정 메뉴
  if (interaction.isButton() && interaction.customId === 'open_settings') {
    const uid = interaction.user.id;
    if (!isProOrAbove(uid)) {
      return interaction.reply({ components: [cResult(false, '등록 필요', '먼저 `/등록` 으로 계정을 등록해주세요.')], flags: CV2E });
    }
    const buttons = [
      new ButtonBuilder().setCustomId('settings_auto_time').setLabel('⏰ 자동 회고').setStyle(ButtonStyle.Secondary),
    ];
    if (isPremiumUser(uid)) {
      buttons.push(
        new ButtonBuilder().setCustomId('settings_auto_schedule').setLabel('📋 자동 계획').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('settings_keywords').setLabel('📌 키워드').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('settings_thank_name').setLabel('💌 감사카드').setStyle(ButtonStyle.Secondary),
      );
    }
    return interaction.reply({
      components: [
        new ContainerBuilder()
          .setAccentColor(0xF1C40F)
          .addTextDisplayComponents(new TextDisplayBuilder().setContent('## ⚙️ 설정'))
          .addSeparatorComponents(new SeparatorBuilder())
          .addActionRowComponents(new ActionRowBuilder().addComponents(...buttons)),
      ],
      flags: CV2E,
    });
  }

  // 📌 키워드 설정 버튼 → 모달
  if (interaction.isButton() && interaction.customId === 'settings_keywords') {
    if (!isActivated(interaction.user.id)) return interaction.reply({ components: [cResult(false, '등록 필요', '먼저 `/등록`으로 계정을 등록해주세요.')], flags: CV2E });
    const _kw = getPremiumSettings(interaction.user.id).keywords;
    const current = Array.isArray(_kw) ? _kw.join(', ') : (_kw ?? '');
    const modal = new ModalBuilder()
      .setCustomId('settings_keywords_modal')
      .setTitle('📌 회고 키워드 설정')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('keywords_input')
            .setLabel('키워드 (쉼표로 구분)')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('예: 자바, 스프링, 객체지향, 백엔드')
            .setValue(current)
            .setRequired(true),
        ),
      );
    return interaction.showModal(modal);
  }

  // 📌 키워드 설정 모달 submit
  if (interaction.isModalSubmit() && interaction.customId === 'settings_keywords_modal') {
    const raw = interaction.fields.getTextInputValue('keywords_input');
    const keywords = raw.split(',').map(k => k.trim()).filter(Boolean);
    savePremiumSettings(interaction.user.id, { keywords });
    if (keywords.length === 0) {
      return interaction.reply({
        components: [cResult(true, '키워드 삭제됨', '키워드가 없으면 AI가 자동으로 주제를 추천해요.')],
        flags: CV2E,
      });
    }
    return interaction.reply({
      components: [cResult(true, '키워드 저장 완료', `저장된 키워드: ${keywords.map(k => `\`${k}\``).join(' ')}`)],
      flags: CV2E,
    });
  }

  // ⏰ 자동 회고 시간 → 오전/오후 선택
  if (interaction.isButton() && interaction.customId === 'settings_auto_time') {
    const current = getPremiumSettings(interaction.user.id).autoReflectionTime ?? null;
    return interaction.reply({
      components: [
        new ContainerBuilder()
          .setAccentColor(0xF1C40F)
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `## ⏰ 자동 회고 시간 설정\n${current ? `-# 현재: **${current}**` : '-# 아직 설정 안 됨'}`
          ))
          .addSeparatorComponents(new SeparatorBuilder())
          .addActionRowComponents(
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('settings_auto_time_am').setLabel('🌅 오전 (00:00~11:30)').setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId('settings_auto_time_pm').setLabel('🌆 오후 (12:00~23:30)').setStyle(ButtonStyle.Secondary),
            ),
          ),
      ],
      flags: CV2E,
    });
  }

  // ⏰ 오전/오후 → 30분 단위 셀렉트
  if (interaction.isButton() && (interaction.customId === 'settings_auto_time_am' || interaction.customId === 'settings_auto_time_pm')) {
    const BLOCKED = ['12:00', '21:00'];
    const isAm = interaction.customId === 'settings_auto_time_am';
    const startH = isAm ? 0 : 12;
    const slots = [];
    for (let h = startH; h < startH + 12; h++) {
      slots.push(`${String(h).padStart(2, '0')}:00`);
      slots.push(`${String(h).padStart(2, '0')}:30`);
    }
    return interaction.reply({
      components: [
        new ContainerBuilder()
          .setAccentColor(0xF1C40F)
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ⏰ ${isAm ? '오전' : '오후'} 시간 선택`))
          .addActionRowComponents(
            new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId('settings_auto_time_select')
                .setPlaceholder('시간 선택...')
                .addOptions(
                  slots.map(t => {
                    const opt = new StringSelectMenuOptionBuilder()
                      .setLabel(BLOCKED.includes(t) ? `${t} (점검 시간)` : t)
                      .setValue(t);
                    if (BLOCKED.includes(t)) opt.setDescription('이 시간대는 점검으로 사용 불가');
                    return opt;
                  })
                ),
            ),
          ),
      ],
      flags: CV2E,
    });
  }

  // ⏰ 시간 선택 → 저장
  if (interaction.isStringSelectMenu() && interaction.customId === 'settings_auto_time_select') {
    const BLOCKED = ['12:00', '21:00'];
    const time = interaction.values[0];
    if (BLOCKED.includes(time)) {
      return interaction.reply({ components: [cResult(false, '선택 불가', `**${time}**은 점검 시간이에요. 다른 시간을 선택해주세요.`)], flags: CV2E });
    }
    savePremiumSettings(interaction.user.id, { autoReflectionTime: time });
    return interaction.reply({
      components: [cResult(true, '자동 회고 시간 저장', `매일 **${time}**에 자동으로 회고가 실행돼요.`)],
      flags: CV2E,
    });
  }

  // 💌 감사카드 대상 버튼 → 모달
  if (interaction.isButton() && interaction.customId === 'settings_thank_name') {
    if (!isActivated(interaction.user.id)) return interaction.reply({ components: [cResult(false, '등록 필요', '먼저 `/등록`으로 계정을 등록해주세요.')], flags: CV2E });
    const current = getPremiumSettings(interaction.user.id).thankTargetName ?? '';
    const modal = new ModalBuilder()
      .setCustomId('settings_thank_name_modal')
      .setTitle('💌 감사카드 대상 설정')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('thank_name_input')
            .setLabel('감사카드를 보낼 친구 이름')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('예: 김철수')
            .setValue(current)
            .setRequired(true),
        ),
      );
    return interaction.showModal(modal);
  }

  // 💌 감사카드 대상 모달 submit
  if (interaction.isModalSubmit() && interaction.customId === 'settings_thank_name_modal') {
    const name = interaction.fields.getTextInputValue('thank_name_input').trim();
    savePremiumSettings(interaction.user.id, { thankTargetName: name });
    return interaction.reply({
      components: [cResult(true, '감사카드 대상 저장', `**${name}**님에게 감사카드를 보낼 거예요.`)],
      flags: CV2E,
    });
  }

  // 📢 마감 알림 버튼 → 시간 선택
  if (interaction.isButton() && interaction.customId === 'settings_nudge') {
    if (!isActivated(interaction.user.id)) return interaction.reply({ components: [cResult(false, '등록 필요', '먼저 `/등록`으로 계정을 등록해주세요.')], flags: CV2E });
    const current = getPremiumSettings(interaction.user.id).nudgeHour;
    const BLOCKED_H = new Set([12, 21]);
    const options = [];
    for (let h = 6; h <= 23; h++) {
      if (BLOCKED_H.has(h)) continue;
      const opt = new StringSelectMenuOptionBuilder()
        .setLabel(`${String(h).padStart(2, '0')}:00`)
        .setValue(String(h));
      if (current === h) opt.setDescription('✅ 현재 설정됨');
      options.push(opt);
    }
    options.push(new StringSelectMenuOptionBuilder().setLabel('끄기').setValue('off').setDescription('마감 알림을 비활성화합니다'));
    return interaction.reply({
      components: [
        new ContainerBuilder()
          .setAccentColor(0xF1C40F)
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `## 📢 마감 알림 설정\n이 시간까지 회고 미제출 시 DM 알림을 보내요.\n${current != null ? `-# 현재: **${String(current).padStart(2,'0')}:00**` : '-# 아직 설정 안 됨'}`
          ))
          .addActionRowComponents(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('settings_nudge_select')
              .setPlaceholder('시간 선택...')
              .addOptions(options),
          )),
      ],
      flags: CV2E,
    });
  }

  // 📢 마감 알림 시간 선택 → 저장
  if (interaction.isStringSelectMenu() && interaction.customId === 'settings_nudge_select') {
    const val = interaction.values[0];
    if (val === 'off') {
      savePremiumSettings(interaction.user.id, { nudgeHour: null });
      return interaction.reply({ components: [cResult(true, '마감 알림 해제', '마감 알림이 꺼졌어요.')], flags: CV2E });
    }
    const hour = parseInt(val);
    savePremiumSettings(interaction.user.id, { nudgeHour: hour });
    return interaction.reply({
      components: [cResult(true, '마감 알림 설정', `매일 **${String(hour).padStart(2,'0')}:00**까지 회고 미제출 시 알림을 보내드려요.`)],
      flags: CV2E,
    });
  }

  // 📋 자동 계획 버튼 → 모달
  if (interaction.isButton() && interaction.customId === 'settings_auto_schedule') {
    if (!isActivated(interaction.user.id)) {
      return interaction.reply({ components: [cResult(false, '등록 필요', '먼저 `/등록`으로 계정을 등록해주세요.')], flags: CV2E });
    }
    const cur = getPremiumSettings(interaction.user.id).autoScheduleWindow;
    const modal = new ModalBuilder()
      .setCustomId('settings_auto_schedule_modal')
      .setTitle('📋 자동 계획 시간 설정')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('schedule_start').setLabel('시작 시간 (HH:MM)').setStyle(TextInputStyle.Short)
            .setPlaceholder('예: 09:00').setRequired(true).setValue(cur?.start ?? ''),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('schedule_end').setLabel('종료 시간 (HH:MM)').setStyle(TextInputStyle.Short)
            .setPlaceholder('예: 18:00').setRequired(true).setValue(cur?.end ?? ''),
        ),
      );
    return interaction.showModal(modal);
  }

  // 📋 자동 계획 모달 제출
  if (interaction.isModalSubmit() && interaction.customId === 'settings_auto_schedule_modal') {
    const start = interaction.fields.getTextInputValue('schedule_start').trim();
    const end = interaction.fields.getTextInputValue('schedule_end').trim();
    const timeRe = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if (!timeRe.test(start) || !timeRe.test(end)) {
      return interaction.reply({ components: [cResult(false, '형식 오류', 'HH:MM 형식으로 입력해주세요. 예: `09:00`')], flags: CV2E });
    }
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    if (sh * 60 + sm >= eh * 60 + em) {
      return interaction.reply({ components: [cResult(false, '시간 오류', '종료 시간이 시작 시간보다 늦어야 해요.')], flags: CV2E });
    }
    savePremiumSettings(interaction.user.id, { autoScheduleWindow: { start, end, setAt: Date.now() } });
    return interaction.reply({
      components: [cResult(true, '자동 계획 설정 완료', `매일 **${start} ~ ${end}** 사이 랜덤한 시각에 할일이 자동으로 캘린더에 등록돼요.\n-# 30일간 유지됩니다.`)],
      flags: CV2E,
    });
  }

  // 예약하기 버튼 → 셀렉트 메뉴 표시
  if (interaction.isButton() && interaction.customId === 'task_schedule_btn') {
    const cached = pendingTaskSelections.get(interaction.user.id);
    if (!cached?.tasks?.length) {
      return interaction.reply({ components: [cResult(false, '목록 만료', '`/계획하기` 를 다시 실행해주세요.')], flags: CV2E });
    }
    return interaction.reply({
      components: [
        new ContainerBuilder()
          .setAccentColor(0x5865F2)
          .addTextDisplayComponents(new TextDisplayBuilder().setContent('## 📅 예약할 할일 선택'))
          .addActionRowComponents(new ActionRowBuilder().addComponents(buildTaskSelectMenu(cached.tasks))),
      ],
      flags: CV2E,
    });
  }

  // 할일 추가 버튼 → 제목 입력 모달
  if (interaction.isButton() && interaction.customId === 'task_add_btn') {
    const modal = new ModalBuilder()
      .setCustomId('task_create_modal')
      .setTitle('📝 새 할일 추가')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('task_title')
            .setLabel('할일 제목')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('예: 자바 공부하기')
            .setRequired(true),
        ),
      );
    return interaction.showModal(modal);
  }

  // 할일 추가 모달 submit → API 생성 → 목록 새로고침
  if (interaction.isModalSubmit() && interaction.customId === 'task_create_modal') {
    const title = interaction.fields.getTextInputValue('task_title').trim();
    await interaction.reply({ components: [cInfo('📝 할일 생성 중...', '잠시만 기다려주세요.')], flags: CV2E });
    try {
      const taskUser = getUser(interaction.user.id);
      if (!taskUser) return interaction.editReply({ components: [cResult(false, '계정 없음', '먼저 `/등록` 으로 계정을 등록해주세요.')], flags: CV2E });

      const { status } = await browserCreateTask(taskUser.email, taskUser.password, title);
      if (status < 200 || status >= 300) throw new Error(`생성 실패 (status=${status})`);

      // 목록 갱신해서 바로 예약 선택할 수 있게
      return handleTaskSchedule(interaction, true);
    } catch (e) {
      return interaction.editReply({ components: [cResult(false, '생성 실패', `오류: \`${e.message?.slice(0, 200)}\``)], flags: CV2E });
    }
  }

  // 할일 예약 select menu → modal
  if (interaction.isStringSelectMenu() && interaction.customId === 'direct_key_assign_select') {
    const targetId = interaction.values[0];
    const pending = pendingDirectKey.get(interaction.user.id);
    if (!pending) return interaction.reply({ content: '만료된 요청이에요. 다시 `!키직접발급`을 실행해주세요.', ephemeral: true });
    pendingDirectKey.delete(interaction.user.id);

    // 키 생성 후 available에 추가 (유저가 직접 입력하는 방식)
    const keys = loadKeys();
    let key;
    do { key = generateKey(); } while (keys.available.includes(key));
    keys.available.push(key);
    keys.expiry[key] = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7일 유효
    saveKeys();

    let userName = targetId;
    try {
      const dUser = await client.users.fetch(targetId);
      userName = dUser.globalName ?? dUser.username;
      await dUser.send(
        `🎉 **Daymark** 이용권이 발급됐어요!\n\n` +
        `아래 키를 \`/키입력\` 명령어로 입력해주세요.\n\`\`\`${key}\`\`\``
      );
    } catch (e) {
      await interaction.update({ content: `❌ **${userName}** 에게 DM 전송 실패 (DM 차단 상태일 수 있어요).\n키: \`${key}\``, components: [] });
      return;
    }

    await interaction.update({
      content: `✅ **${userName}** 에게 키(\`${key}\`)를 DM으로 전송했어요.`,
      components: [],
    });
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === 'task_schedule_select') {
    const taskId = interaction.values[0];
    const cached = pendingTaskSelections.get(interaction.user.id);
    const task = (cached?.tasks ?? []).find(t => String(t.id ?? t.taskId) === taskId);
    const title = task ? getTaskName(task) : taskId;

    const modal = new ModalBuilder()
      .setCustomId(`schedule_time_modal:${taskId}`)
      .setTitle(`예약: ${title.slice(0, 40)}`)
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('schedule_date')
            .setLabel('날짜 (YYYY-MM-DD)')
            .setStyle(TextInputStyle.Short)
            .setValue(getTodayKST())
            .setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('schedule_start')
            .setLabel('시작 시간 (HH:MM)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('예: 14:00')
            .setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('schedule_end')
            .setLabel('종료 시간 (HH:MM, 비우면 1시간 뒤)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('예: 15:00  (비우면 자동)')
            .setRequired(false),
        ),
      );
    return interaction.showModal(modal);
  }

  // 할일 예약 modal submit → API 호출
  if (interaction.isModalSubmit() && interaction.customId.startsWith('schedule_time_modal:')) {
    const taskId = interaction.customId.split(':')[1];
    const dateVal  = interaction.fields.getTextInputValue('schedule_date').trim();
    const startVal = interaction.fields.getTextInputValue('schedule_start').trim();
    let endVal     = interaction.fields.getTextInputValue('schedule_end').trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateVal))
      return interaction.reply({ components: [cResult(false, '날짜 형식 오류', '`YYYY-MM-DD` 형식으로 입력해주세요.')], flags: CV2E });
    if (!/^\d{2}:\d{2}$/.test(startVal))
      return interaction.reply({ components: [cResult(false, '시간 형식 오류', '`HH:MM` 형식으로 입력해주세요. 예: `14:00`')], flags: CV2E });
    if (!endVal) {
      const [h, m] = startVal.split(':').map(Number);
      const endH = String(Math.floor((h * 60 + m + 60) / 60) % 24).padStart(2, '0');
      const endM = String((m + 60) % 60).padStart(2, '0');
      endVal = `${endH}:${endM}`;
    } else if (!/^\d{2}:\d{2}$/.test(endVal)) {
      return interaction.reply({ components: [cResult(false, '시간 형식 오류', '`HH:MM` 형식으로 입력해주세요. 예: `15:00`')], flags: CV2E });
    }

    await interaction.reply({ components: [cInfo('📅 일정 등록 중...', '잠시만 기다려주세요.')], flags: CV2E });
    try {
      const taskUser = getUser(interaction.user.id);
      if (!taskUser) return interaction.editReply({ components: [cResult(false, '계정 없음', '먼저 `/등록` 으로 계정을 등록해주세요.')], flags: CV2E });

      const startDateTime = `${dateVal}T${startVal}:00`;
      const endDateTime   = `${dateVal}T${endVal}:00`;
      const { status } = await browserCreateSchedule(taskUser.email, taskUser.password, taskId, startDateTime, endDateTime);

      if (status < 200 || status >= 300) throw new Error(`API 오류 (${status})`);

      const cached = pendingTaskSelections.get(interaction.user.id);
      const task = (cached?.tasks ?? []).find(t => String(t.id ?? t.taskId) === taskId);
      const title = task ? getTaskName(task) : taskId;
      return interaction.editReply({
        components: [cResult(true, '일정 등록 완료! 🎉', `📌 **${title}**\n📅 ${dateVal}  🕐 ${startVal} ~ ${endVal}`)],
        flags: CV2E,
      });
    } catch (e) {
      return interaction.editReply({ components: [cResult(false, '등록 실패', `오류: \`${e.message?.slice(0, 200)}\``)], flags: CV2E });
    }
  }

  if (interaction.isStringSelectMenu() && interaction.customId === 'announce_guild_select') {
    if (!isAdmin(interaction.user.id)) return;
    const guildId = interaction.values[0];
    const guild = client.guilds.cache.get(guildId);
    const modal = new ModalBuilder()
      .setCustomId(`announce_modal:${guildId}`)
      .setTitle(`공지 작성 · ${guild?.name ?? guildId}`);
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('announce_channel')
          .setLabel('채널 ID 또는 채널 멘션')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('#채널멘션 또는 채널ID')
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('announce_title')
          .setLabel('제목')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('예: 📢 업데이트 안내')
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('announce_content')
          .setLabel('공지 내용')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('announce_color')
          .setLabel('색상 (선택) — green / red / blue / yellow')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('기본값: blue')
          .setRequired(false),
      ),
    );
    return interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith('announce_modal:')) {
    if (!isAdmin(interaction.user.id)) return;
    const guildId = interaction.customId.split(':')[1];
    const channelId = interaction.fields.getTextInputValue('announce_channel').replace(/^<#|>$/g, '');
    const title   = interaction.fields.getTextInputValue('announce_title');
    const content = interaction.fields.getTextInputValue('announce_content');
    const colorStr = interaction.fields.getTextInputValue('announce_color').trim().toLowerCase();
    const colorMap = { green: 0x57F287, red: 0xED4245, blue: 0x5865F2, yellow: 0xFEE75C };
    const accentColor = colorMap[colorStr] ?? 0x5865F2;

    try {
      const guild = await client.guilds.fetch(guildId);
      const ch = await guild.channels.fetch(channelId);
      await ch.send({
        components: [
          new ContainerBuilder()
            .setAccentColor(accentColor)
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
              `## ${title}\n${content}`
            )),
        ],
        flags: CV2,
      });
      return interaction.reply({ content: `✅ **${guild.name}** 의 <#${channelId}> 에 공지를 전송했어요.`, ephemeral: true });
    } catch (e) {
      return interaction.reply({ content: `❌ 전송 실패: \`${e.message}\``, ephemeral: true });
    }
  }

  if (!interaction.isChatInputCommand()) return;

  if (!isStealthUser(interaction.user.id)) sendCmdLog(interaction);

  // 정지된 유저: 모든 슬래시 명령어 차단
  if (!isAdmin(interaction.user.id) && isSuspended(interaction.user.id)) {
    return interaction.reply({
      components: [
        new ContainerBuilder()
          .setAccentColor(0xED4245)
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            '## 키가 정지되었습니다\n키를 해제하시거나 새로운 키를 입력하세요.'
          ))
          .addActionRowComponents(
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('enter_key').setLabel('키 입력하기').setStyle(ButtonStyle.Primary)
            )
          ),
      ],
      flags: CV2E,
    });
  }

  // 미활성화 유저: 사용법 제외 차단
  if (!['사용법', '키입력'].includes(interaction.commandName) && !isActivated(interaction.user.id)) {
    return interaction.reply({
      components: [
        new ContainerBuilder()
          .setAccentColor(0xED4245)
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            '## 활성화 필요\nDaymark를 사용하려면 **발급받은 키**를 `/키입력` 으로 입력해주세요.'
          ))
          .addActionRowComponents(
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setURL('https://reflo.store').setLabel('구매하기').setStyle(ButtonStyle.Link),
              new ButtonBuilder().setCustomId('enter_key').setLabel('키 입력하기').setStyle(ButtonStyle.Primary),
            )
          ),
      ],
      flags: CV2E,
    });
  }

  const handler = COMMAND_HANDLERS[interaction.commandName];
  if (handler) return handler(interaction);

  if (interaction.commandName === '내정보') {
    const user = getUser(interaction.user.id);
    if (!user) {
      return interaction.reply({
        components: [cResult(false, '등록된 계정 없음', '먼저 `/등록` 으로 계정을 등록해주세요.')],
        flags: CV2E,
      });
    }
    const streak = getStreak(interaction.user.id);
    const streakText = streak >= 2 ? `\n🔥  연속 회고: **${streak}일**` : '';

    const container = new ContainerBuilder()
      .setAccentColor(0xF1C40F)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('## 👤 내 계정 정보'))
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `📧  \`${user.email}\`${streakText}`
      ));

    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('open_settings').setLabel('⚙️ 설정').setStyle(ButtonStyle.Secondary),
        ),
      );

    return interaction.reply({ components: [container], flags: CV2E });
  }

  if (interaction.commandName === '설정') {
    const uid = interaction.user.id;
    if (!isProOrAbove(uid)) {
      return interaction.reply({ components: [cResult(false, '등록 필요', '먼저 `/등록` 으로 계정을 등록해주세요.')], flags: CV2E });
    }
    const buttons = [
      new ButtonBuilder().setCustomId('settings_auto_time').setLabel('⏰ 자동 회고').setStyle(ButtonStyle.Secondary),
    ];
    if (isPremiumUser(uid)) {
      buttons.push(
        new ButtonBuilder().setCustomId('settings_auto_schedule').setLabel('📋 자동 계획').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('settings_keywords').setLabel('📌 키워드').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('settings_thank_name').setLabel('💌 감사카드').setStyle(ButtonStyle.Secondary),
      );
    }
    return interaction.reply({
      components: [
        new ContainerBuilder()
          .setAccentColor(0xF1C40F)
          .addTextDisplayComponents(new TextDisplayBuilder().setContent('## ⚙️ 설정'))
          .addSeparatorComponents(new SeparatorBuilder())
          .addActionRowComponents(new ActionRowBuilder().addComponents(...buttons)),
      ],
      flags: CV2E,
    });
  }

  if (interaction.commandName === '대기') {
    const queueSize = queue.size + queue.pending; // /대기 명령어는 실행 중 포함해서 보여줌
    return interaction.reply({
      components: [queueSize === 0
        ? cResult(true, '대기 없음', '지금 바로 `/회고` 를 사용할 수 있어요!')
        : cInfo(`${EMOJI.PENDING} ${queueSize}명 대기 중`, `내 차례까지 잠시만 기다려주세요.`)
      ],
      flags: CV2E,
    });
  }

  if (interaction.commandName === '삭제') {
    const users = loadUsers();
    if (!users[interaction.user.id]) {
      return interaction.reply({
        components: [cResult(false, '등록된 계정 없음', '삭제할 계정이 없어요.')],
        flags: CV2E,
      });
    }
    deleteUser(interaction.user.id);
    return interaction.reply({
      components: [cResult(true, '계정 삭제 완료', '등록된 계정 정보가 삭제됐어요.\n-# 다시 사용하려면 `/등록` 으로 재등록해주세요.')],
      flags: CV2E,
    });
  }
});

// ── 내부 HTTP API (botstore 연동) ─────────────────────────────────────
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || '';
const INTERNAL_PORT   = parseInt(process.env.INTERNAL_PORT || '3001', 10);



createServer(async (req, res) => {
  const auth = req.headers['x-internal-secret'];
  if (!INTERNAL_SECRET || auth !== INTERNAL_SECRET) {
    res.writeHead(401); res.end('Unauthorized'); return;
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString()); }
  catch { res.writeHead(400); res.end('Bad JSON'); return; }

  const send = (code, data) => {
    const json = JSON.stringify(data);
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(json);
  };

  // POST /internal/activate — 구매/체험 후 유저 활성화
  if (req.method === 'POST' && req.url === '/internal/activate') {
    const { discord_id, plan, duration_days } = body;
    if (!discord_id || !plan || !duration_days) return send(400, { ok: false, error: 'missing fields' });
    const key = activateUserDirect(String(discord_id), plan, Number(duration_days));
    const expiresAt = loadKeys().userExpiry[String(discord_id)];
    return send(200, { ok: true, key, expires_at: expiresAt });
  }

  // POST /internal/revoke — 구독 만료/취소 시 수동 해제
  if (req.method === 'POST' && req.url === '/internal/revoke') {
    const { discord_id } = body;
    if (!discord_id) return send(400, { ok: false, error: 'missing discord_id' });
    const ok = revokeUser(String(discord_id));
    return send(200, { ok });
  }

  res.writeHead(404); res.end('Not found');
}).listen(INTERNAL_PORT, '127.0.0.1', () => {
  console.log(`✅ 내부 API 서버 실행 중: 127.0.0.1:${INTERNAL_PORT}`);
});

// ── 프리미엄 자동 회고 ────────────────────────────────────────────────
async function runAutoReflection(userId) {
  const user = getUser(userId);
  if (!user) return;
  const dateLabel = getTodayKST();
  if (hasSubmittedFor(userId, dateLabel)) return;

  const settings = getPremiumSettings(userId);
  const keywords = Array.isArray(settings.keywords) ? settings.keywords : [];
  const recentTopics = getRecentTopics(userId);

  const topic = keywords.length > 0
    ? await generateTopicFromKeywords(keywords, recentTopics)
    : await generateTopic(recentTopics);

  let reflection = await generateReflection(topic);
  for (let i = 0; i < 2 && reflection.length < 200; i++) {
    reflection = await generateReflection(topic);
  }

  const thankTargetName = settings.thankTargetName;
  const savedThank = getThankConfig(userId);
  const baseThank = thankTargetName
    ? { type: '친구', name: thankTargetName, message: '' }
    : (savedThank ? { ...savedThank, message: '' } : { type: '자신', name: '', message: '' });

  try {
    baseThank.message = await generateThankMessage(topic, reflection, baseThank.type, baseThank.name);
  } catch (e) {
    baseThank.message = '오늘도 수고했어!';
  }
  const thankConfig = baseThank;

  let result;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      result = await submitReflection(
        reflection, user.email, user.password, topic, null, () => {}, () => {}, thankConfig, isStealthUser(userId),
      );
      break;
    } catch (err) {
      if (attempt < 2) {
        console.error('[자동 회고] 1차 시도 실패 — 재시도 예정:', err.message);
        await new Promise(r => setTimeout(r, 3000));
      } else { throw err; }
    }
  }

  if (result !== 'already_done') {
    addRecentTopic(userId, topic);
    addSubmissionHistory(userId, dateLabel, topic, reflection);
    trackApi(userId, 'reflection');
    checkStreakMilestone(userId).catch(() => {});
  }

  try {
    const dUser = await client.users.fetch(userId);
    const preview = reflection.length > 400 ? reflection.slice(0, 400) + '...' : reflection;
    await dUser.send({
      components: [cResult(true, '✨ 자동 회고 완료', `📅 **${dateLabel}**  ·  📌 ${topic}\n\n> ${preview}\n\n-# Daymark · 자동 회고`)],
      flags: CV2,
    });
  } catch (e) { console.error('[자동 회고 DM 실패]', e.message); }
}

// ── /회고일괄 ──────────────────────────────────────────────────────────
async function handleBulkReflection(interaction) {
  const user = getUser(interaction.user.id);
  if (!user) {
    return interaction.reply({
      components: [cResult(false, '계정 없음', '먼저 `/등록` 으로 계정을 등록해주세요.')],
      flags: CV2E,
    });
  }
  if (!isProOrAbove(interaction.user.id)) {
    return interaction.reply({
      components: [cResult(false, '프리미엄 전용', '일괄 회고는 프리미엄 이상 플랜에서 사용할 수 있어요.')],
      flags: CV2E,
    });
  }

  const startInput = interaction.options.getString('시작');
  const endInput = interaction.options.getString('끝');
  const today = getTodayKST();

  const parseDate = (s) => {
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m = s.match(/^(\d{2})-(\d{2})$/);
    if (m) return `${getNowKST().getFullYear()}-${m[1]}-${m[2]}`;
    return null;
  };

  const startDate = parseDate(startInput);
  const endDate = parseDate(endInput);

  if (!startDate || !endDate) {
    return interaction.reply({
      components: [cResult(false, '날짜 형식 오류', '`YYYY-MM-DD` 또는 `MM-DD` 형식으로 입력해주세요.')],
      flags: CV2E,
    });
  }
  if (startDate >= endDate) {
    return interaction.reply({
      components: [cResult(false, '날짜 오류', '시작 날짜가 끝 날짜보다 앞이어야 해요.')],
      flags: CV2E,
    });
  }
  if (endDate > today) {
    return interaction.reply({
      components: [cResult(false, '미래 날짜 불가', '끝 날짜는 오늘 이하여야 해요.')],
      flags: CV2E,
    });
  }

  // 범위 내 날짜 목록 생성 (이미 제출된 날짜 제외)
  const dates = [];
  let cursor = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  while (cursor <= end) {
    const d = cursor.toISOString().split('T')[0];
    if (!hasSubmittedFor(interaction.user.id, d)) dates.push(d);
    cursor = new Date(cursor.getTime() + 86400000);
  }

  if (dates.length === 0) {
    return interaction.reply({
      components: [cResult(false, '모두 완료됨', `\`${startDate}\` ~ \`${endDate}\` 범위의 회고가 이미 모두 제출되어 있어요.`)],
      flags: CV2E,
    });
  }
  if (dates.length > 14) {
    return interaction.reply({
      components: [cResult(false, '범위 초과', `한 번에 최대 14일까지 가능해요. (현재 ${dates.length}일)`)],
      flags: CV2E,
    });
  }

  await interaction.reply({
    components: [cInfo('📦 일괄 회고 시작', `\`${startDate}\` ~ \`${endDate}\` 중 **${dates.length}일** 처리 시작\n완료 시 DM으로 결과를 알려드릴게요.\n-# 처리 중에는 다른 회고가 느려질 수 있어요.`)],
    flags: CV2E,
  });

  const userId = interaction.user.id;
  const settings = getPremiumSettings(userId);
  const savedThank = getThankConfig(userId);

  // 각 날짜를 큐에 순차 추가
  queue.add(async () => {
    const results = [];
    for (const date of dates) {
      try {
        const recentTopics = getRecentTopics(userId);
        const keywords = Array.isArray(settings.keywords) ? settings.keywords : [];
        const topic = keywords.length > 0
          ? await generateTopicFromKeywords(keywords, recentTopics)
          : await generateTopic(recentTopics);

        let reflection = await generateReflection(topic);
        for (let i = 0; i < 2 && reflection.length < 200; i++) {
          reflection = await generateReflection(topic);
        }

        const baseThank = savedThank
          ? { ...savedThank, message: '' }
          : { type: '자신', name: '', message: '' };
        try {
          baseThank.message = await generateThankMessage(topic, reflection, baseThank.type, baseThank.name);
        } catch {
          baseThank.message = '오늘도 수고했어!';
        }

        let result;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            result = await submitReflection(
              reflection, user.email, user.password, topic, date, () => {}, () => {}, baseThank, isStealthUser(userId),
            );
            break;
          } catch (err) {
            if (attempt < 2) {
              console.error(`[일괄 회고] ${date} 1차 실패 — 재시도:`, err.message);
              await new Promise(r => setTimeout(r, 3000));
            } else { throw err; }
          }
        }

        if (result !== 'already_done') {
          addRecentTopic(userId, topic);
          addSubmissionHistory(userId, date, topic, reflection);
          trackApi(userId, 'reflection');
        }
        results.push({ date, topic, ok: true });
        console.log(`[일괄 회고] ${date} 완료 — ${topic}`);
      } catch (e) {
        console.error(`[일괄 회고] ${date} 실패:`, e.message);
        results.push({ date, ok: false, error: e.message.slice(0, 80) });
      }
    }

    // 결과 DM
    try {
      const dUser = await client.users.fetch(userId);
      const okList = results.filter(r => r.ok).map(r => `✅ \`${r.date}\` · ${r.topic}`).join('\n');
      const failList = results.filter(r => !r.ok).map(r => `❌ \`${r.date}\` · ${r.error}`).join('\n');
      const body = [okList, failList ? `\n${failList}` : ''].join('').trim();
      await dUser.send({
        components: [cResult(true, `📦 일괄 회고 완료 (${results.filter(r => r.ok).length}/${results.length})`, body + '\n\n-# Daymark · 일괄 회고')],
        flags: CV2,
      });
    } catch (e) { console.error('[일괄 회고 DM 실패]', e.message); }
  }, { priority: 1 });
}

// ── 주간 AI 요약 (매주 일요일) ────────────────────────────────────────
async function sendWeeklySummary(userId) {
  const user = getUser(userId);
  if (!user) return;

  const history = getSubmissionHistory(userId);
  const now = getNowKST();
  const weekEntries = history.filter(e => {
    if (typeof e !== 'object' || !e.topic) return false;
    const diffDays = (now.getTime() - new Date(e.date + 'T00:00:00+09:00').getTime()) / 86400000;
    return diffDays >= 0 && diffDays < 7;
  });

  if (weekEntries.length === 0) return;

  const entrySummary = weekEntries.map(e => `- ${e.date}: ${e.topic}`).join('\n');
  const result = await generateWithRetry(
    `다음은 고등학생의 이번 주 회고 주제들입니다:\n${entrySummary}\n\n` +
    `이 주제들을 분석해서 이번 주 학습 성향과 성장 포인트를 2~3문장으로 요약해줘.\n` +
    `한국어, 응원의 메시지 포함, 따뜻하게 작성`,
    30_000,
  );
  const summary = result.response.text().trim();

  try {
    const dUser = await client.users.fetch(userId);
    await dUser.send({
      components: [
        new ContainerBuilder()
          .setAccentColor(0xF1C40F)
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `## 📊 이번 주 회고 AI 요약\n${summary}\n\n-# 이번 주 ${weekEntries.length}회 회고 · Daymark 프리미엄`
          )),
      ],
      flags: CV2,
    });
  } catch (e) { console.error('[주간 요약 DM 실패]', userId, e.message); }
}

// ── 월간 리포트 ───────────────────────────────────────────────────────
async function sendMonthlyReport(userId, year, month) {
  const user = getUser(userId);
  if (!user) return;
  const history = getSubmissionHistory(userId);
  const prefix = `${year}-${String(month).padStart(2, '0')}-`;
  const entries = history.filter(e => (typeof e === 'string' ? e : e.date).startsWith(prefix));
  if (entries.length === 0) return;

  const daysInMonth = new Date(year, month, 0).getDate();
  const rate = Math.round(entries.length / daysInMonth * 100);
  const topics = entries.filter(e => typeof e === 'object' && e.topic).map(e => e.topic);

  let aiLine = '';
  if (topics.length >= 3) {
    try {
      const r = await generateWithRetry(
        `이 학생의 지난 달 회고 주제들: ${topics.slice(0, 8).join(', ')}\n` +
        `성장 포인트를 한 문장(30자 이내)으로 응원해줘. 한국어만.`,
        15_000,
      );
      aiLine = `\n\n> ${r.response.text().trim().split('\n')[0]}`;
    } catch {}
  }

  const best = entries.length === daysInMonth ? '\n🏆 **개근 달성!**' : '';
  try {
    const dUser = await client.users.fetch(userId);
    await dUser.send({
      components: [
        new ContainerBuilder()
          .setAccentColor(0xF1C40F)
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `## 📈 ${year}년 ${month}월 회고 리포트\n` +
            `📅 제출 **${entries.length}회** / ${daysInMonth}일 (달성률 **${rate}%**)${best}${aiLine}\n\n` +
            `-# Daymark 프리미엄 · 이번 달도 화이팅!`
          )),
      ],
      flags: CV2,
    });
  } catch (e) { console.error('[월간 리포트 DM 실패]', userId, e.message); }
}

// ── 할일 자동 예약 (매일 자정, 오전 9~10시 슬롯) ─────────────────────
async function autoScheduleTasks(userId, windowStart = '09:00', windowEnd = '10:00') {
  const user = getUser(userId);
  if (!user) return;
  const dUser = await client.users.fetch(userId).catch(() => null);
  try {
    const { tasks } = await getTasksWithToken(user.email, user.password);
    if (!tasks.length) {
      await dUser?.send({ content: '📋 자동 계획: 등록된 할일이 없어서 건너뜀.' });
      return;
    }

    const today = getTodayKST();
    const target = tasks.slice(0, 5);
    const [sh, sm] = windowStart.split(':').map(Number);
    const [eh, em] = windowEnd.split(':').map(Number);
    const totalMin = (eh * 60 + em) - (sh * 60 + sm);
    const slotMin = Math.max(30, Math.floor(totalMin / target.length));
    const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

    for (let i = 0; i < target.length; i++) {
      const taskId = target[i].taskId ?? target[i].id;
      const startMin = sh * 60 + sm + slotMin * i;
      const endMin   = startMin + slotMin;
      await browserCreateSchedule(user.email, user.password, taskId, `${today}T${fmt(startMin)}:00`, `${today}T${fmt(endMin)}:00`);
      await new Promise(r => setTimeout(r, 500));
    }

    const names = target.map(t => getTaskName(t)).join(', ');
    await dUser?.send({
      components: [cResult(true, '할일 자동 예약', `오늘 할일이 **${windowStart} ~ ${windowEnd}** 사이에 등록됐어요.\n📌 ${names}\n\n-# Daymark 프리미엄`)],
      flags: CV2,
    });
  } catch (e) {
    console.error('[할일 자동 예약 실패]', userId, e.message);
    await dUser?.send({ content: `⚠️ 자동 계획 중 오류가 발생했어요.\n\`/계획하기\`로 직접 시도해 주세요.\n\`\`\`${e.message.slice(0, 200)}\`\`\`` }).catch(() => {});
  }
}

// ── 구독 만료 스케줄러 (매일 1회) ────────────────────────────────────
const WARNING_DAYS = parseInt(process.env.EXPIRY_WARNING_DAYS || '3', 10);

async function checkSubscriptionExpiry() {
  const keys = loadKeys();
  const now = Date.now();
  const warnMs = WARNING_DAYS * 24 * 60 * 60 * 1000;
  let changed = false;

  for (const [userId, expiresAt] of Object.entries(keys.userExpiry)) {
    if (!keys.activated[userId]) continue;
    if (isStealthUser(userId)) continue; // 비밀키 유저는 구독 만료 적용 안 함

    // 만료됨
    if (expiresAt < now) {
      const plan = keys.userPlan[userId] || 'basic';
      revokeUser(userId);
      changed = false; // revokeUser already saves

      try {
        const user = await client.users.fetch(userId);
        await user.send(
          `⏰ **Daymark 이용 기간이 만료됐어요.**\n\n` +
          `만료일: ${new Date(expiresAt).toLocaleDateString('ko-KR')}\n\n` +
          `계속 이용하시려면 관리자에게 문의해주세요.`
        );
      } catch (e) { console.warn(`[만료 DM 실패] ${userId}:`, e.message); }

      await sendExpiryLog({
        title: '🔴 구독 만료',
        color: 0xED4245,
        fields: [
          { name: '유저', value: `<@${userId}> (\`${userId}\`)`, inline: true },
          { name: '플랜', value: plan, inline: true },
          { name: '만료일', value: new Date(expiresAt).toLocaleDateString('ko-KR'), inline: true },
        ],
        timestamp: new Date().toISOString(),
      });
      continue;
    }

    // 만료 N일 전 경고 (미경고 유저만)
    if (expiresAt - now <= warnMs && !keys.warned.includes(userId)) {
      const daysLeft = Math.ceil((expiresAt - now) / 86400000);
      const plan = keys.userPlan[userId] || 'basic';
      keys.warned.push(userId);
      changed = true;

      try {
        const user = await client.users.fetch(userId);
        await user.send(
          `⚠️ **Daymark 이용 기간이 ${daysLeft}일 후 만료돼요.**\n\n` +
          `만료일: ${new Date(expiresAt).toLocaleDateString('ko-KR')}\n\n` +
          `계속 이용하시려면 관리자에게 문의해주세요.`
        );
      } catch (e) { console.warn(`[경고 DM 실패] ${userId}:`, e.message); }

      await sendExpiryLog({
        title: '🟡 구독 만료 임박',
        color: 0xFEE75C,
        fields: [
          { name: '유저', value: `<@${userId}> (\`${userId}\`)`, inline: true },
          { name: '플랜', value: plan, inline: true },
          { name: '남은 기간', value: `${daysLeft}일`, inline: true },
        ],
        timestamp: new Date().toISOString(),
      });
    }
  }

  if (changed) saveKeys();
}

// ── 봇 준비 ───────────────────────────────────────────────────────────
client.once('clientReady', async () => {
  console.log(`✅ 봇 실행 중: ${client.user.tag}`);

  // 앱 이모지 로드 (서버 이모지 대신 앱 이모지 사용 → 모든 서버에서 표시됨)
  try {
    const appEmojis = await client.application.emojis.fetch();
    const find = (name) => appEmojis.find(e => e.name === name);
    const done     = find('icon_done');
    const error    = find('ft_error');
    const progress = find('icon_progress');
    const pending  = find('icon_pending');
    const search   = find('ft_search');
    if (done)     EMOJI.DONE     = `<:${done.name}:${done.id}>`;
    if (error)    EMOJI.ERROR    = `<:${error.name}:${error.id}>`;
    if (progress) EMOJI.PROGRESS = `<:${progress.name}:${progress.id}>`;
    if (pending)  EMOJI.PENDING  = `<:${pending.name}:${pending.id}>`;
    if (search)   EMOJI.SEARCH   = `<:${search.name}:${search.id}>`;
    const loaded = [done && 'icon_done', error && 'ft_error', progress && 'icon_progress', pending && 'icon_pending', search && 'ft_search'].filter(Boolean);
    console.log(`✅ 앱 이모지 로드: ${loaded.length > 0 ? loaded.join(', ') : '없음 (유니코드 폴백)'}`);
  } catch (e) {
    console.warn('앱 이모지 로드 실패 — 유니코드 폴백 사용:', e.message);
  }

  const updateStatus = () => {
    const serverCount = Math.max(0, client.guilds.cache.size - 1);
    const userCount = Math.max(0, client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0) - 18);
    client.user.setPresence({
      activities: [{ name: `/회고 | ${serverCount}개 서버 | ${userCount.toLocaleString()}명 사용중`, type: 0 }],
      status: 'online',
    });
  };

  updateStatus();
  setInterval(updateStatus, 10 * 60 * 1000);

  // 구독 만료 체크 — 봇 시작 시 1회 + 매 12시간
  checkSubscriptionExpiry().catch(e => console.error('[만료 체크 오류]', e.message));
  setInterval(() => checkSubscriptionExpiry().catch(e => console.error('[만료 체크 오류]', e.message)), 12 * 60 * 60 * 1000);

  // ── 프리미엄 분단위 스케줄러 (자동 회고 + 리마인더 + 마감 알림 + 자동 계획) ──
  const reminderSentDates = new Map();
  const autoReflectionQueued = new Map();
  const nudgeSentDates = new Map();
  const autoScheduleRandomTimes = new Map(); // userId → { date, time }
  const autoScheduleQueued = new Map();      // userId → date
  setInterval(async () => {
    const now = getNowKST();
    const todayStr = getTodayKST();
    const iso = now.toISOString(); // getHours()는 로컬 TZ 기준이라 KST 서버/로컬 불일치 — ISO 문자열에서 추출
    const curH = iso.slice(11, 13);
    const curM = iso.slice(14, 16);
    const currentTime = `${curH}:${curM}`;

    const kstDayOfWeek = new Date(todayStr + 'T00:00:00Z').getUTCDay(); // 0=일, 6=토
    const isWeekend = kstDayOfWeek === 0 || kstDayOfWeek === 6;

    const users = loadUsers();
    for (const [userId] of Object.entries(users)) {
      if (!isProOrAbove(userId)) continue;
      const settings = getPremiumSettings(userId);

      // 자동 회고 + 리마인더
      const autoTime = settings.autoReflectionTime;
      if (autoTime && !isWeekend) {
        const [ah, am] = autoTime.split(':').map(Number);
        const remH = Math.floor((ah * 60 + am - 5 + 24 * 60) / 60) % 24;
        const remM = (am - 5 + 60) % 60;
        const reminderTime = `${String(remH).padStart(2, '0')}:${String(remM).padStart(2, '0')}`;

        if (currentTime === reminderTime && reminderSentDates.get(userId) !== todayStr) {
          reminderSentDates.set(userId, todayStr);
          try {
            const dUser = await client.users.fetch(userId);
            await dUser.send({
              components: [cInfo('🔔 자동 회고 5분 전!', `**${autoTime}**에 회고가 자동으로 시작돼요.\n-# Daymark 프리미엄`)],
              flags: CV2,
            });
          } catch (e) { console.error('[리마인더 DM 실패]', userId, e.message); }
        }

        if (currentTime === autoTime && autoReflectionQueued.get(userId) !== todayStr && !hasSubmittedFor(userId, todayStr)) {
          autoReflectionQueued.set(userId, todayStr);
          queue.add(async () => {
            try { await runAutoReflection(userId); }
            catch (e) {
              console.error('[자동 회고 오류]', userId, e.message);
              try {
                const dUser = await client.users.fetch(userId);
                await dUser.send({ content: `⚠️ 자동 회고 중 오류가 발생했어요.\n\`/회고초기화\` 후 \`/회고\`로 다시 시도해 주세요.\n\`\`\`${e.message.slice(0, 200)}\`\`\`` });
              } catch {}
            }
          }, { priority: 1 });
        }
      }

      // 자동 계획 (설정된 시간대 내 랜덤 시각, 주말 제외)
      if (isPremiumUser(userId) && !isWeekend) {
        const win = settings.autoScheduleWindow;
        if (win && Date.now() - win.setAt < 30 * 24 * 60 * 60 * 1000) {
          // 오늘 랜덤 시각 아직 없으면 생성
          const stored = autoScheduleRandomTimes.get(userId);
          let randomTime;
          if (!stored || stored.date !== todayStr) {
            const [sh, sm] = win.start.split(':').map(Number);
            const [eh, em] = win.end.split(':').map(Number);
            const rangeMin = (eh * 60 + em) - (sh * 60 + sm);
            const offset = Math.floor(Math.random() * rangeMin);
            const totalMin = sh * 60 + sm + offset;
            randomTime = `${String(Math.floor(totalMin / 60)).padStart(2, '0')}:${String(totalMin % 60).padStart(2, '0')}`;
            autoScheduleRandomTimes.set(userId, { date: todayStr, time: randomTime });
          } else {
            randomTime = stored.time;
          }
          // 계획하기 5분 전 알림
          const [rh, rm] = randomTime.split(':').map(Number);
          const schedRemH = Math.floor((rh * 60 + rm - 5 + 24 * 60) / 60) % 24;
          const schedRemM = (rm - 5 + 60) % 60;
          const schedReminderTime = `${String(schedRemH).padStart(2, '0')}:${String(schedRemM).padStart(2, '0')}`;
          if (currentTime === schedReminderTime && reminderSentDates.get(`sched_${userId}`) !== todayStr) {
            reminderSentDates.set(`sched_${userId}`, todayStr);
            try {
              const dUser = await client.users.fetch(userId);
              await dUser.send({
                components: [cInfo('🔔 자동 계획하기 5분 전!', `**${randomTime}**에 오늘 할 일이 자동으로 등록돼요.\n-# Daymark 프리미엄`)],
                flags: CV2,
              });
            } catch (e) { console.error('[계획 리마인더 DM 실패]', userId, e.message); }
          }

          if (currentTime === randomTime && autoScheduleQueued.get(userId) !== todayStr) {
            autoScheduleQueued.set(userId, todayStr);
            try { await autoScheduleTasks(userId, win.start, win.end); }
            catch (e) { console.error('[자동 계획 오류]', userId, e.message); }
          }
        }
      }

    }

    // ── 오후 8:40 회고 권유 알림 ───────────────────────────
    if (currentTime === '20:40' && !isWeekend) {
      for (const [userId] of Object.entries(users)) {
        if (!isActivated(userId)) continue;
        if (!getUser(userId)) continue;
        if (hasSubmittedFor(userId, todayStr)) continue;
        if (nudgeSentDates.get(userId) === todayStr) continue;
        nudgeSentDates.set(userId, todayStr);
        try {
          const dUser = await client.users.fetch(userId);
          await dUser.send({
            components: [
              new ContainerBuilder()
                .setAccentColor(0x5865F2)
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                  `## 📝 오늘 회고 하셨나요?\n지금이 딱 회고하기 좋은 시간이에요!\n\`/회고\` 명령어로 오늘 하루를 기록해보세요. 🌙`
                )),
            ],
            flags: CV2,
          });
        } catch (e) { console.error('[회고 권유 DM 실패]', userId, e.message); }
      }
    }
  }, 30 * 1000);

  // ── 프리미엄 일간 스케줄러 (할일 예약 + 주간 요약 + 월간 리포트) ──
  let lastDailyRun = '';
  setInterval(async () => {
    const now = getNowKST();
    if (parseInt(now.toISOString().slice(11, 13)) !== 0) return;
    const todayStr = getTodayKST();
    if (todayStr === lastDailyRun) return;
    lastDailyRun = todayStr;

    const isSunday = now.getDay() === 0;
    const isFirstOfMonth = now.getDate() === 1;
    const prevMonth = now.getMonth() === 0 ? 12 : now.getMonth();
    const prevMonthYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    const users = loadUsers();

    for (const [userId] of Object.entries(users)) {
      if (!isProOrAbove(userId) || !getUser(userId)) continue;

      if (isSunday) {
        setTimeout(async () => {
          try { await sendWeeklySummary(userId); }
          catch (e) { console.error('[주간 요약 오류]', userId, e.message); }
        }, 2000);
      }

      if (!isPremiumUser(userId)) continue;

      // 자동 계획은 분 스케줄러에서 랜덤 시각에 처리 (일간 고정 호출 제거)

      if (isFirstOfMonth) {
        setTimeout(async () => {
          try { await sendMonthlyReport(userId, prevMonthYear, prevMonth); }
          catch (e) { console.error('[월간 리포트 오류]', userId, e.message); }
        }, 4000);
      }
    }
  }, 10 * 60 * 1000);

  // 슬래시 명령어 등록 (항상 실행)
  const commands = [
    new SlashCommandBuilder()
      .setName('회고')
      .setDescription('뉴로우 회고를 자동으로 생성하고 제출합니다')
      .addStringOption((o) => o.setName('주제').setDescription('회고할 주제 (비워두면 AI가 자동 추천)').setRequired(false))
      .addStringOption((o) => o.setName('날짜').setDescription('회고 날짜 (기본값: 오늘) — YYYY-MM-DD 또는 MM-DD 형식').setRequired(false))
      .toJSON(),
    new SlashCommandBuilder().setName('키입력').setDescription('구매 후 발급받은 키를 입력해 활성화합니다').toJSON(),
    new SlashCommandBuilder().setName('사용법').setDescription('Daymark 봇 사용법을 안내합니다').toJSON(),
    new SlashCommandBuilder().setName('등록').setDescription('뉴로우 계정을 등록합니다').toJSON(),
    new SlashCommandBuilder().setName('변경').setDescription('등록된 뉴로우 계정 정보를 변경합니다').toJSON(),
    new SlashCommandBuilder().setName('내정보').setDescription('등록된 뉴로우 계정 정보를 확인합니다').toJSON(),
    new SlashCommandBuilder().setName('대기').setDescription('현재 회고 대기열을 확인합니다').toJSON(),
    new SlashCommandBuilder().setName('삭제').setDescription('등록된 뉴로우 계정을 삭제합니다').toJSON(),
    new SlashCommandBuilder().setName('감사카드').setDescription('감사 카드 설정을 저장합니다 (회고 시 자동 적용)').toJSON(),
    new SlashCommandBuilder().setName('주제추천').setDescription('AI가 오늘의 회고 주제를 3개 추천해줍니다').toJSON(),
    new SlashCommandBuilder().setName('히스토리').setDescription('나의 회고 제출 히스토리를 달력으로 확인합니다').toJSON(),
    new SlashCommandBuilder()
      .setName('회고초기화')
      .setDescription('오늘 작성 중인 회고를 초기화합니다 (처음부터 다시 시작)')
      .addStringOption(o => o.setName('날짜').setDescription('초기화할 날짜 (기본값: 오늘) — YYYY-MM-DD 또는 MM-DD').setRequired(false))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('기록')
      .setDescription('제출한 회고 내용을 날짜별로 확인합니다')
      .addIntegerOption(o => o.setName('페이지').setDescription('페이지 번호 (기본값: 1)').setRequired(false).setMinValue(1))
      .toJSON(),
    new SlashCommandBuilder().setName('계획하기').setDescription('할일을 선택해 캘린더에 일정을 등록합니다').toJSON(),
    new SlashCommandBuilder().setName('통계').setDescription('나의 회고 통계를 확인합니다 (프리미엄)').toJSON(),
    new SlashCommandBuilder().setName('설정').setDescription('봇 설정을 변경합니다').toJSON(),
    new SlashCommandBuilder()
      .setName('회고일괄')
      .setDescription('특정 날짜 범위의 회고를 한 번에 제출합니다 (프리미엄)')
      .addStringOption(o => o.setName('시작').setDescription('시작 날짜 — YYYY-MM-DD 또는 MM-DD').setRequired(true))
      .addStringOption(o => o.setName('끝').setDescription('끝 날짜 — YYYY-MM-DD 또는 MM-DD').setRequired(true))
      .toJSON(),
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  // 글로벌 명령어 등록 (업데이트 반영 최대 1시간 소요 — 길드 방식으로 전환)
  // await rest.put(Routes.applicationCommands(client.application.id), { body: commands });
  await rest.put(Routes.applicationCommands(client.application.id), { body: [] }).catch(() => {}); // 글로벌 명령어 전체 삭제 (1회 실행 후 주석 처리 예정)
  // 길드 명령어 등록 (즉시 반영)
  for (const guild of client.guilds.cache.values()) {
    await rest.put(Routes.applicationGuildCommands(client.application.id, guild.id), { body: commands }).catch(() => {});
  }
  console.log('✅ 슬래시 명령어 등록 완료 (길드)');

});

client.login(process.env.DISCORD_TOKEN);




