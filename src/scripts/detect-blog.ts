import "dotenv/config";
import { launchContext, isLoggedIn, closeContext } from "../naver/session";
import { ensureAppDirs } from "../config/paths";

// 로그인 세션에서 내 blogId 자동 탐지 + 블로그 홈 스크린샷
async function main() {
  ensureAppDirs();
  const outShot = process.argv[2] ?? "/tmp/senbi-bloghome.png";
  const context = await launchContext({ headless: true });
  try {
    if (!(await isLoggedIn(context))) {
      console.log("미로그인 상태입니다. npm run login 먼저 하세요.");
      return;
    }
    const page = await context.newPage();
    await page.goto("https://blog.naver.com/", { waitUntil: "networkidle" });

    // 페이지 내 blog.naver.com/{id} 링크들을 텍스트와 함께 수집
    const links = await page.$$eval("a[href*='blog.naver.com']", (as) =>
      as
        .map((a) => {
          const href = (a as { href: string }).href;
          const text = (a.textContent || "").trim().slice(0, 20);
          const m = href.match(/blog\.naver\.com\/([A-Za-z0-9_-]+)(?:$|[/?#])/);
          return m ? { id: m[1], text, href } : null;
        })
        .filter(Boolean),
    );

    // "내블로그/내 블로그" 텍스트를 가진 링크 우선
    const cand = links as { id: string; text: string; href: string }[];
    const mine = cand.find((l) => /내\s*블로그|내블로그|MY/i.test(l.text));

    console.log("=== 현재 URL ===", page.url());
    console.log("=== 내 블로그로 추정 ===", mine ? mine.id : "(자동 탐지 실패)");
    console.log("=== 발견된 blog.naver.com 링크 (상위 12) ===");
    const seen = new Set<string>();
    for (const l of cand) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      console.log(`  ${l.id}  ${l.text ? "["+l.text+"]" : ""}`);
      if (seen.size >= 12) break;
    }

    await page.screenshot({ path: outShot, fullPage: false });
    console.log("스크린샷:", outShot);
  } finally {
    await closeContext(context);
  }
}

main().catch((e) => {
  console.error("탐지 실패:", e);
  process.exit(1);
});
