import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import 'dotenv/config';

const DATA_DIR = '.';

// Playwright 에러 → 간결한 한국어 메시지
function stepError(step, err) {
  const msg = err?.message ?? String(err);
  // Playwright timeout: "locator.waitFor: Timeout 20000ms exceeded.\nCall log:\n  - waiting for..."
  const timeoutMatch = msg.match(/Timeout (\d+)ms exceeded/);
  if (timeoutMatch) {
    const waitingFor = msg.match(/waiting for (.+?)(?:\n|$)/)?.[1] ?? '요소';
    return new Error(`[${step}] 시간 초과 — ${waitingFor}`);
  }
  return new Error(`[${step}] ${msg.split('\n')[0]}`);
}
mkdirSync(DATA_DIR, { recursive: true });

// 버튼이 disabled 아닐 때까지 최대 ms 대기
async function expect_enabled(locator, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const disabled = await locator.getAttribute('disabled');
    if (disabled === null) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('버튼이 활성화되지 않았습니다 (timeout)');
}

// CSS 트랜지션/React 리렌더 settle용 — 2 rAF
async function rAF(page) {
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
}

// 현재 활성 단계 감지 — 활성(미완료) UI 요소 기반
// 반환값: 'diagnosis' | 'lookback' | 'topic' | 'writing' | 'thinking' | 'confirm' | 'action' | 'share' | 'thanks' | 'end' | 'done' | 'unknown'
async function detectCurrentStep(page) {
  return page.evaluate(() => {
    if (document.body.textContent.includes('일일 회고를 모두 작성하셨어요')) return 'done';
    if ([...document.querySelectorAll('button')].some(b => b.textContent.includes('오늘의 회고 끝내기'))) return 'end';
    if ([...document.querySelectorAll('button')].some(b => b.textContent.includes('감사카드 보내기'))) return 'thanks';
    const thankTypes = ['선생님', '친구', '자신'];
    if (thankTypes.some(l => [...document.querySelectorAll('button:not([disabled])')].some(b => b.textContent.trim() === l))) return 'thanks';
    if (document.querySelector('[class*="select-common"]') ||
        (document.body.textContent.includes('공유 대상') && document.querySelector('button:not([disabled])'))) return 'share';
    if ([...document.querySelectorAll('button')].some(b => b.textContent.includes('다음에 할게요'))) return 'action';
    if ([...document.querySelectorAll('button')].some(b => b.textContent.includes('작성한 회고 확인하기'))) return 'confirm';
    if ([...document.querySelectorAll('button')].some(b => b.textContent.includes('넘어갈게요'))) return 'thinking';
    if (document.querySelector('textarea[data-uix-name="Textarea"]:not([disabled])')) return 'writing';
    if (document.querySelector('[class*="ChoiceTaskActionBox-module__elseTask"]')) return 'topic';
    if (document.querySelector('[class*="inputTaskBox"] input:not([disabled])')) return 'topic';
    const emotionLabels = ['뿌듯한', '행복한', '만족한', '신나는', '슬픈', '힘든', '고요한'];
    if (emotionLabels.some(l => [...document.querySelectorAll('button:not([disabled])')].some(b => b.textContent.trim() === l))) return 'lookback';
    if (document.querySelector('[class*="satisfactionFilter"]:not([disabled])')) return 'lookback';
    // 자가 점검: 활성(미완료) 항목 있는지 확인
    const activeScore = [...document.querySelectorAll('button:not([disabled])')].filter(b => /^[1-9]점/.test(b.textContent.trim()));
    if (activeScore.length > 0) return 'diagnosis';
    for (const q of document.querySelectorAll('[class*="DiagnosisActionBox-module__container"]')) {
      const btns = [...q.querySelectorAll('button[class*="TypeSelector-module__selector"]')];
      if (!btns.length) continue;
      const isRating = btns.some(b => /^\d+점$/.test(b.querySelector('span.ellipsis')?.getAttribute('title') || ''));
      const selected = btns.filter(b => b.className.includes('selected')).length;
      if (selected < (isRating ? 1 : 3)) return 'diagnosis';
    }
    return 'unknown';
  });
}

// 확인 버튼 클릭 — 2단계 전략
// Phase 1 (2회): evaluate.click + mouse.click (빠른 시도)
// Phase 2 (5회): 조상 차단 해제 + 뷰포트 중앙 스크롤 + 포인터 시퀀스 + 키보드 fallback
// successCheck: () => Promise<boolean> — 다음 단계 등장 여부 반환 함수
async function forceClickConfirm(page, successCheck, label = '확인') {
  // ── Phase 1: 빠른 클릭 2회 ──
  for (let attempt = 0; attempt < 2; attempt++) {
    // evaluate.click (빠름)
    await page.evaluate((btnLabel) => {
      const btn = [...document.querySelectorAll('button')]
        .filter(b => b.textContent.trim() === btnLabel && !b.disabled).pop();
      if (btn) btn.click();
    }, label);
    // mouse.click 보조
    const cfBtn = page.locator(`button:has-text("${label}"):not([disabled])`).last();
    const cfBox = await cfBtn.boundingBox().catch(() => null);
    if (cfBox) await page.mouse.click(cfBox.x + cfBox.width / 2, cfBox.y + cfBox.height / 2);
    console.log(`[Phase1] 확인 클릭 (시도 ${attempt + 1})`);

    const ok = await successCheck().catch(() => false);
    if (ok) { console.log(`[Phase1] 성공 (시도 ${attempt + 1})`); return true; }
    if (attempt < 1) await new Promise(r => setTimeout(r, 200));
  }
  console.log('[Phase1] 2회 실패 → Phase2 진입');

  // ── Phase 2: 강제 클릭 5회 ──
  for (let attempt = 0; attempt < 5; attempt++) {
    // 버튼 뷰포트 중앙 이동 + 조상 pointer-events 해제 + 신선한 좌표 획득
    const coords = await page.evaluate((btnLabel) => {
      const btn = [...document.querySelectorAll('button')]
        .filter(b => b.textContent.trim() === btnLabel && !b.disabled).pop();
      if (!btn) return null;
      let el = btn;
      while (el && el !== document.body) {
        el.style.pointerEvents = 'auto';
        el.style.visibility = 'visible';
        el.style.opacity = '1';
        el = el.parentElement;
      }
      btn.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      const r = btn.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, label);

    if (!coords) {
      console.log(`[Phase2] 버튼 없음 (시도 ${attempt + 1}) — 이미 다음 단계로 진행됨`);
      return true;
    }

    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

    // mousedown → 80ms → mouseup (실제 포인터 시퀀스)
    await page.mouse.move(coords.x, coords.y);
    await page.mouse.down();
    await new Promise(r => setTimeout(r, 80));
    await page.mouse.up();
    console.log(`[Phase2] 포인터 클릭 (시도 ${attempt + 1}): (${Math.round(coords.x)}, ${Math.round(coords.y)})`);

    const ok = await successCheck().catch(() => false);
    if (ok) { console.log(`[Phase2] 성공 (시도 ${attempt + 1})`); return true; }

    // 포인터 실패 → 키보드 Enter (완전히 다른 경로)
    await page.keyboard.press('Enter');
    const ok2 = await successCheck().catch(() => false);
    if (ok2) { console.log(`[Phase2] 키보드 Enter 성공 (시도 ${attempt + 1})`); return true; }

    await new Promise(r => setTimeout(r, 400));
  }
  // ── Phase 3: 페이지 새로고침 후 재확인 (사이트 버그 대응) ──
  // 클릭은 됐지만 UI가 반응 안 하는 경우, 새로고침하면 이미 다음 단계로 넘어가 있을 수 있음
  console.log('[forceClickConfirm] Phase3: 페이지 새로고침 후 재확인');
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => {
      const root = document.querySelector('#root');
      return root && root.children.length > 0 && !root.hasAttribute('aria-hidden');
    }, { timeout: 8000 }).catch(() => {});
    // 로그인 팝업 닫기 (inline)
    await page.evaluate(() => {
      const popup = document.querySelector('[class*="loginHistoryPopup-module__popup"]');
      const btns = popup?.querySelectorAll('button');
      if (btns?.length) btns[btns.length - 1].click();
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));

    const okAfterReload = await successCheck().catch(() => false);
    if (okAfterReload) {
      console.log('[Phase3] 새로고침 후 이미 다음 단계 — 성공');
      return true;
    }
    // 여전히 같은 단계라면 버튼 1회 재시도
    await page.waitForFunction((btnLabel) =>
      [...document.querySelectorAll('button')].some(b => b.textContent.trim() === btnLabel && !b.disabled)
    , label, { timeout: 8000 }).catch(() => {});
    await page.evaluate((btnLabel) => {
      const btn = [...document.querySelectorAll('button')]
        .filter(b => b.textContent.trim() === btnLabel && !b.disabled).pop();
      if (btn) btn.click();
    }, label);
    await new Promise(r => setTimeout(r, 800));
    const okRetry = await successCheck().catch(() => false);
    console.log(`[Phase3] 새로고침 후 재시도: ${okRetry}`);
    return okRetry;
  } catch (e) {
    console.log('[Phase3] 새로고침 실패:', e.message);
  }

  console.log('[forceClickConfirm] Phase1 2회 + Phase2 5회 + Phase3(새로고침) 모두 실패');
  return false;
}

