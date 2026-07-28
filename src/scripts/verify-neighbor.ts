import "dotenv/config";
import { launchContext, isLoggedIn, closeContext } from "../naver/session";
import { engageOne, fetchNeighborFeed } from "../naver/neighbor";
import { fetchBlogRss } from "../crawl/rss";
import { ensureAppDirs } from "../config/paths";

// ① 본인 글 댓글 스크린샷 ② 이웃 글 1건 공감(공감만) 검증
async function main() {
  ensureAppDirs();
  const blogId = process.argv[2] ?? "ojs5404";
  const context = await launchContext({ headless: true });
  try {
    if (!(await isLoggedIn(context))) {
      console.log("미로그인");
      return;
    }

    // ① 본인 글 댓글 확인 스크린샷
    const rss = await fetchBlogRss(blogId);
    const latest = rss.posts[0]!;
    const page = await context.newPage();
    await page.goto(`https://m.blog.naver.com/${blogId}/${latest.logNo}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(2500);
    try {
      await page.locator("[class*=comment_btn]").first().click({ timeout: 5000 });
      await page.waitForTimeout(2500);
    } catch {
      /* */
    }
    await page.screenshot({ path: "/tmp/senbi-own-comment.png", fullPage: false });
    console.log("본인 글 댓글 스크린샷: /tmp/senbi-own-comment.png");
    await page.close();

    // ② 이웃 글 1건 공감 검증 (공감만, 댓글 없음)
    const feed = await fetchNeighborFeed(context, 10);
    const target = feed.find((f) => f.blogId !== blogId);
    if (!target) {
      console.log("이웃 글을 못 찾음");
      return;
    }
    console.log(`이웃 글 공감 시도: ${target.blogId}/${target.logNo}`);
    const res = await engageOne(context, target.blogId, target.logNo, null);
    console.log("공감 결과:", JSON.stringify(res));
  } finally {
    await closeContext(context);
  }
}

main().catch((e) => {
  console.error("verify-neighbor 실패:", e);
  process.exit(1);
});
