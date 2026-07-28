import "dotenv/config";
import { launchContext, isLoggedIn, closeContext } from "../naver/session";
import { ensureAppDirs } from "../config/paths";

// 브라우저 구동/네비게이션/세션 상태 점검 (로그인은 하지 않음)
async function main() {
  ensureAppDirs();
  const context = await launchContext({ headless: true });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://nid.naver.com/nidlogin.login", {
    waitUntil: "domcontentloaded",
  });
  const title = await page.title();
  const loggedIn = await isLoggedIn(context);
  console.log(`페이지 제목: ${title}`);
  console.log(`로그인 상태: ${loggedIn ? "로그인됨" : "미로그인"}`);
  console.log(`브라우저 구동/네비게이션 정상 ✅`);
  await closeContext(context);
  process.exit(0);
}

main().catch((e) => {
  console.error("브라우저 점검 실패:", e);
  process.exit(1);
});
