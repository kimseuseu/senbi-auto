import {
  launchContext,
  isLoggedIn,
  closeContext,
  saveCookies,
  clearAuthCookies,
  hasSavedSession,
  verifyWriteSession,
} from "./session";
import type { Page } from "playwright";
import { markSessionValid } from "./sessionState";
import { createLogger } from "../core/logger";
import { JsonStore } from "../config/store";

const log = createLogger("login");

export type LoginStatus = "idle" | "waiting" | "success" | "timeout" | "error";
export interface LoginState {
  status: LoginStatus;
  message?: string;
  startedAt?: number;
}

// 계정별 로그인 진행 상태 (인메모리 — 세션 유지 여부는 쿠키 파일로 별도 판정)
const states = new Map<string, LoginState>();
const active = new Set<string>();

export function loginStatus(accountId: string): LoginState {
  return states.get(accountId) ?? { status: "idle" };
}

export function isLoginInProgress(accountId: string): boolean {
  return active.has(accountId);
}

// 어느 계정이 언제 로그인했는지 — 여러 아이디를 연달아 로그인하는 걸 막는 데 쓴다
const history = new JsonStore<{ logins: Record<string, string> }>("login-history", { logins: {} });

function recordLogin(accountId: string): void {
  const db = history.read();
  db.logins[accountId] = new Date().toISOString();
  history.write(db);
}

/**
 * 최근 withinMs 안에 로그인한 **다른** 계정 (없으면 null).
 *
 * 2026-09-30 실측: 한 아이디의 보호조치를 풀고 나서 같은 PC에서 2분 사이에 네 아이디를
 * 연달아 로그인했더니 그 아이디들이 전부 보호조치에 걸렸다. 같은 PC에서 여러 아이디가
 * 잇달아 들어오는 것 자체가 위험 신호로 보이므로, 연달아 로그인하기 전에 한 번 묻는다.
 */
export function recentOtherLogin(
  accountId: string,
  withinMs: number,
): { accountId: string; at: string } | null {
  const now = Date.now();
  let latest: { accountId: string; at: string } | null = null;
  for (const [id, at] of Object.entries(history.read().logins)) {
    if (id === accountId) continue;
    const t = Date.parse(at);
    if (!(now - t < withinMs)) continue;
    if (!latest || t > Date.parse(latest.at)) latest = { accountId: id, at };
  }
  return latest;
}

const LOGIN_PAGE = "https://nid.naver.com/nidlogin.login";

const PROTECTED =
  "네이버가 이 아이디에 보호조치를 걸어 두었습니다. 네이버에서 보호조치를 해제(본인 확인 + 비밀번호 변경)한 뒤 다시 로그인해 주세요.";

/**
 * 네이버가 아이디를 보호조치로 잠갔는지 — 로그인하면 "회원님의 아이디를 보호하고 있습니다" 화면이 뜬다.
 * 이 상태에선 로그인해도 세션이 바로 끊겨(실측 2026-09-30) 겉으로는 '세션 만료'처럼 보인다.
 */
async function isProtectionPage(page: Page): Promise<boolean> {
  const text = await page
    .locator("body")
    .innerText({ timeout: 1000 })
    .catch(() => "");
  return /아이디를 보호하고 있습니다/.test(text);
}

/**
 * 계정별 로그인 창을 띄우고, 로그인이 **실제로 통하는지 확인한 뒤** 쿠키를 계정 폴더에 저장한다.
 * 백그라운드로 진행되며(await 불필요) 진행 상태는 loginStatus로 폴링한다.
 * ⚠️ 비밀번호는 저장/입력하지 않는다 — 사용자가 창에서 직접 로그인.
 *
 * 인증 쿠키가 보이자마자 저장하고 창을 닫으면 안 된다(실측 2026-09-30): 그렇게 저장한
 * 세션이 2분 뒤 글쓰기 화면에서 거부됐는데 화면에는 '로그인 완료'로 나갔다.
 * 글쓰기 화면까지 열어 보고, 거부되면 같은 창에서 다시 로그인하게 한다.
 *
 * @param blogId 이 계정이 글을 올릴 블로그 — 글쓰기 화면 확인에 쓴다
 */
