import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { SESSION_DIR, ensureDir, dataPath } from "../config/paths";
import { createLogger } from "../core/logger";

const log = createLogger("session");

// 네이버 인증 쿠키(NID_AUT/NID_SES)는 세션 쿠키라 브라우저 프로필에 안 붙는다.
// 별도 JSON에 저장했다가 실행마다 다시 주입해 로그인을 유지한다.
// 계정마다 독립 세션이 필요하므로 accountId를 주면 계정별 폴더/쿠키를 쓴다.
const COOKIE_FILE = dataPath("cookies.json");
type StoredCookie = Awaited<ReturnType<BrowserContext["cookies"]>>[number];

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
  for (const n of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try {
      fs.rmSync(path.join(dir, n), { force: true, recursive: true });
    } catch {
      /* 없으면 무시 */
    }
  }
}

export const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// 자동화 흔적을 줄이는 초기 스크립트 (문자열로 전달해 Node 타입 충돌 회피)
const STEALTH_JS = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR','ko','en-US','en'] });
Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
window.chrome = window.chrome || { runtime: {} };
`;

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

  // 기본은 번들 Chromium(사장님이 쓰는 크롬과 충돌 없음, 창이 안정적으로 유지됨).
  // SENBI_USE_CHROME=1 이면 실제 크롬 채널 사용 — 단, 이땐 크롬을 완전히 종료해야 함.
  const useRealChrome = process.env.SENBI_USE_CHROME === "1";
  let context: BrowserContext;
  if (useRealChrome) {
    try {
      context = await chromium.launchPersistentContext(sessionDir, {
        ...base,
        channel: "chrome",
      });
      log.info("실제 Chrome 채널로 실행 (크롬이 완전히 꺼져 있어야 함)");
    } catch {
      context = await chromium.launchPersistentContext(sessionDir, {
        ...base,
        userAgent: DESKTOP_UA,
      });
      log.info("번들 Chromium으로 실행 (Chrome 실행 실패 폴백)");
    }
  } else {
    context = await chromium.launchPersistentContext(sessionDir, {
      ...base,
      userAgent: DESKTOP_UA,
    });
    log.info("번들 Chromium으로 실행");
  }

  await context.addInitScript(STEALTH_JS);

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
  try {
    await context.close();
  } catch (err) {
    log.warn("컨텍스트 종료 중 오류", err);
  }
}
