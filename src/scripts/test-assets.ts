import "dotenv/config";
import { crawlBlog } from "../crawl/crawler";
import { buildPostAssets, rankPostsByKeyword } from "../run/assets";
import { getSettings, resolveApiKey } from "../config/settings";
import { ensureAppDirs } from "../config/paths";

// 자산 로직 검증: 키워드 매칭 · 썸네일 판별 · 서명 감지 (발행 안 함)
async function main() {
  ensureAppDirs();
  const keyword = process.argv[2] ?? "이동식에에어컨 렌탈";
  const settings = getSettings();
  const apiKey = resolveApiKey(settings);
  const learn = settings.learnBlogId || "khj-1104";

  console.log(`학습 크롤: ${learn}`);
  const posts = await crawlBlog(learn, { count: settings.crawlCount });

  console.log(`\n[키워드 매칭] "${keyword}" 상위 3글:`);
  rankPostsByKeyword(posts, keyword).slice(0, 3).forEach((p, i) =>
    console.log(`  ${i + 1}. ${p.title}`),
  );

  const pa = await buildPostAssets(posts, keyword, settings, apiKey);
  console.log(`\n=== 결과 ===`);
  console.log(`본문 이미지: ${pa.bodyImages.length}장`);
  console.log(`썸네일: ${pa.thumbnail ? pa.thumbnail.path : "없음"}`);
  console.log(`서명: ${pa.signature.length}블록`);
  pa.signature.forEach((b, i) => {
    if (b.type === "text") console.log(`  ${i + 1}. [글] ${JSON.stringify(b.text.slice(0, 50))}`);
    else if (b.type === "oglink") console.log(`  ${i + 1}. [링크카드] ${b.url}`);
    else console.log(`  ${i + 1}. [이미지] ${b.image.path}`);
  });
}

main().catch((e) => {
  console.error("test-assets 실패:", e);
  process.exit(1);
});
