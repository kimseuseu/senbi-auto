import "dotenv/config";
import { launchContext, closeContext } from "../naver/session";
import { runNeighborRound } from "../naver/neighbor";
import { getSettings, resolveApiKey } from "../config/settings";
import { getAccount, resolveAccountSettings } from "../core/accounts";

/**
 * 앱과 동일한 이웃 라운드를 드라이런으로 실행 (SENBI_COMMENT_DRYRUN=1 이면 댓글 등록 생략).
 * 실패 시 상태 덤프가 로그에 찍힌다.
 */
const acc = getAccount("acc-ojs5404");
const base = acc ? resolveAccountSettings(acc) : getSettings();
const settings = { ...base, neighbor: { ...base.neighbor, minDelaySec: 2, maxDelaySec: 4, dailyCommentLimit: 1 } };
const apiKey = resolveApiKey(settings);

const ctx = await launchContext({ headless: true, accountId: "acc-ojs5404" });
try {
  const r = await runNeighborRound(ctx, settings, apiKey);
  console.log("라운드 결과:", JSON.stringify(r));
} finally {
  await closeContext(ctx);
}
process.exit(0);
