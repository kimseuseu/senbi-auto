import "dotenv/config";
import { launchContext, isLoggedIn, closeContext, saveCookies } from "../naver/session";
import { ensureAppDirs } from "../config/paths";

/**
 * 네이버 로그인 세션 만들기 (최초 1회).
 *   npm run login
 * 창이 열리면 사용자가 직접 로그인하세요. (프로그램은 비밀번호를 대신 입력하지 않습니다.)
 * 로그인이 감지되면 세션이 저장되고 자동으로 종료됩니다.
 */
async function main() {
  ensureAppDirs();
  console.log("브라우저를 여는 중... 창에서 직접 네이버에 로그인해 주세요.");
  const context = await launchContext({ headless: false });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://nid.naver.com/nidlogin.login", {
    waitUntil: "domcontentloaded",
  });

  console.log("로그인 대기 중... (2단계 인증까지 완료해 주세요)");
  const deadline = Date.now() + 5 * 60 * 1000; // 최대 5분 대기
  while (Date.now() < deadline) {
    if (await isLoggedIn(context)) {
      await saveCookies(context); // 세션 쿠키를 파일로 저장 (재주입용)
      console.log("\n✅ 로그인 감지됨 — 세션을 저장했습니다. 이제 자동 실행이 가능합니다.");
      await closeContext(context);
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log("\n⏱️  시간 초과 — 로그인이 감지되지 않았습니다. 다시 시도해 주세요.");
  await closeContext(context);
  process.exit(1);
}

main().catch((e) => {
  console.error("로그인 스크립트 실패:", e);
  process.exit(1);
});
