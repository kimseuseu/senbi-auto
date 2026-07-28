import "dotenv/config";
import fs from "node:fs";
import { launchContext, isLoggedIn, closeContext } from "../naver/session";
import { ensureAppDirs } from "../config/paths";

// 단일 이미지 삽입 후 '가운데 정렬' 컨트롤 셀렉터 확인
async function main() {
  ensureAppDirs();
  const imgPath = fs.readFileSync("/tmp/senbi-testimg.txt", "utf8").trim();
  const context = await launchContext({ headless: true });
  try {
    if (!(await isLoggedIn(context))) return console.log("미로그인");
    const page = await context.newPage();
    await page.goto("https://blog.naver.com/ojs5404?Redirect=Write&", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(4500);
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

    // 단일 이미지 삽입
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 12000 }),
      frame.locator(".se-image-toolbar-button").first().click(),
    ]);
    await chooser.setFiles([imgPath]);
    await frame.waitForTimeout(5000);

    // 삽입된 이미지 클릭(선택)
    try {
      await frame.locator("img.se-image-resource, .se-module-image img").first().click();
      await frame.waitForTimeout(1200);
    } catch (e) { console.log("이미지 클릭 실패", e); }

    // 정렬/이미지 컨트롤 덤프
    const ctrls = await frame.evaluate(`(() => {
      const els = Array.from(document.querySelectorAll('button, a, [role=button]'))
        .map(el => ({ cls:(el.getAttribute('class')||'').slice(0,70), aria: el.getAttribute('aria-label')||'', dv: el.getAttribute('data-value')||el.getAttribute('data-name')||'', txt:(el.textContent||'').trim().slice(0,12) }))
        .filter(x => /align|position|가운데|정렬|center|left|right|가로/i.test(x.cls+x.aria+x.dv+x.txt));
      return els.slice(0,20);
    })()`);
    console.log("=== 정렬/위치 컨트롤 ===");
    console.log(JSON.stringify(ctrls, null, 2));
    await page.screenshot({ path: "/tmp/senbi-imgalign.png" });
    console.log("스크린샷: /tmp/senbi-imgalign.png");
  } finally {
    await closeContext(context);
  }
}
main().catch((e) => { console.error("실패:", e); process.exit(1); });
