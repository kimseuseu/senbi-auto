import "dotenv/config";
import fs from "node:fs";
import { launchContext, isLoggedIn, closeContext } from "../naver/session";
import { ensureAppDirs } from "../config/paths";

// 글쓰기(SmartEditor) 화면 구조 덤프 → 발행 셀렉터 튜닝용
async function main() {
  ensureAppDirs();
  const context = await launchContext({ headless: true });
  try {
    if (!(await isLoggedIn(context))) {
      console.log("미로그인. npm run login 먼저.");
      return;
    }
    const page = await context.newPage();

    // 1) 내 blogId 확보 (MyBlog.naver 리다이렉트)
    await page.goto("https://blog.naver.com/MyBlog.naver", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(1500);
    const myUrl = page.url();
    const blogId = myUrl.match(/blog\.naver\.com\/([A-Za-z0-9_-]+)/)?.[1] ?? null;
    console.log("MyBlog URL:", myUrl);
    console.log("blogId:", blogId);
    if (!blogId) {
      console.log("blogId 탐지 실패");
      return;
    }

    // 2) 글쓰기 페이지 진입
    const writeUrl = `https://blog.naver.com/${blogId}?Redirect=Write&`;
    await page.goto(writeUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);

    // 3) 에디터 iframe
    const frameEl = await page.$("#mainFrame");
    const frame = frameEl ? await frameEl.contentFrame() : null;
    console.log("iframe(#mainFrame) 발견:", Boolean(frame));
    if (!frame) {
      // iframe 없이 바로 에디터일 수도 있음
      await page.screenshot({ path: "/tmp/senbi-write.png", fullPage: false });
      console.log("스크린샷(iframe 없음): /tmp/senbi-write.png");
      return;
    }
    await frame.waitForTimeout(2500);

    // 4) 구조 진단 (문자열로 전달 — tsx/esbuild의 __name 직렬화 이슈 회피)
    const diag = await frame.evaluate(`(() => {
      const q = (sel) => document.querySelectorAll(sel).length;
      const btns = Array.from(document.querySelectorAll('button, a, span'))
        .map((el) => (el.textContent || '').trim())
        .filter((t) => /발행|저장|등록|다음|확인/.test(t) && t.length <= 8);
      const editables = Array.from(document.querySelectorAll("[contenteditable='true']"))
        .map((el) => (el.getAttribute('class') || '').slice(0, 90));
      const fileInputs = Array.from(document.querySelectorAll('input[type=file]'))
        .map((el) => (el.getAttribute('accept') || '(accept 없음)'));
      return {
        documentTitle: q('.se-documentTitle') + q('[class*=documentTitle]'),
        titlePlaceholder: q('.se-placeholder'),
        textParagraph: q('.se-text-paragraph'),
        seComponent: q('.se-component'),
        contentEditable: q("[contenteditable='true']"),
        editableClasses: editables.slice(0, 8),
        fileInputs,
        buttonTexts: Array.from(new Set(btns)).slice(0, 20),
        hasRecovery: document.body.innerText.includes('이전에 작성') || document.body.innerText.includes('작성 중이던'),
      };
    })()`);
    console.log("=== 에디터 구조 ===");
    console.log(JSON.stringify(diag, null, 2));

    // 5) iframe HTML 저장 (그레핑용, 앞 200KB)
    const html = await frame.content();
    fs.writeFileSync("/tmp/senbi-write-frame.html", html.slice(0, 400000));
    console.log("iframe HTML: /tmp/senbi-write-frame.html", `(${html.length} bytes)`);

    await page.screenshot({ path: "/tmp/senbi-write.png", fullPage: false });
    console.log("스크린샷: /tmp/senbi-write.png");
  } finally {
    await closeContext(context);
  }
}

main().catch((e) => {
  console.error("inspect 실패:", e);
  process.exit(1);
});
