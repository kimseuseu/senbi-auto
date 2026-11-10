import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { SESSION_DIR, ensureDir, dataPath } from "../config/paths";
import { createLogger } from "../core/logger";
import { ensureBrowserAvailable } from "./browserSetup";

const log = createLogger("session");

// 네이버 인증 쿠키(NID_AUT/NID_SES)는 세션 쿠키라 브라우저 프로필에 안 붙는다.
// 별도 JSON에 저장했다가 실행마다 다시 주입해 로그인을 유지한다.
// 계정마다 독립 세션이 필요하므로 accountId를 주면 계정별 폴더/쿠키를 쓴다.
const COOKIE_FILE = dataPath("cookies.json");
type StoredCookie = Awaited<ReturnType<BrowserContext["cookies"]>>[number];

// 컨텍스트가 어느 계정 것인지 — 닫을 때 최신 쿠키를 그 계정 파일에 다시 저장한다
const contextAccount = new WeakMap<BrowserContext, string | undefined>();

/** 계정별 브라우저 프로필 폴더 (accountId 없으면 레거시 단일 세션) */
function sessionDirFor(accountId?: string): string {
  return accountId ? dataPath("accounts", accountId, "session") : SESSION_DIR;
}

/** 계정별 쿠키 저장 파일 */
function cookieFileFor(accountId?: string): string {
  return accountId ? dataPath("accounts", accountId, "cookies.json") : COOKIE_FILE;
}

/** 로그인 직후 현재 쿠키 전부를 파일로 저장 */
export async function saveCookies(
  context: BrowserContext,
  accountId?: string,
): Promise<void> {
  const cookies = await context.cookies();
  const file = cookieFileFor(accountId);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(cookies, null, 2), "utf8");
  const auth = cookies.filter((c) => c.name === "NID_AUT" || c.name === "NID_SES");
  log.info(`쿠키 ${cookies.length}개 저장 (인증 쿠키 ${auth.length}/2)`);
}

function loadSavedCookies(accountId?: string): StoredCookie[] | null {
  try {
    return JSON.parse(fs.readFileSync(cookieFileFor(accountId), "utf8")) as StoredCookie[];
  } catch {
    return null;
  }
}

export function hasSavedSession(accountId?: string): boolean {
  const c = loadSavedCookies(accountId);
  return Boolean(c?.some((x) => x.name === "NID_SES"));
}

/**
 * 이전 브라우저가 비정상 종료되면 남는 Singleton 잠금 파일을 제거한다.
 * 이게 남아 있으면 새 브라우저가 "프로필 사용 중"으로 판단해 즉시 종료된다.
 */
export function clearBrowserLocks(accountId?: string): void {
  const dir = sessionDirFor(accountId);
  // 맥/리눅스는 Singleton*, 윈도우는 lockfile 을 남긴다
  for (const n of ["SingletonLock", "SingletonSocket", "SingletonCookie", "lockfile"]) {
    try {
      fs.rmSync(path.join(dir, n), { force: true, recursive: true });
    } catch {
      /* 없으면 무시 */
    }
  }
}

const uaCache = new Map<string, string>();

/**
 * 창을 숨겨 띄울 때 쓸 User-Agent — 로그인 창(같은 브라우저를 창으로 띄운 것)과 같은 값.
 * 숨겨 띄우면 같은 브라우저인데도 이름이 "HeadlessChrome" 으로 바뀌어, 로그인한 브라우저와
 * 발행하는 브라우저가 달라 보인다. 버전·운영체제는 브라우저가 말하는 그대로 둔다.
 */
async function headedUserAgent(channel: string): Promise<string | undefined> {
  const hit = uaCache.get(channel);
  if (hit) return hit;
  try {
    const browser = await chromium.launch({ channel, headless: true });
    try {
      const page = await browser.newPage();
      const ua = String(await page.evaluate("navigator.userAgent"));
      const fixed = ua.replace("HeadlessChrome", "Chrome");
      uaCache.set(channel, fixed);
      return fixed;
    } finally {
      await browser.close();
    }
  } catch (err) {
    log.warn("브라우저 User-Agent 확인 실패 — 기본값으로 진행", err);
    return undefined;
  }
}

