import "dotenv/config";
import { launchContext, isLoggedIn, closeContext } from "../naver/session";
import { crawlBlog } from "../crawl/crawler";
import { prepareImages } from "../media/images";
import { publishPost } from "../naver/publish";
import { ensureAppDirs } from "../config/paths";

// 발행 드라이버 검증 — dryRun(임시저장까지만). 실제 발행 안 함.
async function main() {
  ensureAppDirs();
  const blogId = process.argv[2] ?? "ojs5404";

  // 테스트 이미지 2장 준비 (크롤 → 약한 필터)
  console.log("테스트 이미지 준비 중...");
  const posts = await crawlBlog("naver_diary", { count: 3 });
  const urls = posts.flatMap((p) => p.images).slice(0, 2);
  const images = await prepareImages({
    crawledImageUrls: urls,
    count: 2,
    sources: ["crawl"],
    filterStrength: 0.2,
  });
  console.log(`이미지 ${images.length}장 준비 완료`);

  const context = await launchContext({ headless: true });
  try {
    if (!(await isLoggedIn(context))) {
      console.log("미로그인. npm run login 먼저.");
      return;
    }
    // argv[3] === "publish" 이면 실제 발행(비공개), 아니면 임시저장(dryRun)
    const realPublish = process.argv[3] === "publish";
    const res = await publishPost(context, {
      blogId,
      post: {
        title: "자동 발행 테스트 (비공개)",
        rawContent:
          "첫 문단입니다. 자동 발행 파이프라인 테스트예요.\n\n둘째 문단입니다. 문단 사이에 이미지가 잘 들어가는지 확인합니다.\n\n셋째 문단입니다. 이 글은 비공개로 올라가 작성자만 볼 수 있습니다.\n\n넷째 문단으로 마무리합니다.",
      },
      images,
      tags: ["테스트", "자동화"],
      visibility: "private", // ★ 비공개
      dryRun: !realPublish, // publish 인자 없으면 임시저장까지만
      debugScreenshot: "/tmp/senbi-publish-result.png",
    });
    console.log(`모드: ${realPublish ? "실제 발행(비공개)" : "임시저장"}`);
    console.log("발행 결과:", JSON.stringify(res));
    console.log("검증 스크린샷: /tmp/senbi-publish-result.png");
  } finally {
    await closeContext(context);
  }
}

main().catch((e) => {
  console.error("test-publish 실패:", e);
  process.exit(1);
});
