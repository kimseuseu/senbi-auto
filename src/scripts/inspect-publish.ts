import "dotenv/config";
import { launchContext, isLoggedIn, closeContext } from "../naver/session";
import { ensureAppDirs } from "../config/paths";

// 제목·본문 입력 검증 + 발행 패널 구조 덤프 (발행은 하지 않음)
async function main() {
  ensureAppDirs();
  const blogId = process.argv[2] ?? "ojs5404";
  const context = await launchContext({ headless: true });
  try {
    if (!(await isLoggedIn(context))) {
      console.log("미로그인");
      return;
    }
    const page = await context.newPage();
    await page.goto(`https://blog.naver.com/${blogId}?Redirect=Write&`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(4500);
    const frameEl = await page.$("#mainFrame");
    const frame = frameEl ? await frameEl.contentFrame() : null;
    if (!frame) {
      console.log("iframe 없음");
      return;
    }
    await frame.waitForTimeout(2000);

    // 복구 팝업 취소 (있으면) — .se-popup-button-cancel
    try {
      const cancel = frame.locator(".se-popup-button-cancel").first();
      if (await cancel.isVisible({ timeout: 3000 })) {
        await cancel.click();
        console.log("복구 팝업 → 취소 클릭");
        await frame.waitForTimeout(1200);
      } else {
        console.log("복구 팝업 없음");
      }
    } catch {
      console.log("복구 팝업 없음(예외)");
    }

    // 제목 입력
    const title = frame.locator(".se-documentTitle .se-text-paragraph").first();
    await title.click();
    await page.keyboard.type("테스트 제목입니다");
    await frame.waitForTimeout(400);

    // 본문 입력 (documentTitle 아닌 첫 문단)
    const body = frame
      .locator(".se-section:not(.se-section-documentTitle) .se-text-paragraph")
      .first();
    await body.click();
    await page.keyboard.type("첫 문단 본문입니다. 잘 들어가는지 확인.");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("둘째 문단입니다.");
    await frame.waitForTimeout(500);

    await page.screenshot({ path: "/tmp/senbi-editor-filled.png" });
    console.log("입력 후 스크린샷: /tmp/senbi-editor-filled.png");

    // 발행 패널 열기 (확정 발행은 안 함)
    const pub = frame.locator("[class*=publish_btn]").first();
    await pub.click();
    await frame.waitForTimeout(2500);
    await page.screenshot({ path: "/tmp/senbi-publish-panel.png" });

    const panel = await frame.evaluate(`(() => {
      const tag = document.querySelector('input[placeholder*="태그"], textarea[placeholder*="태그"]');
      const pubButtons = Array.from(document.querySelectorAll('button'))
        .filter(b => (b.textContent||'').trim() === '발행')
        .map(b => (b.getAttribute('class')||''));
      const publicRadios = Array.from(document.querySelectorAll('input[type=radio]'))
        .map(r => ({ name: r.getAttribute('name')||'', val: r.getAttribute('value')||'', id: r.id||'' }))
        .filter(r => /open|public|공개/i.test(r.name+r.val+r.id));
      return {
        tagInput: tag ? { tag: tag.tagName, ph: tag.getAttribute('placeholder'), cls: tag.getAttribute('class')||'', id: tag.id } : null,
        publishButtons: pubButtons,
        radios: publicRadios.slice(0,6),
      };
    })()`);
    console.log("=== 발행 패널 구조 ===");
    console.log(JSON.stringify(panel, null, 2));
    console.log("패널 스크린샷: /tmp/senbi-publish-panel.png");
  } finally {
    await closeContext(context);
  }
}

main().catch((e) => {
  console.error("inspect-publish 실패:", e);
  process.exit(1);
});
