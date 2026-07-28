import "dotenv/config";
import fs from "node:fs";
import { launchContext, isLoggedIn, closeContext } from "../naver/session";
import { publishPost } from "../naver/publish";
import { ensureAppDirs } from "../config/paths";

// 썸네일 단독 삽입 + 가운데 정렬 검증 (임시저장까지만)
async function main() {
  ensureAppDirs();
  const imgPath = fs.readFileSync("/tmp/senbi-testimg.txt", "utf8").trim();
  const thumb = { path: imgPath, source: "test", width: 966, height: 0 };
  const context = await launchContext({ headless: true });
  try {
    if (!(await isLoggedIn(context))) return console.log("미로그인");
    const r = await publishPost(context, {
      blogId: "ojs5404",
      post: {
        title: "썸네일 가운데 정렬 테스트",
        rawContent: "첫 문단 본문입니다.\n\n둘째 문단 본문입니다.",
      },
      images: [],
      thumbnail: thumb,
      dryRun: true,
      debugScreenshot: "/tmp/senbi-thumbtest.png",
    });
    console.log("결과:", JSON.stringify(r));
  } finally {
    await closeContext(context);
  }
}
main().catch((e) => {
  console.error("실패:", e);
  process.exit(1);
});