// 로그인 안내 팝업이 있으면 닫기 (portal 렌더링이라 page 전체에서 탐색)
export async function dismissLoginPopup(page) {
  try {
    const popup = await page.waitForSelector('[class*="loginHistoryPopup-module__popup"]', { timeout: 4000 });
    if (!popup) return;
    console.log('로그인 팝업 감지 — 닫는 중...');

    // 푸터 확인 버튼 클릭 시도 1: 클래스 선택자
    let clicked = false;
    try {
      const btn = page.locator('[class*="loginHistoryPopupFooter-module__footer"] button').last();
      await btn.waitFor({ state: 'visible', timeout: 2000 });
      await btn.click();
      clicked = true;
    } catch { /* 무시 */ }

    // 시도 2: popup 안의 마지막 버튼
    if (!clicked) {
      try {
        const btn = page.locator('[class*="loginHistoryPopup-module__popup"] button').last();
        await btn.waitFor({ state: 'visible', timeout: 2000 });
        await btn.click();
        clicked = true;
      } catch { /* 무시 */ }
    }

    // 시도 3: page.evaluate 로 직접
    if (!clicked) {
      await page.evaluate(() => {
        const popup = document.querySelector('[class*="loginHistoryPopup-module__popup"]');
        const btns = popup?.querySelectorAll('button');
        if (btns?.length) btns[btns.length - 1].click();
      });
    }

    console.log('로그인 팝업 닫힘 — aria-hidden 해제 대기 중...');
    // #root 의 aria-hidden 이 풀릴 때까지 대기
    await page.waitForFunction(
      () => !document.querySelector('#root')?.hasAttribute('aria-hidden'),
      { timeout: 6000 }
    );
    // 팝업 DOM 에서 완전히 제거될 때까지 대기
    await page.waitForFunction(
      () => !document.querySelector('[class*="loginHistoryPopup-module__popup"]'),
      { timeout: 2000 }
    ).catch(() => {});
    console.log('팝업 해제 완료');
  } catch {
    // 팝업 없으면 조용히 통과
  }
}

export async function login(page, email, password) {
  console.log('로그인 중... 현재 URL:', page.url());

  const EMAIL_SEL = '#accountId, input[type="email"], input[name="username"], input[name="email"]';
  const PW_SEL = '#accountPassword, input[type="password"]';
  const SUBMIT_SEL = '#loginSubmit, button[type="submit"]';

  let frame = page.mainFrame();
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    const cnt = await f.locator(EMAIL_SEL).count().catch(() => 0);
    if (cnt > 0) {
      frame = f;
      console.log('[login] 로그인 폼 iframe 내 발견:', f.url());
      break;
    }
  }

  const emailInput = frame.locator(EMAIL_SEL).first();
  const pwInput = frame.locator(PW_SEL).first();
  const submitBtn = frame.locator(SUBMIT_SEL).first();

  await emailInput.waitFor({ state: 'visible', timeout: 10000 }).catch(e => { throw stepError('로그인 폼 로딩', e); });
  console.log('[login] 로그인 폼 발견 — 입력 중...');
  // fill()은 React controlled input에 직접 값 주입 (keystroke 없음, 즉각)
  await emailInput.fill(email);
  await pwInput.fill(password);
  await submitBtn.click();
  console.log('[login] 로그인 폼 제출 완료');

  // URL 폴링으로 로그인 결과 확인 (최대 60초)
  let result = 'timeout';
  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(500);
    const url = page.url();
    const body = await page.evaluate(() => document.body?.textContent ?? '').catch(() => '');
    if (url.includes('/csr-platform/') || url.includes('newrrow.com/csr')) {
      result = 'success';
      break;
    }
    if (body.includes('일치하지 않습니다')) {
      result = 'invalid_credentials';
      break;
    }
  }

  if (result === 'invalid_credentials') {
    const err = new Error('이메일 또는 비밀번호가 올바르지 않아요. `/변경` 으로 계정 정보를 수정해주세요.');
    err.code = 'INVALID_CREDENTIALS';
    throw err;
  }
  if (result === 'timeout') throw new Error('로그인 시간 초과');

  // OAuth 콜백 처리 후 React 앱이 localStorage/cookie에 세션 토큰을 쓸 때까지 대기
  // URL이 csr-platform에 도달한 직후 storageState를 저장하면 토큰이 아직 미기록 상태로
  // 저장되어 다음 goto에서 다시 로그인 페이지로 튕기는 문제가 발생함
  // React 앱이 세션 토큰을 localStorage/cookie에 쓸 때까지 대기
  // (#root 렌더링 완료로 충분 — networkidle은 SPA에서 너무 오래 걸림)
  await page.waitForFunction(() => {
    const root = document.querySelector('#root');
    return root && root.children.length > 0 && !root.hasAttribute('aria-hidden');
  }, { timeout: 10000 }).catch(() => {});
  console.log('로그인 성공');
}

