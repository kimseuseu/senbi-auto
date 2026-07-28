import "dotenv/config";
import { launchContext, isLoggedIn, closeContext } from "../naver/session";
import { fetchBlogRss } from "../crawl/rss";
import { ensureAppDirs } from "../config/paths";

// 댓글 입력창 + 서로이웃 신청 폼 DOM 덤프 (신청/댓글 확정은 안 함)
async function main() {
  ensureAppDirs();
  const context = await launchContext({ headless: true });
  try {
    if (!(await isLoggedIn(context))) {
      console.log("미로그인");
      return;
    }
    const page = await context.newPage();

    // 공식 블로그 글 하나를 대상으로 (댓글창 구조만 확인)
    const rss = await fetchBlogRss("blogpeople");
    const target = rss.posts[0]!;
    const postUrl = `https://m.blog.naver.com/blogpeople/${target.logNo}`;
    await page.goto(postUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    // ---------- 댓글 버튼 클릭 → 댓글창 구조 ----------
    try {
      await page.locator("[class*=comment_btn]").first().click({ timeout: 5000 });
      await page.waitForTimeout(2500);
    } catch (e) {
      console.log("댓글 버튼 클릭 실패", e);
    }
    const cmt = await page.evaluate(`(() => {
      const areas = Array.from(document.querySelectorAll('textarea, [contenteditable=true], .u_cbox_text, .u_cbox_write')).slice(0,6)
        .map(el => ({ tag: el.tagName, cls:(el.getAttribute('class')||'').slice(0,50), ph: el.getAttribute('placeholder')||'' }));
      const submit = Array.from(document.querySelectorAll('button, a')).filter(el => /등록/.test((el.textContent||'')) || /u_cbox_btn_upload|upload/.test(el.getAttribute('class')||''))
        .slice(0,5).map(el => ({ tag: el.tagName, cls:(el.getAttribute('class')||'').slice(0,50), txt:(el.textContent||'').trim().slice(0,10) }));
      return { writeAreas: areas, submitButtons: submit };
    })()`);
    console.log("=== 댓글창 DOM ===");
    console.log(JSON.stringify(cmt, null, 2));
    await page.screenshot({ path: "/tmp/senbi-comment.png" });

    // ---------- 서로이웃 신청 폼 (BuddyAddForm — 로드만, 신청 안 함) ----------
    const buddyUrls = [
      "https://m.blog.naver.com/BuddyAddForm.naver?blogId=blogpeople",
      "https://blog.naver.com/BuddyAddForm.naver?blogId=blogpeople",
    ];
    for (const u of buddyUrls) {
      await page.goto(u, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(2000);
      const buddy = await page.evaluate(`(() => {
        const radios = Array.from(document.querySelectorAll('input[type=radio]')).map(r => ({ name:r.getAttribute('name')||'', val:r.getAttribute('value')||'', id:r.id||'' }));
        const areas = Array.from(document.querySelectorAll('textarea, input[type=text]')).slice(0,6).map(el => ({ tag:el.tagName, cls:(el.getAttribute('class')||'').slice(0,40), ph:el.getAttribute('placeholder')||'', id:el.id||'' }));
        const btns = Array.from(document.querySelectorAll('button, a')).map(el => (el.textContent||'').trim()).filter(t => /다음|확인|신청|추가/.test(t) && t.length<=8);
        return { url: location.href, radios: radios.slice(0,6), areas, buttons: Array.from(new Set(btns)).slice(0,8) };
      })()`);
      console.log("=== 서로이웃 폼 ===", u);
      console.log(JSON.stringify(buddy, null, 2));
      await page.screenshot({ path: "/tmp/senbi-buddy.png" });
      const b = buddy as { radios: unknown[] };
      if (b.radios.length > 0) break;
    }
    console.log("스크린샷: /tmp/senbi-comment.png, /tmp/senbi-buddy.png");
  } finally {
    await closeContext(context);
  }
}

main().catch((e) => {
  console.error("inspect-neighbor2 실패:", e);
  process.exit(1);
});
