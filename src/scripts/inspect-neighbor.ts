import "dotenv/config";
import { launchContext, isLoggedIn, closeContext } from "../naver/session";
import { ensureAppDirs } from "../config/paths";

// 이웃 피드 + 공감/댓글 DOM 구조 덤프 (읽기만, 실제 공감/댓글 안 함)
async function main() {
  ensureAppDirs();
  const context = await launchContext({ headless: true });
  try {
    if (!(await isLoggedIn(context))) {
      console.log("미로그인");
      return;
    }
    const page = await context.newPage();

    // ---------- 1) 이웃새글 피드 ----------
    const feedUrls = [
      "https://m.blog.naver.com/FeedList.naver",
      "https://section.blog.naver.com/BlogHome.naver",
    ];
    let feedItems: { blogId: string; logNo: string }[] = [];
    for (const url of feedUrls) {
      await page.goto(url, { waitUntil: "networkidle" }).catch(() => {});
      await page.waitForTimeout(2000);
      const items = await page.$$eval("a[href*='blog.naver.com'], a[href*='/PostView']", (as) =>
        as
          .map((a) => (a as { href: string }).href)
          .map((h) => {
            const m = h.match(/blog\.naver\.com\/([A-Za-z0-9_-]+)\/(\d+)/) ||
              h.match(/blogId=([A-Za-z0-9_-]+)&logNo=(\d+)/);
            return m ? { blogId: m[1], logNo: m[2] } : null;
          })
          .filter(Boolean),
      );
      const uniq: { blogId: string; logNo: string }[] = [];
      const seen = new Set<string>();
      for (const it of items as { blogId: string; logNo: string }[]) {
        const k = `${it.blogId}/${it.logNo}`;
        if (!seen.has(k)) { seen.add(k); uniq.push(it); }
      }
      console.log(`[피드] ${url} → ${uniq.length}건`);
      if (uniq.length > feedItems.length) feedItems = uniq;
      if (uniq.length >= 5) break;
    }
    await page.screenshot({ path: "/tmp/senbi-feed.png" });
    console.log("피드 스크린샷: /tmp/senbi-feed.png");
    console.log("샘플:", JSON.stringify(feedItems.slice(0, 3)));

    // ---------- 2) 한 이웃 글의 공감/댓글 DOM ----------
    const target = feedItems[0];
    if (!target) {
      console.log("피드에서 대상 글을 못 찾음");
      return;
    }
    const postUrl = `https://m.blog.naver.com/${target.blogId}/${target.logNo}`;
    await page.goto(postUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    console.log("대상 글:", postUrl);

    const dom = await page.evaluate(`(() => {
      const pick = (els) => Array.from(els).slice(0,6).map(el => ({
        tag: el.tagName, cls: (el.getAttribute('class')||'').slice(0,55),
        aria: el.getAttribute('aria-label')||'', txt: (el.textContent||'').trim().slice(0,14)
      }));
      const like = pick(document.querySelectorAll("[class*=like], [class*=sympathy], a[class*=u_likeit], .u_likeit_list_btn"));
      const comment = pick(document.querySelectorAll("[class*=comment], [class*=cmt], a[href*='comment']"));
      const textareas = Array.from(document.querySelectorAll('textarea, [contenteditable=true]')).slice(0,5).map(el => ({ tag: el.tagName, cls:(el.getAttribute('class')||'').slice(0,50), ph: el.getAttribute('placeholder')||'' }));
      return { like, comment, textareas };
    })()`);
    console.log("=== 공감/댓글 DOM ===");
    console.log(JSON.stringify(dom, null, 2));
    await page.screenshot({ path: "/tmp/senbi-post.png", fullPage: false });
    console.log("글 스크린샷: /tmp/senbi-post.png");
  } finally {
    await closeContext(context);
  }
}

main().catch((e) => {
  console.error("inspect-neighbor 실패:", e);
  process.exit(1);
});
