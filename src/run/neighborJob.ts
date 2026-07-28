import { getSettings, resolveApiKey, type Settings } from "../config/settings";
import { launchContext, isLoggedIn, closeContext } from "../naver/session";
import { markSessionInvalid, markSessionValid } from "../naver/sessionState";
import { runNeighborRound, runBuddyRequestRound } from "../naver/neighbor";
import { createLogger } from "../core/logger";

const log = createLogger("neighborJob");

export interface NeighborJobResult {
  ok: boolean;
  likes?: number;
  comments?: number;
  buddyRequests?: number;
  error?: string;
}

/**
 * 이웃 관리 라운드: 로그인 세션으로 공감·댓글 + (설정 시) 서로이웃 신청.
 */
export async function runNeighborJob(
  opts: { headless?: boolean; settings?: Settings; accountId?: string } = {},
): Promise<NeighborJobResult> {
  const settings = opts.settings ?? getSettings();
  const apiKey = resolveApiKey(settings);

  if (!settings.neighbor.enabled) return { ok: false, error: "이웃 관리가 꺼져 있습니다." };
  if (!apiKey) return { ok: false, error: "ANTHROPIC_API_KEY가 없습니다." };

  const context = await launchContext({ headless: opts.headless ?? true, accountId: opts.accountId });
  try {
    if (!(await isLoggedIn(context))) {
      markSessionInvalid(opts.accountId, "로그인 쿠키 없음");
      return { ok: false, error: "네이버 로그인 세션이 없습니다. 상세 설정에서 이 계정으로 로그인하세요." };
    }

    const engage = await runNeighborRound(context, settings, apiKey);
    let buddyRequests = 0;
    if (settings.neighbor.buddyRequestEnabled) {
      const buddy = await runBuddyRequestRound(context, settings, apiKey);
      buddyRequests = buddy.requests;
    }

    // 공감·댓글이 실제로 됐다면 로그인 세션 정상
    if (engage.likes + engage.comments > 0) markSessionValid(opts.accountId);

    return {
      ok: true,
      likes: engage.likes,
      comments: engage.comments,
      buddyRequests,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("이웃 잡 실패", err);
    return { ok: false, error: msg };
  } finally {
    await closeContext(context);
  }
}