export async function startLogin(accountId: string, blogId?: string): Promise<void> {
  if (active.has(accountId)) return; // 이미 진행 중
  active.add(accountId);
  const waiting = (message: string): void => {
    states.set(accountId, { status: "waiting", message, startedAt: Date.now() });
  };
  waiting("열린 창에서 직접 네이버에 로그인해 주세요 (2단계 인증 포함).");

  let context: Awaited<ReturnType<typeof launchContext>> | null = null;
  try {
    const hadSession = hasSavedSession(accountId);
    context = await launchContext({ headless: false, accountId });
    const page = context.pages()[0] ?? (await context.newPage());

    const succeed = async (note: string): Promise<void> => {
      await saveCookies(context!, accountId);
      recordLogin(accountId);
      markSessionValid(accountId); // 재로그인 성공 → '재로그인 필요' 해제
      states.set(accountId, { status: "success", message: "로그인 완료 — 세션이 저장됐습니다." });
      log.info(`[${accountId}] 로그인 성공 — 세션 저장 (${note})`);
    };

    // 저장해 둔 세션이 아직 살아 있으면 다시 로그인할 필요가 없다
    if (hadSession && blogId && (await verifyWriteSession(page, blogId)) === "ok") {
      await succeed("기존 세션이 유효함");
      return;
    }
    // 죽은 쿠키가 남아 있으면 로그인하기도 전에 '로그인됨'으로 보인다 → 지우고 시작
    await clearAuthCookies(context);
    await page.goto(LOGIN_PAGE, { waitUntil: "domcontentloaded" });

    let deadline = Date.now() + 5 * 60 * 1000; // 최대 5분
    let protectedNoticed = false;
    while (Date.now() < deadline) {
      if (!protectedNoticed && (await isProtectionPage(page))) {
        protectedNoticed = true;
        // 본인 확인·비밀번호 변경은 5분 안에 끝나지 않는다 — 도중에 창이 닫히지 않게 늘린다
        deadline = Date.now() + 15 * 60 * 1000;
        waiting(PROTECTED);
        log.warn(`[${accountId}] 네이버 보호조치 화면 감지 — 해제할 때까지 로그인 불가`);
      }
      if (await isLoggedIn(context)) {
        if (!blogId) {
          await succeed("블로그 아이디가 없어 글쓰기 화면 확인은 건너뜀");
          return;
        }
        waiting("로그인 확인 중 — 글쓰기 화면을 열어 보고 있습니다.");
        // 로그인 직후 이어지는 이동(기기 등록·네이버 홈)이 끝난 뒤에 확인한다
        await page.waitForLoadState("load", { timeout: 10000 }).catch(() => {});
        const verdict = await verifyWriteSession(page, blogId);
        if (verdict !== "expired") {
          await succeed(verdict === "ok" ? "글쓰기 화면 확인" : "글쓰기 화면은 확인하지 못함");
          return;
        }
        // 네이버가 인증 쿠키를 지우고 로그인 화면으로 돌려보냈다 — 같은 창에서 다시 받는다
        log.warn(`[${accountId}] 로그인 직후 글쓰기 화면이 거부됨 (${blogId}) — 다시 로그인 대기`);
        await clearAuthCookies(context);
        waiting("네이버가 방금 로그인을 받아 주지 않았습니다. 열린 창에서 한 번 더 로그인해 주세요.");
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (protectedNoticed) {
      states.set(accountId, { status: "error", message: PROTECTED });
      log.warn(`[${accountId}] 보호조치가 해제되지 않아 로그인하지 못함`);
      return;
    }
    states.set(accountId, { status: "timeout", message: "시간 초과 — 다시 시도해 주세요." });
    log.warn(`[${accountId}] 로그인 시간 초과`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "로그인 실패";
    states.set(accountId, { status: "error", message: msg });
    log.error(`[${accountId}] 로그인 실패`, err);
  } finally {
    active.delete(accountId);
    if (context) await closeContext(context).catch(() => {});
  }
}
