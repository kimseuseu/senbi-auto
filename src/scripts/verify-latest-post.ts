import "dotenv/config";
import { launchContext, closeContext } from "../naver/session";

/** 로그인 세션으로 ojs5404 최근 글 제목을 읽어 방금 발행이 올라갔는지 확인 */
async function main() {
  const ctx = await launchContext({ headless: true, accountId: "acc-ojs5404" });
  try {
    const page = await ctx.newPage();
    // 로그인 상태에서 비공개 글도 보이는 모바일 블로그 목록
    await page.goto("https://m.blog.naver.com/PostList.naver?blogId=ojs5404", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(4000);
    const titles = await page.$$eval("strong, .title, a", (els) =>
      Array.from(new Set(els.map((e) => (e.textContent || "").trim())))
        .filter((t) => t.length >= 8 && t.length <= 60)
        .slice(0, 30),
    );
    console.log("최근 글 후보 제목:");
    titles.forEach((t) => console.log(" -", t));
    const hit = titles.find((t) => t.includes("제습기"));
    console.log(hit ? `\n✅ 방금 발행 글 확인: ${hit}` : "\n⚠️ 제습기 글이 목록에 안 보임");
  } finally {
    await closeContext(ctx);
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
