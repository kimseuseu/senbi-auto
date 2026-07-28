import "dotenv/config";
import { launchContext, isLoggedIn, closeContext } from "../naver/session";
import { ensureAppDirs } from "../config/paths";

// 발행된 글(모바일)을 풀페이지 캡처
async function main() {
  ensureAppDirs();
  const url = process.argv[2];
  const out = process.argv[3] ?? "/tmp/senbi-post-full.png";
  if (!url) return console.log("사용법: shot-post.ts <post-url> [출력]");
  const mobileUrl = url.replace("blog.naver.com", "m.blog.naver.com");

  const context = await launchContext({ headless: true });
  try {
    if (!(await isLoggedIn(context))) return console.log("미로그인");
    const page = await context.newPage();
    await page.setViewportSize({ width: 480, height: 900 });
    await page.goto(mobileUrl, { waitUntil: "networkidle" });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: out, fullPage: true });
    console.log("캡처:", out);
  } finally {
    await closeContext(context);
  }
}

main().catch((e) => {
  console.error("shot-post 실패:", e);
  process.exit(1);
});
