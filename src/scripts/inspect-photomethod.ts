import "dotenv/config";
import { launchContext, isLoggedIn, closeContext } from "../naver/session";
import { crawlBlog } from "../crawl/crawler";
import { prepareImages } from "../media/images";
import { ensureAppDirs } from "../config/paths";

// "사진 첨부 방식"(개별/콜라주/슬라이드) 팝업의 콜라주 버튼 셀렉터 확인
async function main() {
  ensureAppDirs();
  const posts = await crawlBlog("naver_diary", { count: 2 });
  const urls = posts.flatMap((p) => p.images).slice(0, 2);
  const imgs = await prepareImages({
    crawledImageUrls: urls,
    count: 2,
    sources: ["crawl"],
    filterStrength: 0.2,
  });

  const context = await launchContext({ headless: true });
  try {
    if (!(await isLoggedIn(context))) return console.log("미로그인");
    const page = await context.newPage();
    await page.goto("https://blog.naver.com/ojs5404?Redirect=Write&", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(4000);
    const fe = await page.$("#mainFrame");
    const frame = fe ? await fe.contentFrame() : null;
    if (!frame) return console.log("iframe 없음");
    await frame.waitForTimeout(1500);
    try {
      const c = frame.locator(".se-popup-button-cancel").first();
      if (await c.isVisible({ timeout: 3000 })) await c.click();
    } catch {}
    await frame.locator(".se-section:not(.se-section-documentTitle) .se-text-paragraph").first().click();
    await frame.waitForTimeout(600);

    // 이미지 2장 업로드 → 팝업 대기
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 12000 }),
      frame.locator(".se-image-toolbar-button").first().click(),
    ]);
    await chooser.setFiles(imgs.map((a) => a.path));
    await frame.waitForTimeout(2500);

    const popup = await frame.evaluate(`(() => {
      const btns = Array.from(document.querySelectorAll('button, a, li, div'))
        .filter(el => /개별사진|콜라주|슬라이드/.test((el.textContent||'').trim()) && (el.textContent||'').trim().length <= 12)
        .slice(0,10)
        .map(el => ({ tag: el.tagName, txt:(el.textContent||'').trim(), cls:(el.getAttribute('class')||'').slice(0,60), dv: el.getAttribute('data-value')||el.getAttribute('data-name')||'' }));
      return btns;
    })()`);
    console.log("=== 사진 첨부 방식 팝업 버튼 ===");
    console.log(JSON.stringify(popup, null, 2));
    await page.screenshot({ path: "/tmp/senbi-photomethod.png" });
  } finally {
    await closeContext(context);
  }
}

main().catch((e) => {
  console.error("inspect-photomethod 실패:", e);
  process.exit(1);
});
