import "dotenv/config";
import { crawlBlog } from "../crawl/crawler";

// 사용법: npm run crawl -- <blogId 또는 URL> [글수]
async function main() {
  const arg = process.argv[2];
  const count = Number(process.argv[3] ?? 5);
  if (!arg) {
    console.error("사용법: npm run crawl -- <blogId 또는 blog.naver.com/URL> [글수]");
    process.exit(1);
  }

  const posts = await crawlBlog(arg, { count });
  console.log(`\n===== 크롤 결과: ${posts.length}건 =====\n`);
  for (const p of posts) {
    console.log(`● ${p.title}`);
    console.log(`  URL: ${p.url}`);
    console.log(`  본문 ${p.charCount}자 / 이미지 ${p.images.length}장`);
    console.log(`  발췌: ${p.text.slice(0, 90).replace(/\n/g, " ")}...`);
    if (p.images[0]) console.log(`  이미지예: ${p.images[0]}`);
    console.log("");
  }
}

main().catch((e) => {
  console.error("크롤 실패:", e);
  process.exit(1);
});
