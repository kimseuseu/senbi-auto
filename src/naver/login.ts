import { launchContext, isLoggedIn, closeContext, saveCookies } from "./session";
import { markSessionValid } from "./sessionState";
import { createLogger } from "../core/logger";

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

/**
 * 계정별 로그인 창을 띄우고, 로그인 감지 시 쿠키를 계정 폴더에 저장한다.
 * 백그라운드로 진행되며(await 불필요) 진행 상태는 loginStatus로 폴링한다.
 * ⚠️ 비밀번호는 저장/입력하지 않는다 — 사용자가 창에서 직접 로그인.
 */
export async function startLogin(accountId: string): Promise<void> {
  if (active.has(accountId)) return; // 이미 진행 중
  active.add(accountId);
  states.set(accountId, {
    status: "waiting",
    message: "열린 창에서 직접 네이버에 로그인해 주세요 (2단계 인증 포함).",
    startedAt: Date.now(),
  });

  let context: Awaited<ReturnType<typeof launchContext>> | null = null;
  try {
    context = await launchContext({ headless: false, accountId });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://nid.naver.com/nidlogin.login", {
      waitUntil: "domcontentloaded",
    });

    const deadline = Date.now() + 5 * 60 * 1000; // 최대 5분
    while (Date.now() < deadline) {
      if (await isLoggedIn(context)) {
        await saveCookies(context, accountId);
        markSessionValid(accountId); // 재로그인 성공 → '재로그인 필요' 해제
        states.set(accountId, { status: "success", message: "로그인 완료 — 세션이 저장됐습니다." });
        log.info(`[${accountId}] 로그인 성공 — 세션 저장`);
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
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