export async function resetReflection(email, password, date = null) {
  const targetDate = date ?? new Date().toISOString().split('T')[0];
  const reflectionUrl = `https://dgsm.newrrow.com/csr-platform/reflection/daily/chat-type?date=${targetDate}`;

  const isHeadless = process.env.HEADLESS !== 'false';
  const browser = await chromium.launch({
    headless: isHeadless,
    args: isHeadless ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] : [],
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  let token = null, reflectionId = null;
  page.on('request', req => {
    const url = req.url();
    const auth = req.headers()['authorization'];
    if (auth?.startsWith('Bearer ')) token = auth.slice(7);
    const m = url.match(/\/daily-reflections\/(\d+)/);
    if (m) reflectionId = m[1];
    // 모든 요청 URL 출력 (디버그)
    if (url.includes('newrrow') || url.includes('inhrplus') || url.includes('api-agw')) console.log(`[회고초기화][REQ] ${req.method()} ${url}`);
  });
  page.on('response', async res => {
    try {
      const url = res.url();
      if (!url.includes('newrrow') && !url.includes('inhrplus') && !url.includes('api-agw')) return;
      // 응답 URL 전부 출력 (디버그)
      console.log(`[회고초기화][RES] ${res.status()} ${url}`);
      if (reflectionId) return;
      const ct = res.headers()['content-type'] ?? '';
      if (!ct.includes('application/json')) return;
      const body = await res.json().catch(() => null);
      if (!body) return;
      console.log(`[회고초기화][BODY] ${url} →`, JSON.stringify(body).slice(0, 200));
      // { id }, { data: { id } }, { data: [{ id }] } 형태 처리
      const id = body?.id ?? body?.data?.id ?? (Array.isArray(body?.data) ? body.data[0]?.id : null) ?? (Array.isArray(body) ? body[0]?.id : null);
      if (id) { reflectionId = String(id); console.log(`[회고초기화] reflectionId 캡처 (response): ${reflectionId}`); }
    } catch {}
  });

  try {
    await page.goto(reflectionUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const loginDeadline = Date.now() + 15000;
    while (Date.now() < loginDeadline) {
      await page.waitForTimeout(500);
      const curUrl = page.url();
      if (curUrl.includes('/csr-platform/')) break;
      if (curUrl.includes('inhrplus.com') || curUrl.includes('/login')) {
        await login(page, email, password);
        await page.goto(reflectionUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForURL(url => url.includes('/csr-platform/'), { timeout: 15000 }).catch(() => {});
        break;
      }
    }
    await dismissLoginPopup(page);

    const deadline = Date.now() + 12000;
    while (!(token && reflectionId) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
      const curUrl = page.url();
      if (curUrl.includes('inhrplus.com') || curUrl.includes('/login')) {
        console.log('[회고초기화] 폴링 중 로그인 리다이렉트 감지 — 재로그인');
        await login(page, email, password);
        await page.goto(reflectionUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForURL(url => url.includes('/csr-platform/'), { timeout: 10000 }).catch(() => {});
        await dismissLoginPopup(page);
      }
    }
    console.log(`[회고초기화] 캡처 결과: token=${!!token} reflId=${reflectionId}`);

    if (!token || !reflectionId) throw new Error(`데이터 캡처 실패 (token=${!!token} reflId=${reflectionId})`);

    const NEWRROW_API = 'https://api-agw-backend.inhrplus.com';
    const status = await page.evaluate(async ({ url, headers }) => {
      try { return (await fetch(url, { method: 'DELETE', headers })).status; }
      catch { return 0; }
    }, {
      url: `${NEWRROW_API}/main/api/v1/daily-reflections/${reflectionId}`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Tenant': 'dgsm',
        'Origin': 'https://dgsm.newrrow.com',
        'Accept': 'application/json, text/plain, */*',
      },
    });
    console.log(`[회고초기화] DELETE ${reflectionId}: ${status}`);
    if (status < 200 || status >= 300) throw new Error(`DELETE 실패 (status=${status})`);
    return { reflectionId, date: targetDate };
  } finally {
    await browser.close();
  }
}

export async function getTasksWithToken(email, password) {
  const isHeadless = process.env.HEADLESS !== 'false';
  const browser = await chromium.launch({
    headless: isHeadless,
    args: isHeadless ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] : [],
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  let token = null;
  let tasksFromResponse = null;
  page.on('request', req => {
    if (!req.url().includes('api-agw')) return;
    const auth = req.headers()['authorization'];
    if (auth?.startsWith('Bearer ')) token = auth.slice(7);
  });
  page.on('response', async res => {
    if (!res.url().includes('my-tasks')) return;
    try { tasksFromResponse = await res.json(); } catch {}
  });

  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().split('T')[0];
  const tokenPage = `https://dgsm.newrrow.com/csr-platform/reflection/daily/chat-type?date=${today}`;

  try {
    await page.goto(tokenPage, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForURL(
      url => url.includes('inhrplus.com') || url.includes('/csr-platform/'),
      { timeout: 10000 }
    ).catch(() => {});
    if (page.url().includes('login') || page.url().includes('inhrplus.com')) {
      await login(page, email, password);
      await page.goto(tokenPage, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForURL(url => url.includes('/csr-platform/'), { timeout: 10000 }).catch(() => {});
    }
    await dismissLoginPopup(page);

    const deadline = Date.now() + 12000;
    while (!token && Date.now() < deadline) {
      await page.waitForTimeout(500);
      const curUrl = page.url();
      if (curUrl.includes('inhrplus.com') || curUrl.includes('/login')) {
        await login(page, email, password);
        await page.goto(tokenPage, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForURL(url => url.includes('/csr-platform/'), { timeout: 10000 }).catch(() => {});
        await dismissLoginPopup(page);
      }
    }

    if (!token) throw new Error('토큰 캡처 실패');

    // tasks 페이지로 이동해서 API 호출 유도 (response interceptor가 캡처)
    if (!tasksFromResponse) {
      await page.goto('https://dgsm.newrrow.com/csr-platform/my-task', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(4000);
    }

    // 그래도 없으면 브라우저 컨텍스트에서 직접 호출 (올바른 도메인: api-agw.newrrow.com)
    if (!tasksFromResponse) {
      tasksFromResponse = await page.evaluate(async (tok) => {
        const res = await fetch('https://api-agw.newrrow.com/main/api/v2/my-tasks/csr', {
          headers: {
            'Authorization': `Bearer ${tok}`,
            'Tenant': 'dgsm',
            'Accept': 'application/json, text/plain, */*',
          },
        });
        return res.json();
      }, token);
    }

    const rawTasks = tasksFromResponse?.contents?.tasks ?? tasksFromResponse?.contents ?? tasksFromResponse?.data?.tasks ?? tasksFromResponse?.tasks ?? [];
    const tasks = (Array.isArray(rawTasks) ? rawTasks : []).filter(t => t.taskId != null || t.id != null);

    const cookies = await context.cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    return { token, tasks, cookieHeader };
  } finally {
    await browser.close();
  }
}

async function _loginAndGetPage(email, password) {
  const isHeadless = process.env.HEADLESS !== 'false';
  const browser = await chromium.launch({
    headless: isHeadless,
    args: isHeadless ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] : [],
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  let token = null;
  page.on('request', req => {
    const auth = req.headers()['authorization'];
    if (auth?.startsWith('Bearer ')) token = auth.slice(7);
  });

  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().split('T')[0];
  const tokenPage = `https://dgsm.newrrow.com/csr-platform/reflection/daily/chat-type?date=${today}`;

  await page.goto(tokenPage, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // redirect 대기 후 로그인 (getTasksWithToken 방식 동일)
  const loginDeadline = Date.now() + 15000;
  while (Date.now() < loginDeadline) {
    await page.waitForTimeout(500);
    const curUrl = page.url();
    if (curUrl.includes('/csr-platform/')) break;
    if (curUrl.includes('inhrplus.com') || curUrl.includes('/login')) {
      await login(page, email, password);
      await page.goto(tokenPage, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForURL(url => url.includes('/csr-platform/'), { timeout: 15000 }).catch(() => {});
      break;
    }
  }
  await dismissLoginPopup(page);

  // token 캡처 대기 (최대 8초)
  const deadline = Date.now() + 8000;
  while (!token && Date.now() < deadline) await page.waitForTimeout(500);

  // 그래도 없으면 my-task 페이지로 이동해 API 요청 유도
  if (!token) {
    await page.goto('https://dgsm.newrrow.com/csr-platform/my-task', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    const d2 = Date.now() + 8000;
    while (!token && Date.now() < d2) await page.waitForTimeout(500);
  }

  console.log(`[_loginAndGetPage] token ${token ? '캡처 성공 ('+token.slice(0,20)+'...)' : '캡처 실패(null)'}`);
  return { browser, page, token };
}

// 브라우저 컨텍스트 안에서 API 호출 (page.request — CORS 우회, 쿠키 포함)
async function _contextPost(page, token, url, body) {
  const res = await page.request.post(url, {
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'Tenant': 'dgsm',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    },
    data: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status(), data };
}

export async function browserCreateTask(email, password, title) {
  const { browser, page, token } = await _loginAndGetPage(email, password);
  try {
    return await _contextPost(page, token, 'https://api-agw.newrrow.com/main/api/v1/tasks', { goalId: null, title });
  } finally {
    await browser.close();
  }
}

export async function browserCreateSchedule(email, password, taskId, startDateTime, endDateTime) {
  const { browser, page, token } = await _loginAndGetPage(email, password);
  try {
    return await _contextPost(page, token, 'https://api-agw.newrrow.com/main/api/v2/schedules', {
      taskId: Number(taskId), isAllDay: false, startDateTime, endDateTime,
      endType: 'NONE', repeatEnabled: false, repeatType: 'NONE',
    });
  } finally {
    await browser.close();
  }
}

export async function submitReflection(text, email, password, topic = '오늘의 학습', date = null, onProgress = async () => {}, onWarning = async () => {}, thankConfig = { type: '자신', name: '', message: '오늘도 화이팅!' }, silent = false) {
  const log = silent ? () => {} : console.log.bind(console);
  const targetDate = date ?? new Date().toISOString().split('T')[0];
  const reflectionUrl = `https://dgsm.newrrow.com/csr-platform/reflection/daily/chat-type?date=${targetDate}`;

  await onProgress('브라우저 시작 중...');
  const isHeadless = process.env.HEADLESS !== 'false';
  const browser = await chromium.launch({
    headless: isHeadless,
    args: isHeadless ? [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,900',
    ] : [],
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // ── 자가 점검 API 데이터 자동 수집 ──
  const diagApi = { token: null, reflectionId: null, taskId: null, evalChatId: null, questionIds: [], topicChatId: null };
  page.on('request', req => {
    const auth = req.headers()['authorization'];
    if (auth?.startsWith('Bearer ')) diagApi.token = auth.slice(7);
    const m = req.url().match(/\/daily-reflections\/(\d+)\//);
    if (m) diagApi.reflectionId = m[1];
  });
  page.on('response', async res => {
    try {
      const url = res.url();
      if (/\/daily-performed-task$/.test(url)) {
        const d = await res.json().catch(() => null);
        if (d?.contents?.id) diagApi.taskId = String(d.contents.id);
      }
      if (url.includes('/evaluation/questions') && !url.includes('/answer')) {
        const d = await res.json().catch(() => null);
        if (d?.contents?.questions) diagApi.questionIds = d.contents.questions.map(q => q.questionId);
      }
      if (/\/chats\/\d+\/next$/.test(url)) {
        const d = await res.json().catch(() => null);
        const evalChat = (d?.contents?.chats ?? []).find(c => c.type === 'EVALUATION');
        if (evalChat) diagApi.evalChatId = evalChat.chatId;
      }
      if (url.includes('/chats') && url.includes('operation=open')) {
        const d = await res.json().catch(() => null);
        const taskChat = (d?.contents?.chats ?? []).find(c => c.type === 'SELECT_REFLECTION_TASK');
        if (taskChat) diagApi.topicChatId = taskChat.chatId;
      }
    } catch {}
  });

  try {
    await onProgress('뉴로우 접속 중...');
    await page.goto(reflectionUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const submitLoginDeadline = Date.now() + 15000;
    while (Date.now() < submitLoginDeadline) {
      await page.waitForTimeout(500);
      const curUrl = page.url();
      if (curUrl.includes('/csr-platform/')) break;
      if (curUrl.includes('inhrplus.com') || curUrl.includes('/login')) {
        await onProgress('로그인 중...');
        await login(page, email, password);
        await page.goto(reflectionUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForURL(url => url.includes('/csr-platform/'), { timeout: 15000 }).catch(() => {});
        break;
      }
    }
    await dismissLoginPopup(page);

    log('회고 페이지 URL:', page.url());

    // ── 진단: 현재 페이지 상태 출력 ──
    try {
      const diagInfo = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        bodyText: document.body.innerText.slice(0, 300),
        buttons: [...document.querySelectorAll('button')].map(b => b.textContent.trim().slice(0, 30)),
        rootAriaHidden: document.querySelector('#root')?.getAttribute('aria-hidden') ?? 'none',
      }));
      log('── 페이지 진단 ──');
      log('URL:', diagInfo.url);
      log('Title:', diagInfo.title);
      log('aria-hidden on #root:', diagInfo.rootAriaHidden);
      log('버튼 목록:', JSON.stringify(diagInfo.buttons));
      log('본문(300자):', diagInfo.bodyText);
      log('──────────────');
    } catch (de) {
      log('진단 실패:', de.message);
    }

    // 이미 완료된 경우 감지 함수
    const checkAlreadyDone = async () => {
      const texts = [
        '일일 회고를 모두 작성하셨어요',
        '오늘의 회고를 완료',
        '회고를 완료하셨어요',
      ];
      for (const t of texts) {
        const visible = await page.isVisible(`text=${t}`).catch(() => false);
        if (visible) return true;
      }
      return false;
    };

    if (await checkAlreadyDone()) {
      log('오늘 회고 이미 완료됨 — 종료');
      return 'already_done';
    }

    // 인트로/단계 화면 감지 — waitForFunction으로 순수 JS 폴링 (Playwright 셀렉터 엔진 우회)
    try {
      const handle = await page.waitForFunction(() => {
        // 인트로 버튼 — button, a, div 등 모든 태그 탐색
        const introBtn = [...document.querySelectorAll('button, a, [role="button"]')]
          .find(b => b.textContent.trim().includes('회고하기'));
        if (introBtn) return 'intro';
        // 단계 화면 요소
        if (document.querySelector('button span[title="9점"]')) return 'stage';
        if (document.querySelector('[class*="DiagnosisActionBoxConainer-module"]')) return 'stage';
        if (document.querySelector('[class*="DiagnosisActionBoxContainer-module"]')) return 'stage';
        // 구조적 감지: 점수 버튼이 있으면 자가 점검 단계
        if ([...document.querySelectorAll('button')].filter(b => /^[1-9]점/.test(b.textContent.trim())).length >= 3) return 'stage';
        if (document.querySelector('[class*="LookBackTaskActionBox"]')) return 'stage';
        if (document.querySelector('[class*="ChoiceTaskActionBox"]')) return 'stage';
        if (document.querySelector('textarea[data-uix-name="Textarea"]')) return 'stage';
        // 완료 화면
        if (document.body.textContent.includes('일일 회고를 모두 작성하셨어요')) return 'done';
        return false; // 아직 로딩 중 — 계속 폴링
      }, {}, { timeout: 30000 });
      const introDetect = await handle.jsonValue();
      log(`인트로 감지 결과: ${introDetect}`);

      if (introDetect === 'done') {
        log('오늘 회고 이미 완료됨 (인트로 감지 단계) — 종료');
        return 'already_done';
      }

      if (introDetect === 'intro') {
        if (await checkAlreadyDone()) {
          log('오늘 회고 이미 완료됨 (회고하기 버튼 감지 후 재확인) — 종료');
          return 'already_done';
        }
        // evaluate로 직접 클릭 — CSS visibility/aria-hidden 완전 우회
        const clicked = await page.evaluate(() => {
          const btn = [...document.querySelectorAll('button, a, [role="button"]')]
            .find(b => b.textContent.trim().includes('회고하기'));
          if (btn) { btn.click(); return true; }
          return false;
        });
        log(clicked ? '회고하기 클릭 (evaluate)' : '회고하기 버튼 evaluate 실패');
        // React synthetic event를 확실히 트리거하기 위해 mouse.click 항상 보조 실행
        const startBtn = page.locator(':is(button, a, [role="button"]):has-text("회고하기")').first();
        const box = await startBtn.boundingBox().catch(() => null);
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          log('회고하기 mouse.click (보조)');
        } else if (!clicked) {
          await startBtn.click({ force: true });
          log('회고하기 force click (fallback)');
        }
        log('회고하기 클릭 완료');
        // 클릭 후 다음 단계 DOM 등장 대기
        await page.waitForFunction(() =>
          document.querySelector('button span[title="9점"]') ||
          document.querySelector('[class*="DiagnosisActionBoxConainer-module"]') ||
          document.querySelector('[class*="LookBackTaskActionBox"]') ||
          document.querySelector('[class*="ChoiceTaskActionBox"]') ||
          document.querySelector('textarea[data-uix-name="Textarea"]') ||
          document.body.textContent.includes('일일 회고를 모두 작성하셨어요')
        , { timeout: 15000 }).catch(() => {});
        if (await checkAlreadyDone()) {
          log('회고하기 클릭 후 완료 화면 감지 — 종료');
          return 'already_done';
        }
      }
    } catch (e) {
      log(`인트로 감지 실패: ${e.message}`);
      // 실패 시 현재 상태 재진단
      try {
        const failInfo = await page.evaluate(() => ({
          url: location.href,
          bodyText: document.body.innerText.slice(0, 300),
          buttons: [...document.querySelectorAll('button')].map(b => b.textContent.trim().slice(0, 30)),
        }));
        log('실패 시점 URL:', failInfo.url);
        log('실패 시점 버튼:', JSON.stringify(failInfo.buttons));
        log('실패 시점 본문:', failInfo.bodyText);
      } catch {}
      await page.screenshot({ path: `${DATA_DIR}/debug-intro-fail.png` });
    }

    // 스크롤 헬퍼 — 채팅형 페이지 맨 아래로 스크롤
    async function scrollToBottom() {
      await page.evaluate(() => {
        const scrollables = [...document.querySelectorAll('*')].filter(el => {
          const { overflow, overflowY } = getComputedStyle(el);
          return /auto|scroll/.test(overflow + overflowY) && el.scrollHeight > el.clientHeight;
        });
        scrollables.forEach(el => { el.scrollTop = el.scrollHeight; });
        window.scrollTo(0, document.body.scrollHeight);
      });
      // 스크롤 렌더링 settle — 고정 대기 대신 2 rAF
      await rAF(page);
    }

    // 자가 점검 버튼, 감정 버튼, 선택 박스, textarea 중 하나가 나타날 때까지 대기
    // 인트로 클릭 후 React 렌더링 완료 대기
    try {
      await Promise.race([
        page.waitForSelector('button:has(span[title="9점"])', { timeout: 20000 }),
        page.waitForSelector('[class*="DiagnosisActionBoxConainer-module__container"]', { timeout: 20000 }),
        page.waitForSelector('[class*="LookBackTaskActionBox-module__filter"]', { timeout: 20000 }),
        page.waitForSelector('[class*="ChoiceTaskActionBox-module__elseTask"]', { timeout: 20000 }),
        page.waitForSelector('textarea[data-uix-name="Textarea"]', { state: 'attached', timeout: 20000 }),
        page.waitForSelector('text=일일 회고를 모두 작성하셨어요', { timeout: 20000 }),
      ]);
    } catch { /* 알 수 없는 상태 — 이후 단계에서 처리 */ }
    await scrollToBottom();

    // ── 현재 활성 단계 감지 — 이미 완료된 단계 스킵 ──
    let currentStep = await detectCurrentStep(page);
    log(`현재 활성 단계: ${currentStep}`);
    if (currentStep === 'done') { log('이미 모든 단계 완료 — 종료'); return 'already_done'; }

    // 단계 순서 정의 (앞 단계면 스킵)
    const STEP_ORDER = ['diagnosis', 'lookback', 'topic', 'writing', 'thinking', 'confirm', 'action', 'share', 'thanks', 'end', 'done'];
    const stepIdx = (s) => { const i = STEP_ORDER.indexOf(s); return i === -1 ? 0 : i; };
    const isDone = (s) => stepIdx(currentStep) > stepIdx(s);

    // ── 자가 점검 단계 ──
    await onProgress('자가 점검 진행 중...');

    if (isDone('diagnosis')) {
      log('자가 점검 이미 완료 — 스킵');
    } else {
    // ── API 방식 우선 시도 ──
    const diagApiReady = diagApi.token && diagApi.reflectionId && diagApi.taskId &&
      diagApi.evalChatId !== null && diagApi.questionIds.length > 0;
    let diagDone = false;

    if (diagApiReady) {
      log(`[API] 자가 점검: reflId=${diagApi.reflectionId} taskId=${diagApi.taskId} evalChat=${diagApi.evalChatId} qIds=[${diagApi.questionIds}]`);
      const NEWRROW_API = 'https://api-agw-backend.inhrplus.com';
      const apiHeaders = {
        'Authorization': `Bearer ${diagApi.token}`,
        'Content-Type': 'application/json',
        'Tenant': 'dgsm',
        'Origin': 'https://dgsm.newrrow.com',
        'Accept': 'application/json, text/plain, */*',
      };
      // 각 질문 9점(idx=8) 답변 제출
      for (const qId of diagApi.questionIds) {
        const st = await page.evaluate(async ({url, headers}) => {
          try { return (await fetch(url, { method: 'POST', headers, body: JSON.stringify([8]) })).status; }
          catch { return 0; }
        }, { url: `${NEWRROW_API}/main/api/v1/daily-reflections/${diagApi.reflectionId}/reflecting/common/evaluation/questions/${qId}/answer`, headers: apiHeaders });
        log(`[API] answer ${qId}: ${st}`);
      }
      // 확인 버튼 (next)
      const nextSt = await page.evaluate(async ({url, headers}) => {
        try { return (await fetch(url, { method: 'GET', headers })).status; }
        catch { return 0; }
      }, { url: `${NEWRROW_API}/main/api/v1/daily-reflections/${diagApi.reflectionId}/reflecting/common/daily-performed-tasks/${diagApi.taskId}/chats/${diagApi.evalChatId}/next`, headers: apiHeaders });
      log(`[API] evaluation next: ${nextSt}`);

      if (nextSt >= 200 && nextSt < 300) {
        diagDone = true;
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        await dismissLoginPopup(page);
        await page.waitForFunction(() => {
          const root = document.querySelector('#root');
          return root && root.children.length > 0 && !root.hasAttribute('aria-hidden');
        }, { timeout: 8000 }).catch(() => {});
        currentStep = await detectCurrentStep(page);
        log(`[API] 자가 점검 완료 — 새로고침 후 단계: ${currentStep}`);
        await scrollToBottom();
      } else {
        log(`[API] next 실패(${nextSt}) — Playwright fallback 진행`);
      }
    } else {
      log(`[API] 데이터 부족(token=${!!diagApi.token} reflId=${diagApi.reflectionId} taskId=${diagApi.taskId} evalChat=${diagApi.evalChatId} qCnt=${diagApi.questionIds.length}) — Playwright 방식`);
    }

    if (!diagDone) {
    // DiagnosisActionBox 형식 (TypeSelector 버튼형, 수요일 등) 우선 감지
    const hasDiagBox = await page.evaluate(() => {
      if (document.querySelector('[class*="DiagnosisActionBoxConainer-module__container"]')) return true;
      if (document.querySelector('[class*="DiagnosisActionBoxContainer-module__container"]')) return true;
      // 구조적 감지: 1~9점 패턴의 점수 버튼이 3개 이상 있으면 자가 점검 UI
      const scoreBtns = [...document.querySelectorAll('button')].filter(b => /^[1-9]점/.test(b.textContent.trim()));
      return scoreBtns.length >= 3;
    }).catch(() => false);

    if (hasDiagBox) {
      log('DiagnosisActionBox 자가 점검 감지');
      const processed = await page.evaluate(() => {
        const questions = [...document.querySelectorAll('[class*="DiagnosisActionBox-module__container"]')];
        let total = 0;
        for (const q of questions) {
          const typeSelector = q.querySelector('[class*="TypeSelector-module__container"]');
          if (!typeSelector) continue;
          const buttons = [...typeSelector.querySelectorAll('button[class*="TypeSelector-module__selector"]')];
          if (!buttons.length) continue;
          const isRating = buttons.some(b => /^\d+점$/.test(b.querySelector('span.ellipsis')?.getAttribute('title') || ''));
          const alreadySelected = buttons.filter(b => b.className.includes('selected')).length;
          const needed = isRating ? 1 : 3;
          // 이미 충분히 선택된 경우 스킵
          if (alreadySelected >= needed) continue;
          const unselectedEnabled = buttons.filter(b => !b.disabled && !b.className.includes('selected'));
          if (!unselectedEnabled.length) continue;
          if (isRating) {
            // rating 질문: 마지막 버튼(9점) 클릭
            const last = buttons[buttons.length - 1];
            if (!last.disabled && !last.className.includes('selected')) { last.click(); total++; }
          } else {
            // select-3 질문: 필요한 만큼만 클릭
            let n = alreadySelected;
            for (const btn of unselectedEnabled) {
              if (n >= 3) break;
              btn.click(); n++; total++;
            }
          }
        }
        // 구조적 fallback: 클래스 기반 처리가 안 됐을 때 점수 버튼 직접 처리
        // 실천항목 평가처럼 그룹이 여러 개인 경우 각 그룹의 9점을 모두 클릭
        if (total === 0) {
          const allBtns = [...document.querySelectorAll('button')];
          // 각 그룹의 9점 버튼을 찾아 클릭 (그룹당 정확히 1개의 9점 버튼)
          const ninePtBtns = allBtns.filter(b => /^9점/.test(b.textContent.trim()) && !b.disabled);
          for (const btn of ninePtBtns) { btn.click(); total++; }
          // 9점 패턴이 없으면 1점 버튼 기준으로 그룹을 나눠 각 그룹 마지막 버튼 클릭
          if (total === 0) {
            const scoreBtns = allBtns.filter(b => /^[1-9]점/.test(b.textContent.trim()));
            const alreadySelected = scoreBtns.filter(b =>
              b.className.includes('selected') || b.getAttribute('aria-selected') === 'true' || b.disabled
            ).length;
            if (alreadySelected === 0 && scoreBtns.length > 0) {
              const onePtIndices = scoreBtns.reduce((acc, b, i) => {
                if (/^1점/.test(b.textContent.trim())) acc.push(i);
                return acc;
              }, []);
              const groupSize = onePtIndices.length > 1 ? onePtIndices[1] - onePtIndices[0] : scoreBtns.length;
              for (const si of onePtIndices) {
                const last = scoreBtns[si + groupSize - 1];
                if (last && !last.disabled) { last.click(); total++; }
              }
              if (total === 0) {
                const nineBtn = scoreBtns[scoreBtns.length - 1];
                if (!nineBtn.disabled) { nineBtn.click(); total++; }
              }
            }
          }
        }
        return total;
      });
      log(`DiagnosisActionBox ${processed}개 항목 선택 완료`);
      // React 상태 반영 대기 (최대 1초)
      await page.waitForFunction(() => {
        const questions = [...document.querySelectorAll('[class*="DiagnosisActionBox-module__container"]')];
        return questions.every(q => {
          const btns = [...q.querySelectorAll('button[class*="TypeSelector-module__selector"]')];
          if (!btns.length) return true;
          const isRating = btns.some(b => /^\d+점$/.test(b.querySelector('span.ellipsis')?.getAttribute('title') || ''));
          const selectedCount = btns.filter(b => b.className.includes('selected')).length;
          return isRating ? selectedCount >= 1 : selectedCount >= 3;
        });
      }, { timeout: 1000 }).catch(() => {});
      // 확인 버튼 활성화 대기 (최대 5초)
      await page.waitForFunction(() => {
        const byClass = document.querySelector('button[class*="DiagnosisActionBox"][class*="button"]:not([disabled])');
        const byText = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '확인' && !b.disabled);
        return !!(byClass || byText);
      }, { timeout: 5000 }).catch(() => {});
      await scrollToBottom();
      await rAF(page);

      // 자가 점검 확인 버튼 — 무조건 클릭
      const diagSuccessCheck = () => page.waitForFunction(() => {
        const containerGone =
          !document.querySelector('[class*="DiagnosisActionBoxConainer-module__container"]') &&
          !document.querySelector('[class*="DiagnosisActionBoxContainer-module__container"]') &&
          [...document.querySelectorAll('button:not([disabled])')].filter(b => /^[1-9]점/.test(b.textContent.trim())).length === 0;
        const nextStep =
          !!document.querySelector('[class*="satisfactionFilter"]') ||
          ['뿌듯한', '행복한', '만족한', '신나는'].some(l =>
            [...document.querySelectorAll('button')].some(b => b.textContent.trim() === l)) ||
          !!document.querySelector('[class*="ChoiceTaskActionBox"]') ||
          !!document.querySelector('textarea[data-uix-name="Textarea"]') ||
          document.body.textContent.includes('일일 회고를 모두 작성하셨어요');
        return containerGone || nextStep;
      }, { timeout: 1000 }).then(() => true).catch(() => false);

      const diagConfirmed = await forceClickConfirm(page, diagSuccessCheck);
      log(`DiagnosisActionBox 확인 클릭 완료: ${diagConfirmed}`);
      if (!diagConfirmed) {
        const buf = await page.screenshot({ fullPage: false }).catch(() => null);
        if (buf) await onWarning('⚠️ 자가 점검 확인 버튼 최종 실패 (사이트 버그 가능성)', buf);
      }

      // 다음 단계 등장 최종 대기
      await diagSuccessCheck();
      await scrollToBottom();
    } else {
      // ── 기존 9점 버튼형 자가 점검 ──
      const active9ptCount = await page.locator('button:has(span[title="9점"]):not([disabled])').count().catch(() => 0);
      if (active9ptCount > 0) {
        log(`자가 점검: 활성 9점 버튼 ${active9ptCount}개 발견`);
        const allNineBtns = await page.locator('button:has(span[title="9점"])').all();
        for (let i = 0; i < allNineBtns.length; i++) {
          const disabled = await allNineBtns[i].getAttribute('disabled');
          if (disabled !== null) { log(`자가 점검 ${i + 1}번 이미 선택됨 — 스킵`); continue; }
          await allNineBtns[i].waitFor({ state: 'visible', timeout: 15000 });
          await scrollToBottom();
          await allNineBtns[i].click();
          log(`자가 점검 ${i + 1}번 9점 클릭`);
          await page.waitForFunction((idx) => {
            const btns = [...document.querySelectorAll('button')].filter(b => b.querySelector('span[title="9점"]'));
            return !btns[idx] || btns[idx].disabled;
          }, i, { timeout: 800 }).catch(() => {});
        }
        // 확인 버튼 활성화 대기
        await page.waitForSelector('button:has-text("확인"):not([disabled])', { timeout: 5000 }).catch(() => {});
        await scrollToBottom();
        await rAF(page);
        // 자가 점검 확인 버튼 — 무조건 클릭
        const nineSuccessCheck = () => page.waitForFunction(() => {
          const nineGone = document.querySelectorAll('button:not([disabled]) span[title="9점"]').length === 0;
          const nextStep =
            !!document.querySelector('[class*="satisfactionFilter"]') ||
            ['뿌듯한', '행복한', '만족한', '신나는'].some(l =>
              [...document.querySelectorAll('button')].some(b => b.textContent.trim() === l)) ||
            !!document.querySelector('[class*="ChoiceTaskActionBox"]') ||
            !!document.querySelector('textarea[data-uix-name="Textarea"]');
          return nineGone || nextStep;
        }, { timeout: 1000 }).then(() => true).catch(() => false);
        const nineConfirmed = await forceClickConfirm(page, nineSuccessCheck);
        log(`자가 점검 확인 클릭 완료: ${nineConfirmed}`);
        if (!nineConfirmed) {
          const buf = await page.screenshot({ fullPage: false }).catch(() => null);
          if (buf) await onWarning('⚠️ 자가 점검 확인 버튼 최종 실패 (사이트 버그 가능성)', buf);
        }
        await scrollToBottom();
      } else {
        log('자가 점검 이미 완료 또는 미해당 — 스킵');
      }
    }
    } // !diagDone (Playwright fallback) 블록 닫기
    } // isDone('diagnosis') else 블록 닫기

    // ── 하루 돌아보기 / 자가 점검 2단계 (감정·만족도·슬라이더 UI) ──
    await onProgress('하루 돌아보기 진행 중...');
    if (isDone('lookback')) {
      log('하루 돌아보기 이미 완료 — 스킵');
    } else {
    await scrollToBottom();
    // 9점 확인 후 감정/만족도 UI 또는 다음 단계가 렌더링될 때까지 명시적으로 대기
    await page.waitForFunction(() => {
      if (document.querySelector('[class*="satisfactionFilter"]')) return true;
      const labels = ['뿌듯한', '행복한', '만족한'];
      if (labels.some(l => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === l))) return true;
      if (document.querySelector('[class*="ChoiceTaskActionBox"]')) return true;
      if (document.querySelector('textarea[data-uix-name="Textarea"]')) return true;
      if (document.querySelector('[class*="inputTaskBox"] input')) return true;
      return false;
    }, { timeout: 8000 }).catch(() => {});
    await scrollToBottom();
    const lookBackActive = await page.evaluate(() => {
      if (document.querySelector('[class*="satisfactionFilter"]:not([disabled])')) return true;
      const labels = ['뿌듯한', '행복한', '만족한', '신나는', '슬픈', '힘든', '고요한'];
      return labels.some(l =>
        [...document.querySelectorAll('button:not([disabled])')].some(b => b.textContent.trim() === l)
      );
    }).catch(() => false);
    if (lookBackActive) {
      log('하루 돌아보기: 감정/만족도 UI 감지');
      // 텍스트로 특정 감정 직접 클릭 — class 불일치 방지
      const emotionClicked = await page.evaluate(() => {
        const targets = ['행복한', '만족한', '뿌듯한', '신나는'];
        for (const label of targets) {
          const btn = [...document.querySelectorAll('button')]
            .find(b => b.textContent.trim() === label && !b.disabled);
          if (btn) { btn.click(); return label; }
        }
        // fallback: 첫 번째 활성 filter 버튼
        const fallback = [...document.querySelectorAll('[class*="filter"]:not([disabled])')].find(el => el.tagName === 'BUTTON');
        if (fallback) { fallback.click(); return fallback.textContent.trim(); }
        return false;
      });
      log(emotionClicked ? `감정 선택 완료: ${emotionClicked}` : '감정 버튼 클릭 실패');
      // 만족도 버튼이 렌더링될 때까지 대기
      await page.waitForFunction(() =>
        document.querySelector('[class*="satisfactionFilter"]')
      , { timeout: 3000 }).catch(() => {});

      await scrollToBottom();
      const satBtns = page.locator('[class*="satisfactionFilter"]:not([disabled])');
      const satCount = await satBtns.count().catch(() => 0);
      if (satCount > 0) {
        await satBtns.nth(satCount - 1).click();
        log('만족도 선택 완료');
      } else {
        log('만족도 버튼 없음 — 스킵');
      }
      // 슬라이더가 렌더링될 때까지 대기
      await page.waitForFunction(() =>
        document.querySelector('[data-uix-name="Slider"] [role="slider"]')
      , { timeout: 3000 }).catch(() => {});

      await scrollToBottom();
      const sliderThumbs = page.locator('[data-uix-name="Slider"] [role="slider"]');
      const sliderCount = await sliderThumbs.count();
      for (let i = 0; i < sliderCount; i++) {
        const thumb = sliderThumbs.nth(i);
        const currentVal = await thumb.getAttribute('aria-valuenow');
        if (currentVal && Number(currentVal) >= 100) { log(`슬라이더 ${i+1} 이미 100% — 스킵`); continue; }
        await thumb.click({ force: true });
        await thumb.focus();
        await page.keyboard.press('End');
        const val = await thumb.getAttribute('aria-valuenow');
        if (!val || Number(val) < 50) for (let j = 0; j < 100; j++) await page.keyboard.press('ArrowRight');
        log(`슬라이더 ${i + 1} 100% 설정`);
        // 슬라이더 값 반영 — 2 rAF 로 settle
        await rAF(page);
      }

      await scrollToBottom();
      // button 태그 한정 — div.buttonContainer 와 혼동 방지 (strict mode 위반 차단)
      const lookBackConfirm = page.locator('button[class*="LookBackTaskActionBoxContainer-module__button"]');
      await expect_enabled(lookBackConfirm, 10000);
      await lookBackConfirm.click({ force: true });
      log('하루 돌아보기 완료');
      // 하루 돌아보기 확인 버튼이 비활성화될 때까지 대기
      await page.waitForFunction(() =>
        !document.querySelector('button[class*="LookBackTaskActionBoxContainer-module__button"]:not([disabled])')
      , { timeout: 5000 }).catch(() => {});
    } else {
      log('하루 돌아보기 감정/만족도 UI 없음 — 스킵');
    }
    } // isDone('lookback') else 블록 닫기

    // ── 직접 입력하기 단계 ──
    await onProgress('회고 주제 입력 중...');
    if (isDone('topic')) {
      log('회고 주제 이미 완료 — 스킵');
    } else {
    await scrollToBottom();
    let topicDone = false;

    // ── API 방식 우선 시도 ──
    const topicApiReady = diagApi.token && diagApi.reflectionId && diagApi.topicChatId !== null;
    if (topicApiReady) {
      log(`[API] 주제 입력: reflId=${diagApi.reflectionId} topicChatId=${diagApi.topicChatId}`);
      const NEWRROW_API = 'https://api-agw-backend.inhrplus.com';
      const apiHeaders = {
        'Authorization': `Bearer ${diagApi.token}`,
        'Content-Type': 'application/json',
        'Tenant': 'dgsm',
        'Origin': 'https://dgsm.newrrow.com',
        'Accept': 'application/json, text/plain, */*',
      };
      const newTaskId = await page.evaluate(async ({url, headers, body}) => {
        try {
          const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
          if (!res.ok) return null;
          const d = await res.json();
          return d?.contents ?? null;
        } catch { return null; }
      }, {
        url: `${NEWRROW_API}/main/api/v1/daily-reflections/${diagApi.reflectionId}/reflecting/common/daily-performed-task`,
        headers: apiHeaders,
        body: { dailyReflectionId: Number(diagApi.reflectionId), selectedTaskId: null, taskTitle: topic },
      });
      log(`[API] daily-performed-task POST: newTaskId=${newTaskId}`);

      if (newTaskId) {
        const nextSt = await page.evaluate(async ({url, headers}) => {
          try { return (await fetch(url, { method: 'GET', headers })).status; }
          catch { return 0; }
        }, {
          url: `${NEWRROW_API}/main/api/v1/daily-reflections/${diagApi.reflectionId}/reflecting/common/daily-performed-tasks/${newTaskId}/chats/${diagApi.topicChatId}/next`,
          headers: apiHeaders,
        });
        log(`[API] topic next: ${nextSt}`);

        if (nextSt >= 200 && nextSt < 300) {
          topicDone = true;
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
          await dismissLoginPopup(page);
          await page.waitForFunction(() => {
            const root = document.querySelector('#root');
            return root && root.children.length > 0 && !root.hasAttribute('aria-hidden');
          }, { timeout: 8000 }).catch(() => {});
          currentStep = await detectCurrentStep(page);
          log(`[API] 주제 입력 완료 — 새로고침 후 단계: ${currentStep}`);
          await scrollToBottom();
        } else {
          log(`[API] topic next 실패(${nextSt}) — Playwright fallback 진행`);
        }
      } else {
        log('[API] daily-performed-task POST 실패 — Playwright fallback 진행');
      }
    } else {
      log(`[API] 주제 데이터 부족(token=${!!diagApi.token} reflId=${diagApi.reflectionId} topicChat=${diagApi.topicChatId}) — Playwright 방식`);
    }

    if (!topicDone) {
    // 세 가지 상태 중 하나가 나타날 때까지 대기
    log('직접 입력하기 단계 상태 감지 중...');
    let detectedState = 'none';
    try {
      // choice(직접 입력하기) 감지를 race에서 우선 처리 — chip이 있어도 항상 직접 입력하기 클릭
      detectedState = await Promise.race([
        page.waitForSelector('[class*="ChoiceTaskActionBox-module__elseTask"]', { timeout: 20000 })
          .then(() => 'choice'),
        page.waitForSelector('textarea[data-uix-name="Textarea"]', { state: 'attached', timeout: 20000 })
          .then(() => 'textarea'),
        page.waitForSelector('[class*="inputTaskBox"] input', { timeout: 20000 })
          .then(() => 'topicInput'),
      ]);
    } catch {
      // 완료 화면인지 확인
      if (await checkAlreadyDone()) {
        log('오늘 회고 이미 완료됨 — 종료');
        return 'already_done';
      }
      const unknownBuf = await page.screenshot().catch(() => null);
      if (unknownBuf) await onWarning('알 수 없는 단계 감지', unknownBuf);
      log('알 수 없는 단계 (스크린샷 Discord 전송)');
    }
    log(`감지된 상태: ${detectedState}`);

    if (detectedState === 'choice') {
      await page.click('[class*="ChoiceTaskActionBox-module__elseTask"]', { force: true });
      log('직접 입력하기 클릭');
      await scrollToBottom();
      // topic input이 나타날 때까지 대기
      await page.waitForSelector('[class*="inputTaskBox"] input', { timeout: 10000 });
      detectedState = 'topicInput';
    }

    if (detectedState === 'topicInput') {
      // 이미 비활성화된 입력 (이전 실행에서 topic 이미 제출) → textarea 단계로 전환
      const inputDisabled = await page.locator('[class*="inputTaskBox"] input').getAttribute('disabled').catch(() => null);
      if (inputDisabled !== null) {
        log('회고 항목 이미 입력됨 — textarea 단계로 이동');
        detectedState = 'textarea';
      }
    }

    if (detectedState === 'topicInput') {
      await scrollToBottom();
      await page.fill('[class*="inputTaskBox"] input', topic);
      log('회고 항목 입력 완료');
      // React controlled input 값 반영 확인
      await page.waitForFunction(() => {
        const input = document.querySelector('[class*="inputTaskBox"] input');
        return input && input.value.length > 0;
      }, { timeout: 3000 }).catch(() => {});
      await scrollToBottom();

      // 입력 컨테이너 내 확인 버튼 클릭 시도 (React synthetic event 필요)
      let topicConfirmed = false;
      try {
        topicConfirmed = await page.evaluate(() => {
          const input = document.querySelector('[class*="inputTaskBox"] input');
          if (!input) return false;
          const container = input.closest('[class*="ChoiceTaskActionBox"]') ||
                            input.parentElement?.parentElement;
          if (container) {
            const btns = container.querySelectorAll('button');
            if (btns.length > 0) { btns[btns.length - 1].click(); return true; }
          }
          return false;
        });
        if (topicConfirmed) log('회고 항목 확인 (컨테이너 버튼 클릭)');
      } catch { /* 무시 */ }

      if (!topicConfirmed) {
        await page.locator('[class*="inputTaskBox"] input').press('Enter');
        log('회고 항목 확인 (Enter fallback)');
      }
      // 다음 단계 (유형 선택 또는 textarea) 등장 대기
      await page.waitForFunction(() =>
        document.querySelector('textarea[data-uix-name="Textarea"]') ||
        document.body.textContent.includes('자유형') ||
        document.body.textContent.includes('일일 회고를 모두 작성하셨어요')
      , { timeout: 15000 }).catch(() => {});
      await scrollToBottom();
    } else if (detectedState === 'textarea') {
      log('직접 입력하기 이미 완료 — textarea 단계로 바로 이동');
    }
    } // !topicDone (Playwright fallback) 블록 닫기
    } // isDone('topic') else 블록 닫기

    // ── 유형 선택 단계 (학습형/성찰형/자유형) ──
    await onProgress('회고 유형 선택 중...');
    await scrollToBottom();

    const textareaAlreadyExists = await page.locator('textarea[data-uix-name="Textarea"]').count().catch(() => 0) > 0;
    if (!textareaAlreadyExists) {
      // 자유형 버튼이 나타날 때까지 대기 후 클릭
      try {
        await page.waitForSelector('text=자유형', { timeout: 10000 });
        log('유형 선택 단계 감지 — 자유형 선택 중...');

        // 자유형 요소 좌표 얻어서 실제 마우스 클릭 (헤드리스에서 가장 안정적)
        const freeTypeBtn = page.locator('text=자유형').first();
        await freeTypeBtn.scrollIntoViewIfNeeded();
        const box = await freeTypeBtn.boundingBox();
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          log(`자유형 마우스 클릭: (${box.x + box.width / 2}, ${box.y + box.height / 2})`);
        } else {
          await freeTypeBtn.click({ force: true });
          log('자유형 force 클릭');
        }
        log('자유형 선택 완료');
        await scrollToBottom();

        // 확인 버튼 활성화 대기 후 클릭
        await page.waitForSelector('button:has-text("확인"):not([disabled])', { timeout: 10000 });
        // 버튼이 DOM에 나타난 직후 클릭하면 이벤트 핸들러가 아직 미부착일 수 있어 rAF 대기
        await rAF(page);
        await page.locator('button:has-text("확인"):not([disabled])').last().click({ force: true });
        log('유형 선택 확인 완료');
        // textarea 등장 대기
        await page.waitForFunction(() =>
          document.querySelector('textarea[data-uix-name="Textarea"]')
        , { timeout: 15000 }).catch(() => {});
        await scrollToBottom();
      } catch (e) {
        log(`유형 선택 중 오류: ${e.message}`);
        // 유형 선택 UI가 아직 남아있으면 evaluate로 강제 처리
        const retried = await page.evaluate(() => {
          const freeEl = [...document.querySelectorAll('*')].find(
            el => el.textContent.trim() === '자유형' && el.children.length === 0
          );
          if (freeEl) freeEl.click();
          const confirmBtn = [...document.querySelectorAll('button')]
            .filter(b => b.textContent.includes('확인') && !b.disabled).at(-1);
          if (confirmBtn) { confirmBtn.click(); return true; }
          return !!freeEl;
        });
        if (retried) {
          log('유형 선택 evaluate 재시도');
          await page.waitForFunction(() =>
            document.querySelector('textarea[data-uix-name="Textarea"]')
          , { timeout: 15000 }).catch(() => {});
        } else {
          log('유형 선택 단계 없음 또는 이미 완료 — 스킵');
        }
      }
    } else {
      log('유형 선택 이미 완료 — 스킵');
    }

    // textarea 대기 전 상태 진단 — 유형 선택이 덜 완료됐으면 여기서 한 번 더 처리
    const preCheck = await page.evaluate(() => ({
      hasTextarea: !!document.querySelector('textarea[data-uix-name="Textarea"]'),
      hasFreeType: document.body.textContent.includes('자유형'),
      activeButtons: [...document.querySelectorAll('button:not([disabled])')].map(b => b.textContent.trim().slice(0, 20)),
    }));
    log('textarea 대기 전 진단:', JSON.stringify(preCheck));

    if (preCheck.hasFreeType && !preCheck.hasTextarea) {
      log('유형 선택 화면 잔류 감지 — 최종 강제 처리');
      await page.evaluate(() => {
        const freeEl = [...document.querySelectorAll('*')].find(
          el => el.textContent.trim() === '자유형' && el.children.length === 0
        );
        if (freeEl) freeEl.click();
      });
      await rAF(page);
      await page.evaluate(() => {
        const confirmBtn = [...document.querySelectorAll('button')]
          .filter(b => b.textContent.includes('확인') && !b.disabled).at(-1);
        if (confirmBtn) confirmBtn.click();
      });
      await page.waitForFunction(() =>
        document.querySelector('textarea[data-uix-name="Textarea"]')
      , { timeout: 15000 }).catch(() => {});
    }

    // textarea 대기 — 최대 3회 재시도 (확인 버튼 클릭 후 대기)
    await onProgress('회고 내용 입력 중...');
    log('회고 작성 textarea 대기 중...');
    for (let attempt = 0; attempt < 3; attempt++) {
      const found = await page.waitForSelector('textarea[data-uix-name="Textarea"]', { state: 'attached', timeout: 20000 }).catch(() => null);
      if (found) break;
      log(`textarea 미출현 (시도 ${attempt + 1}) — 잔류 확인/자유형 버튼 재클릭`);
      await page.evaluate(() => {
        const freeEl = [...document.querySelectorAll('*')].find(el => el.textContent.trim() === '자유형' && el.children.length === 0);
        if (freeEl) freeEl.click();
        const confirmBtn = [...document.querySelectorAll('button')].filter(b => b.textContent.includes('확인') && !b.disabled).at(-1);
        if (confirmBtn) confirmBtn.click();
      });
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2000);
      if (attempt === 2) await page.waitForSelector('textarea[data-uix-name="Textarea"]', { state: 'attached', timeout: 20000 });
    }
    await page.evaluate(() => {
      document.querySelector('textarea[data-uix-name="Textarea"]')
        ?.scrollIntoView({ behavior: 'instant', block: 'center' });
    });
    // scrollIntoView 렌더링 settle
    await rAF(page);

    // 텍스트 입력 — nativeInputValueSetter로 React 상태까지 확실히 반영
    const supplement = ' 앞으로도 꾸준히 노력하며 성장해나갈 것이다.';
    let finalText = text;
    while (finalText.length < 205) finalText += supplement;

    await page.evaluate((val) => {
      const ta = document.querySelector('textarea[data-uix-name="Textarea"]');
      if (!ta) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(ta, val);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    }, finalText);
    log('텍스트 입력 완료');

    // 사이트 글자 수 카운터 확인
    const textLen = await page.evaluate(() =>
      document.querySelector('textarea[data-uix-name="Textarea"]')?.value?.length ?? 0
    ).catch(() => 0);
    log(`textarea 입력 길이: ${textLen}자`);

    // 200자 이상 — 확인 버튼 활성화 대기 후 클릭
    await scrollToBottom();
    await page.waitForSelector('button:has-text("확인"):not([disabled])', { timeout: 15000 });
    await page.locator('button:has-text("확인"):not([disabled])').last().click({ force: true });
    log('확인 버튼 클릭');
    // 더 생각해 보기 또는 다음 단계가 등장할 때까지 대기
    await page.waitForFunction(() =>
      [...document.querySelectorAll('button')].some(b => b.textContent.includes('넘어갈게요')) ||
      [...document.querySelectorAll('button')].some(b => b.textContent.includes('작성한 회고 확인하기')) ||
      document.body.textContent.includes('일일 회고를 모두 작성하셨어요')
    , { timeout: 25000 }).catch(() => {});
    await scrollToBottom();

    // ── 더 생각해 보기 단계 — "넘어갈게요" 클릭 ──
    await onProgress('더 생각해 보기 처리 중...');
    // AI가 질문을 생성하는 시간이 있어 넉넉하게 대기
    try {
      const skipBtn = page.locator('button:has-text("넘어갈게요")');
      await skipBtn.waitFor({ state: 'visible', timeout: 25000 });
      await skipBtn.click({ force: true });
      log('넘어갈게요 클릭');
      await scrollToBottom();
    } catch { log('더 생각해 보기 단계 없음 — 스킵'); }

    // ── 작성한 회고 확인하기 클릭 ──
    await onProgress('회고 저장 중...');
    try {
      const finishBtn = page.locator('button:has-text("작성한 회고 확인하기")');
      await finishBtn.waitFor({ state: 'visible', timeout: 15000 });
      await finishBtn.click({ force: true });
      log('작성한 회고 확인하기 클릭');
      await scrollToBottom();
    } catch { log('회고 확인하기 단계 없음 — 스킵'); }

    // ── 저장하기 클릭 ──
    try {
      const saveBtn = page.locator('[class*="reflectingPreviewArea"] button, button[class*="reflectingPreviewArea"]').last();
      await saveBtn.waitFor({ state: 'visible', timeout: 8000 });
      await saveBtn.click({ force: true });
      log('저장하기 클릭');
      await scrollToBottom();
    } catch { log('저장하기 단계 없음 — 스킵'); }

    // ── 다음에 할게요 클릭 (실천항목 등록 스킵) ──
    // AI가 실천 항목 3개를 생성하는 동안 버튼이 나타나지 않아 timeout이 날 수 있어 25초로 설정
    try {
      const laterBtn = page.locator('button:has-text("다음에 할게요")');
      await laterBtn.waitFor({ state: 'visible', timeout: 25000 });
      await laterBtn.click({ force: true });
      log('다음에 할게요 클릭 (실천항목 스킵)');
      await scrollToBottom();
    } catch { log('실천항목 단계 없음 — 스킵'); }

    // ── 회고 공유하기 단계 (뉴로우 선택 후 공유) ──
    await onProgress('회고 공유 중...');
    try {
      await scrollToBottom();
      // 공유 단계 감지 — 클래스명 변경에 대비해 여러 선택자 병렬 시도
      const shareDropdownVisible = await page.waitForFunction(() =>
        document.querySelector('[class*="select-common"]') ||
        document.querySelector('[class*="shareStep"]') ||
        (document.body.textContent.includes('공유 대상') && document.querySelector('button:not([disabled])'))
      , { timeout: 10000 }).then(() => true).catch(() => false);
      log(`공유하기 단계 감지: ${shareDropdownVisible}`);
      if (shareDropdownVisible) {
        // 드롭다운 트리거 — 여러 선택자 시도
        const dropdownTrigger = page.locator('[class*="select-common-input"], [class*="select-common"] input, [class*="shareStep"] button').first();
        await dropdownTrigger.waitFor({ state: 'visible', timeout: 5000 });
        await dropdownTrigger.click();
        log('공유 드롭다운 열기');
        // 드롭다운 열리고 검색 input에 포커스될 때까지 대기
        await page.waitForFunction(() =>
          document.activeElement?.tagName === 'INPUT' ||
          document.querySelector('ul li')
        , { timeout: 3000 }).catch(() => {});

        // 드롭다운이 열리면 검색창에 자동 포커스 — keyboard.type 으로 직접 입력
        await page.keyboard.type('뉴로우');
        // 필터링된 결과가 나타날 때까지 대기
        await page.waitForFunction(() =>
          [...document.querySelectorAll('li')].some(li => li.textContent.trim().includes('뉴로우'))
        , { timeout: 5000 }).catch(() => {});

        // 필터링된 "뉴로우" 항목의 체크박스 클릭
        const newrowOption = page.locator('li:has-text("뉴로우")').first();
        await newrowOption.waitFor({ state: 'visible', timeout: 5000 });

        // 체크박스 input 또는 체크박스 역할 요소 직접 클릭
        const cb = newrowOption.locator('input[type="checkbox"]').first();
        if (await cb.count() > 0) {
          await cb.click({ force: true });
          log('공유 대상 뉴로우 선택 (checkbox input)');
        } else {
          // custom 체크박스: li 내 첫 번째 자식 클릭
          await page.evaluate(() => {
            const li = [...document.querySelectorAll('li')].find(el => el.textContent.trim() === '뉴로우');
            if (li) {
              li.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              const firstChild = li.firstElementChild;
              if (firstChild) firstChild.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            }
          });
          log('공유 대상 뉴로우 선택 (evaluate)');
        }
        // 공유하기 버튼 활성화 대기
        await page.waitForSelector('button:has-text("공유하기"):not([disabled])', { timeout: 5000 }).catch(() => {});
        await scrollToBottom();

        // "공유하기" 버튼 활성화 대기 후 클릭
        await page.locator('button:has-text("공유하기"):not([disabled])').click({ force: true });
        log('회고 공유하기 완료');
        // 다음 단계 (감사카드 또는 끝내기) 등장 대기
        await page.waitForFunction(() =>
          document.body.textContent.includes('감사 카드') ||
          [...document.querySelectorAll('button')].some(b => b.textContent.includes('오늘의 회고 끝내기'))
        , { timeout: 10000 }).catch(() => {});
        await scrollToBottom();
      } else {
        log('회고 공유하기 단계 없음 — 스킵');
        const skipBuf = await page.screenshot({ fullPage: false }).catch(() => null);
        if (skipBuf) await onWarning('공유하기 단계 없음 (스킵)', skipBuf);
      }
    } catch (e) {
      log('회고 공유하기 실패/스킵:', e.message);
      const skipBuf = await page.screenshot({ fullPage: false }).catch(() => null);
      if (skipBuf) await onWarning(`공유하기 실패: ${e.message}`, skipBuf);
    }

    // ── 감사 카드 보내기 단계 ──
    await onProgress('감사 카드 작성 중...');
    try {
      await scrollToBottom();
      // 유형 버튼(선생님/친구/자신) 중 하나가 나타날 때까지 대기
      const thankCardActive = await page.waitForFunction(() =>
        ['선생님', '친구', '자신'].some(label =>
          [...document.querySelectorAll('button')].some(b => b.textContent.trim() === label)
        )
      , { timeout: 8000 }).then(() => true).catch(() => false);
      log(`감사 카드 단계 감지: ${thankCardActive}`);

      if (thankCardActive) {
        // 유형 버튼 클릭 (선생님 / 친구 / 자신)
        const typeBtn = page.locator(`button:has-text("${thankConfig.type}")`).first();
        await typeBtn.click({ force: true });
        log(`감사 카테고리 선택: ${thankConfig.type}`);

        // 선생님/친구인 경우 이름 검색 및 선택
        if (thankConfig.type !== '자신' && thankConfig.name) {
          try {
            // 유형 버튼 클릭 후 React 렌더링 settle
            await rAF(page);
            await scrollToBottom();
            // 검색 input이 나타날 때까지 대기 (최대 8초)
            await page.waitForFunction(() => {
              const inputs = [...document.querySelectorAll('input')];
              return inputs.some(inp => inp.offsetParent !== null && !inp.disabled);
            }, { timeout: 8000 }).catch(() => {});

            // React controlled input에 값 주입 (nativeInputValueSetter 방식)
            const filled = await page.evaluate((name) => {
              const inputs = [...document.querySelectorAll('input')]
                .filter(inp => inp.offsetParent !== null && !inp.disabled);
              const target = inputs[inputs.length - 1];
              if (!target) return false;
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
              setter?.call(target, name);
              target.dispatchEvent(new Event('input', { bubbles: true }));
              target.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }, thankConfig.name);
            log(filled ? `이름 검색: ${thankConfig.name}` : '이름 input 없음 — 스킵');

            if (filled) {
              // 검색 결과 li 대기 (API 검색이므로 최대 10초)
              await page.waitForFunction((name) =>
                [...document.querySelectorAll('li')].some(el =>
                  el.textContent.trim().includes(name) && el.offsetParent !== null
                )
              , thankConfig.name, { timeout: 10000 }).catch(() => {});

              // Playwright locator로 li 클릭 (React synthetic event 안정적 트리거)
              const liLocator = page.locator('li').filter({ hasText: thankConfig.name }).first();
              const liVisible = await liLocator.isVisible().catch(() => false);
              if (liVisible) {
                await liLocator.click({ force: true });
                log(`이름 선택 (locator): ${thankConfig.name}`);
              } else {
                // fallback: 첫 번째 visible li
                const fallbackClicked = await page.evaluate(() => {
                  const li = [...document.querySelectorAll('li')].find(el => el.offsetParent !== null);
                  if (li) { li.click(); return li.textContent.trim(); }
                  return false;
                });
                log(`이름 선택 (fallback li): ${fallbackClicked}`);
              }
              // li 선택 후 UI 업데이트 settle
              await rAF(page);
              await new Promise(r => setTimeout(r, 300));
            }
          } catch {
            log('이름 선택 UI 없음 또는 실패 — 계속 진행');
          }
        }

        // 감사 메시지 입력 — 이름 선택 후 textarea가 렌더링될 때까지 대기 (최대 8초)
        await page.waitForFunction(() =>
          [...document.querySelectorAll('textarea')].some(ta => ta.offsetParent !== null && !ta.disabled)
        , { timeout: 8000 }).catch(() => {});
        await scrollToBottom();
        // visible하고 disabled 아닌 textarea 중 마지막에 직접 입력
        await page.evaluate((msg) => {
          const tas = [...document.querySelectorAll('textarea')]
            .filter(ta => ta.offsetParent !== null && !ta.disabled);
          const target = tas[tas.length - 1];
          if (!target) return;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
          setter?.call(target, msg);
          target.dispatchEvent(new Event('input', { bubbles: true }));
          target.dispatchEvent(new Event('change', { bubbles: true }));
        }, thankConfig.message);
        log('감사 메시지 입력 완료');

        await scrollToBottom();
        const sendBtn = page.locator('button:has-text("감사카드 보내기")');
        await sendBtn.waitFor({ state: 'visible', timeout: 5000 });
        await sendBtn.click({ force: true });
        log('감사카드 보내기 완료');

        // 감사카드 전송 후 받은 피드백 확인 팝업 (신규 UI) — "확인" 버튼 눌러야 끝내기 버튼 등장
        await page.waitForFunction(() =>
          [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '확인') ||
          [...document.querySelectorAll('button')].some(b => b.textContent.includes('오늘의 회고 끝내기'))
        , { timeout: 8000 }).catch(() => {});
        const feedbackConfirmBtn = await page.$('button:has-text("확인"):not([disabled])');
        if (feedbackConfirmBtn) {
          await feedbackConfirmBtn.click({ force: true });
          log('피드백 확인 클릭');
          await rAF(page);
          await new Promise(r => setTimeout(r, 500));
        }

        await page.waitForFunction(() =>
          [...document.querySelectorAll('button')].some(b => b.textContent.includes('오늘의 회고 끝내기'))
        , { timeout: 8000 }).catch(() => {});
        await scrollToBottom();
      } else {
        log('감사 카드 단계 없음 — 스킵');
        const skipBuf = await page.screenshot({ fullPage: false }).catch(() => null);
        if (skipBuf) await onWarning('감사카드 단계 없음 (스킵)', skipBuf);
      }
    } catch (e) {
      log('감사 카드 보내기 실패/스킵:', e.message);
      const skipBuf = await page.screenshot({ fullPage: false }).catch(() => null);
      if (skipBuf) await onWarning(`감사카드 실패: ${e.message}`, skipBuf);
    }

    // ── 저장하기 (감사카드 후 등장하는 케이스) ──
    try {
      const saveBtn2 = page.locator('button:has-text("저장하기")');
      const visible = await saveBtn2.isVisible().catch(() => false);
      if (visible) {
        await saveBtn2.click({ force: true });
        log('저장하기 클릭 (감사카드 후)');
        await page.waitForTimeout(1000);
      }
    } catch { log('저장하기 (감사카드 후) 없음 — 스킵'); }

    // ── 오늘의 회고 끝내기 ──
    let completionScreenshot = null;
    const endBtn = page.locator('button:has-text("오늘의 회고 끝내기")');
    await endBtn.waitFor({ state: 'visible', timeout: 20000 }).catch(e => { throw stepError('오늘의 회고 끝내기', e); });
    await endBtn.click({ force: true });
    log('오늘의 회고 끝내기 클릭');
    // 완료 화면 등장 대기 (동시 실행 시 리소스 부족으로 느릴 수 있어 여유 있게 대기)
    await page.waitForFunction(() =>
      document.body.textContent.includes('오늘의 회고를 완료') ||
      document.body.textContent.includes('수고하셨어요') ||
      document.body.textContent.includes('회고를 완료하셨어요') ||
      document.body.textContent.includes('일일 회고를 모두 작성하셨어요')
    , { timeout: 15000 }).catch(() => {});
    await rAF(page);
    await new Promise(r => setTimeout(r, 1500)); // 완료 애니메이션 settle (여유 있게)
    // 스크린샷 최대 5회 재시도
    for (let i = 0; i < 5; i++) {
      completionScreenshot = await page.screenshot({ fullPage: false }).catch(() => null);
      if (completionScreenshot) break;
      await new Promise(r => setTimeout(r, 800));
    }
    log(`완료 스크린샷: ${completionScreenshot ? `${completionScreenshot.length} bytes` : '캡처 실패'}`);

    log('회고 제출 완료!');
    return { status: '완료', screenshot: completionScreenshot };
  } catch (err) {
    // 오류 시 현재 화면 스크린샷 캡처 후 에러에 첨부
    try {
      const screenshotBuffer = await page.screenshot({ fullPage: true });
      err.screenshotBuffer = screenshotBuffer;
    } catch (ssErr) {
      console.error('스크린샷 캡처 실패:', ssErr.message);
      err.screenshotError = ssErr.message;
    }
    throw err;
  } finally {
    await browser.close();
  }
}
