import "dotenv/config";
import { crawlBlog } from "../crawl/crawler";
import { keywordHasSource, rankPostsByKeyword } from "../run/assets";
import { getSettings } from "../config/settings";
import { ensureAppDirs } from "../config/paths";

// 각 주제 키워드가 학습 블로그에 연관 글이 있는지 점검
async function main() {
  ensureAppDirs();
  const s = getSettings();
  const learn = s.learnBlogId || "khj-1104";
  const posts = await crawlBlog(learn, { count: s.crawlCount });
  console.log(`\n학습 블로그 ${learn} 최근 ${posts.length}글 기준:\n`);
  for (const kw of s.topicKeywords) {
    const has = keywordHasSource(posts, kw);
    const top = rankPostsByKeyword(posts, kw)[0];
    console.log(
      `${has ? "✅" : "⚠️"} "${kw}" → ${has ? "연관글: " + top!.title : "연관글 없음 (썸네일·크롤이미지 생략)"}`,
    );
  }
}

main().catch((e) => {
  console.error("check-keywords 실패:", e);
  process.exit(1);
});
