import {
  launchContext,
  isLoggedIn,
  closeContext,
  hasSavedSession,
  verifyWriteSession,
} from "./session";
import { markSessionInvalid, markSessionValid } from "./sessionState";
import { createLogger } from "../core/logger";

const log = createLogger("sessionCheck");

export interface SessionCheck {
  ok: boolean;
  /** 막힌 이유 — 사용자에게 그대로 보여 준다 */
  reason?: string;
}

const NEED_LOGIN =
  "네이버 로그인 세션이 없습니다. 상세 설정 → 블로그 계정에서 이 계정으로 로그인해 주세요.";
const EXPIRED =
  "네이버 세션이 만료되었습니다. 상세 설정 → 블로그 계정에서 이 계정으로 다시 로그인해 주세요.";

/**
 * 글을 만들기 **전에** 발행할 수 있는 상태인지 확인한다.
 *
 * 왜 필요한가: 예전엔 글을 다 만든 뒤(1분 남짓 + AI 비용) 에디터를 열어 보고서야
 * 세션 만료를 알았다. 글 3편을 걸어 두면 3편을 다 만들고 3번 다 실패했다.
 * 글쓰기 화면이 로그인 화면으로 넘어가는지만 먼저 보면 몇 초 만에 알 수 있다.
 * (겉 틀이 아니라 에디터가 뜨는지까지 본다 — verifyWriteSession 설명 참고)
 *
 * 로그인 화면으로 넘어간 게 분명할 때만 막는다. 확인 자체가 애매하게 끝나면
 * (느린 네트워크 등) 막지 않고 그대로 진행한다 — 멀쩡한 세션을 막는 쪽이 더 나쁘다.
 */
export async function checkWriteSession(opts: {
  blogId: string;
  accountId?: string;
  headless?: boolean;
}): Promise<SessionCheck> {
  if (!hasSavedSession(opts.accountId)) {
    markSessionInvalid(opts.accountId, "로그인 쿠키 없음");
    return { ok: false, reason: NEED_LOGIN };
  }

  let context: Awaited<ReturnType<typeof launchContext>>;
  try {
    context = await launchContext({ headless: opts.headless ?? true, accountId: opts.accountId });
  } catch (err) {
    // 브라우저를 못 띄우면 발행도 못 한다 — 글을 만들기 전에 알린다
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  try {
    if (!(await isLoggedIn(context))) {
      markSessionInvalid(opts.accountId, "로그인 쿠키 없음");
      return { ok: false, reason: NEED_LOGIN };
    }
    const page = await context.newPage();
    const verdict = await verifyWriteSession(page, opts.blogId);
    if (verdict === "expired") {
      markSessionInvalid(opts.accountId, "세션 만료");
      log.warn(`세션 만료 확인 (${opts.blogId}) — 글을 만들지 않고 중단`);
      return { ok: false, reason: EXPIRED };
    }
    if (verdict === "ok") {
      markSessionValid(opts.accountId);
      log.info(`로그인 세션 확인 (${opts.blogId}) — 에디터 열림`);
      return { ok: true };
    }
    log.info(`로그인 세션을 확인하지 못함 (${opts.blogId}) — 그대로 진행`);
    return { ok: true };
  } catch (err) {
    log.warn("로그인 세션 확인 중 오류 — 그대로 진행", err);
    return { ok: true };
  } finally {
    await closeContext(context);
  }
}
