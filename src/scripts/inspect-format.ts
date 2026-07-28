import "dotenv/config";
import { launchContext, isLoggedIn, closeContext } from "../naver/session";
import { ensureAppDirs } from "../config/paths";

// 정렬·글자크기 드롭다운 옵션 셀렉터 확인
async function main() {
  ensureAppDirs();
  const blogId = "ojs5404";
  const context = await launchContext({ headless: true });
  try {
    if (!(await isLoggedIn(context))) return console.log("미로그인");
    const page = await context.newPage();
    await page.goto(`https://blog.naver.com/${blogId}?Redirect=Write&`, {
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
    await frame.waitForTimeout(800);

    // 본문 클릭 (툴바 활성화)
    await frame
      .locator(".se-section:not(.se-section-documentTitle) .se-text-paragraph")
      .first()
      .click();
    await frame.waitForTimeout(600);

    // 글자크기 드롭다운 열기
    await frame.locator(".se-font-size-code-toolbar-button").first().click().catch(() => {});
    await frame.waitForTimeout(1000);
    const sizes = await frame.evaluate(`(() => {
      const els = Array.from(document.querySelectorAll('*')).filter(el => (el.textContent||'').trim()==='19' && el.children.length===0);
      return els.slice(0,4).map(el => ({
        tag: el.tagName,
        cls: el.getAttribute('class')||'',
        pcls: (el.parentElement && el.parentElement.getAttribute('class'))||'',
        dv: el.getAttribute('data-value') || (el.parentElement && el.parentElement.getAttribute('data-value'))||''
      }));
    })()`);
    console.log("=== 글자크기 옵션 ===");
    console.log(JSON.stringify(sizes, null, 2));
    await page.screenshot({ path: "/tmp/senbi-fontsize.png" });
    await page.keyboard.press("Escape").catch(() => {});
    await frame.waitForTimeout(600);

    // 정렬 드롭다운 열기
    await frame.locator(".se-toolbar-item-align button, .se-property-toolbar-align").first().click().catch(() => {});
    await frame.waitForTimeout(1000);
    const aligns = await frame.evaluate(`(() => {
      return Array.from(document.querySelectorAll('button, li, a'))
        .filter(el => /align/i.test(el.getAttribute('class')||'') || /가운데|왼쪽|오른쪽|양쪽/.test(el.getAttribute('aria-label')||el.textContent||''))
        .slice(0,15)
        .map(el => ({ cls:(el.getAttribute('class')||'').slice(0,60), aria: el.getAttribute('aria-label')||'', val: el.getAttribute('data-value')||'' }));
    })()`);
    console.log("=== 정렬 옵션 ===");
    console.log(JSON.stringify(aligns, null, 2));
    await page.screenshot({ path: "/tmp/senbi-align.png" });
  } finally {
    await closeContext(context);
  }
}

main().catch((e) => {
  console.error("inspect-format 실패:", e);
  process.exit(1);
});
