import "dotenv/config";
import { launchContext, closeContext } from "../naver/session";
import { engageOne } from "../naver/neighbor";

/**
 * 댓글 입력 수정 검증 — 본인 블로그(ojs5404) 글에만 테스트 댓글을 남긴다.
 *   npx tsx src/scripts/verify-comment.ts [logNo]
 */
const logNo = process.argv[2] ?? "224359103341";
const text = "테스트 댓글입니다. 확인 후 삭제해 주세요.";

const ctx = await launchContext({ headless: true, accountId: "acc-ojs5404" });
try {
  const r = await engageOne(ctx, "ojs5404", logNo, text);
  console.log("engageOne 결과:", JSON.stringify(r));

  // 등록됐는지 페이지에서 재확인
  const page = await ctx.newPage();
  await page.goto(`https://m.blog.naver.com/ojs5404/${logNo}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.locator("[class*=comment_btn]").first().click().catch(() => {});
  await page.waitForTimeout(3000);
  const found = await page
    .locator(`.u_cbox_contents:has-text("테스트 댓글입니다")`)
    .count()
    .catch(() => 0);
  console.log(found > 0 ? "✅ 댓글이 실제로 등록됨" : "❌ 등록된 댓글을 찾지 못함");
} finally {
  await closeContext(ctx);
}
process.exit(0);