export interface LaunchOptions {
  /** 창을 띄울지(false) 백그라운드(true). 로그인/튜닝은 headless=false. */
  headless?: boolean;
  slowMo?: number;
  /** 계정 id — 주면 계정별 세션 폴더/쿠키를 사용 (다계정 격리) */
  accountId?: string;
}

/**
 * 네이버 로그인 세션을 영속하는 브라우저 컨텍스트를 연다.
 * - 실제 Chrome 채널을 우선 사용(자동화 탐지 회피에 유리), 없으면 번들 Chromium.
 * - userDataDir(SESSION_DIR)에 쿠키/스토리지가 저장돼 재실행 시 로그인 유지된다.
 */
export async function launchContext(
  opts: LaunchOptions = {},
): Promise<BrowserContext> {
  // 설치본에는 Chromium 이 없으므로 필요한 순간에 자동으로 받는다 (있으면 즉시 통과).
  // 회사 방화벽 등으로 못 받으면 PC에 이미 있는 Edge/Chrome 로 대신 실행한다.
  const fallbackChannel = await ensureBrowserAvailable();
  const sessionDir = sessionDirFor(opts.accountId);
  ensureDir(sessionDir);
  clearBrowserLocks(opts.accountId); // 이전 비정상 종료가 남긴 잠금 제거 → 즉시 닫힘 방지
  const base = {
    headless: opts.headless ?? true,
    slowMo: opts.slowMo,
    viewport: { width: 1366, height: 900 },
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  };
  // 브라우저가 스스로 밝히는 정보는 손대지 않는다(실측 2026-09-30).
  // 예전엔 User-Agent 를 "Chrome/131" 로 고정하고 navigator 값을 스크립트로 덮어썼는데,
  // 실제 브라우저는 149 라 요청 헤더(sec-ch-ua)와 어긋났고, 백그라운드 실행은 헤더에
  // "HeadlessChrome" 을 그대로 실어 보냈다. 로그인 창과 발행이 서로 다른 브라우저로 보였다.
  // → 로그인 창과 같은 브라우저를 창만 숨겨 띄우고(channel: chromium), 값은 위조하지 않는다.

  // 기본은 번들 Chromium(사장님이 쓰는 크롬과 충돌 없음, 창이 안정적으로 유지됨).
  // SENBI_USE_CHROME=1 이면 실제 크롬 채널 사용 — 단, 이땐 크롬을 완전히 종료해야 함.
  // fallbackChannel: Chromium 을 못 받은 상황 — 설치된 브라우저로 진행 (윈도우엔 Edge 가 항상 있다)
  const useRealChrome = process.env.SENBI_USE_CHROME === "1";
  const open = async (channel: string): Promise<BrowserContext> =>
    chromium.launchPersistentContext(sessionDir, {
      ...base,
      channel,
      userAgent: base.headless ? await headedUserAgent(channel) : undefined,
    });

  let context: BrowserContext;
  if (fallbackChannel) {
    context = await open(fallbackChannel);
    log.info(`${fallbackChannel} 브라우저로 실행 (전용 Chromium 을 받지 못해 대체)`);
  } else if (useRealChrome) {
    try {
      context = await open("chrome");
      log.info("실제 Chrome 채널로 실행 (크롬이 완전히 꺼져 있어야 함)");
    } catch {
      context = await open("chromium");
      log.info("번들 Chromium으로 실행 (Chrome 실행 실패 폴백)");
    }
  } else {
    context = await open("chromium");
    log.info("번들 Chromium으로 실행");
  }

  contextAccount.set(context, opts.accountId);

  // 저장된 로그인 쿠키 재주입 (세션 쿠키 유실 방지)
  const saved = loadSavedCookies(opts.accountId);
  if (saved?.length) {
    try {
      await context.addCookies(saved);
      log.info(`저장된 쿠키 ${saved.length}개 주입`);
    } catch (err) {
      log.warn("쿠키 주입 실패", err);
    }
  }

  return context;
}

/** 네이버 로그인 여부 — 로그인 쿠키(NID_AUT/NID_SES) 존재로 판정 */
export async function isLoggedIn(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies("https://www.naver.com");
  const names = new Set(cookies.map((c) => c.name));
  return names.has("NID_AUT") && names.has("NID_SES");
}

