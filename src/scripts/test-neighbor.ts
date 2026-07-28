import "dotenv/config";
import { launchContext, isLoggedIn, closeContext } from "../naver/session";
import { engageOne } from "../naver/neighbor";
import { fetchBlogRss } from "../crawl/rss";
import { ensureAppDirs } from "../config/paths";

// 안전 검증: 사장님 본인 글에 공감+테스트 댓글 (남의 블로그 영향 없음, 댓글은 지우면 됨)
async function main() {
  ensureAppDirs();
  const blogId = process.argv[2] ?? "ojs5404";

  const rss = await fetchBlogRss(blogId);
  const latest = rss.posts[0]!;
  console.log(`대상(본인) 글: ${blogId}/${latest.logNo} — ${latest.title}`);

  const context = await launchContext({ headless: true });
  try {
    if (!(await isLoggedIn(context))) {
      console.log("미로그인");
      return;
    }
    const res = await engageOne(
      context,
      blogId,
      latest.logNo,
      "자동화 테스트 댓글입니다. 확인 후 삭제해 주세요 🙂",
    );
    console.log("결과:", JSON.stringify(res));
    console.log("(공감은 본인 글이면 비활성일 수 있음 — 실제 이웃 글에선 정상 동작)");
  } finally {
    await closeContext(context);
  }
}

main().catch((e) => {
  console.error("test-neighbor 실패:", e);
  process.exit(1);
});