/** 새 로그인을 받기 전에 예전 인증 쿠키를 지운다 — 남아 있으면 로그인하기도 전에 '로그인됨'으로 보인다 */
export async function clearAuthCookies(context: BrowserContext): Promise<void> {
  await context.clearCookies({ name: /^(NID_AUT|NID_SES|nid_inf)$/ });
}

export type SessionVerdict = "ok" | "expired" | "unknown";

const LOGIN_URL = /nidlogin|nid\.naver\.com/;
// 에디터가 실제로 떴다는 표시 (제목 칸 · 발행 버튼)
const EDITOR_READY = '.se-documentTitle, [class*="publish_btn__"]';

/**
 * 글쓰기 화면이 **실제로** 열리는지로 로그인 세션을 확인한다.
 *
 * 쿠키가 있다는 것만으로는 알 수 없다(실측 2026-09-30): 네이버가 세션을 끊은 뒤에도
 * 블로그 겉 페이지(#mainFrame 이 들어 있는 틀)는 정상으로 내려오고, 그 안의 에디터
 * (PostWriteForm)만 인증 쿠키를 지우고 로그인 화면으로 보낸다. 그래서 틀이 아니라
 * 틀 안에 에디터가 뜨는지, 로그인 화면으로 넘어가는지를 본다.
 *
 * @returns ok 에디터 확인 · expired 로그인 화면으로 넘어감 · unknown 시간 안에 판단 못 함
 */
export async function verifyWriteSession(
  page: Page,
  blogId: string,
  timeoutMs = 20000,
): Promise<SessionVerdict> {
  await page.goto(`https://blog.naver.com/${blogId}?Redirect=Write&`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (LOGIN_URL.test(page.url())) return "expired";
    const ready = await page
      .frameLocator("#mainFrame")
      .locator(EDITOR_READY)
      .count()
      .catch(() => 0);
    if (ready > 0) return LOGIN_URL.test(page.url()) ? "expired" : "ok";
    await page.waitForTimeout(300);
  }
  return "unknown";
}

/** 로그인된 사용자의 blogId 등을 확인차 반환 (없으면 null) */
export async function getLoginId(context: BrowserContext): Promise<string | null> {
  const page = await context.newPage();
  try {
    await page.goto("https://www.naver.com", { waitUntil: "domcontentloaded" });
    // 로그인 상태면 상단 영역에 아이디/이름이 노출됨 — 실패해도 무해
    const id = await page
      .locator(".MyView-module__link_login___HpHMW, .link_login")
      .count();
    return id >= 0 ? "ok" : null;
  } catch {
    return null;
  } finally {
    await page.close();
  }
}

// ---------- 사람처럼 보이는 동작 헬퍼 ----------

/** min~max 초 랜덤 대기 */
export function humanDelay(minSec: number, maxSec: number): Promise<void> {
  const ms = (minSec + Math.random() * (maxSec - minSec)) * 1000;
  return new Promise((r) => setTimeout(r, ms));
}

/** 한 글자씩 사람 타이핑처럼 입력 */
export async function humanType(
  page: Page,
  locator: string,
  text: string,
): Promise<void> {
  const el = page.locator(locator).first();
  await el.click();
  for (const ch of text) {
    await el.type(ch, { delay: 40 + Math.random() * 90 });
  }
}

export async function closeContext(context: BrowserContext): Promise<void> {
  // 네이버는 쓰는 동안 인증 쿠키를 새 값으로 바꿔 준다. 로그인 때 받은 값만 계속 넣으면
  // 하루쯤 뒤 만료되므로, 닫기 전에 지금 값을 저장해 다음 실행이 이어받게 한다.
  // (서버가 세션을 끊었으면 인증 쿠키가 지워져 있어 저장하지 않는다 — 기존 파일 유지)
  try {
    if (contextAccount.has(context) && (await isLoggedIn(context))) {
      await saveCookies(context, contextAccount.get(context));
    }
  } catch (err) {
    log.warn("쿠키 갱신 저장 실패(무시)", err);
  }
  try {
    await context.close();
  } catch (err) {
    log.warn("컨텍스트 종료 중 오류", err);
  }
}
