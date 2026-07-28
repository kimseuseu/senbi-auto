import "dotenv/config";
import { learnBlog } from "../core/templates";
import { ensureAppDirs } from "../config/paths";

async function main() {
  ensureAppDirs();
  const t = await learnBlog(process.argv[2] ?? "khj-1104", process.argv[3] ?? "MBC렌탈", Number(process.argv[4] ?? 8));
  console.log(`\n템플릿: "${t.name}" @${t.blogId}`);
  console.log(`글 ${t.postCount} · 이미지(로컬저장) ${t.imageCount}`);
  console.log(`키워드 ${t.keywords.length}개:`);
  t.keywords.forEach((k) => console.log(`  · ${k}`));
}
main().catch((e) => {
  console.error("실패:", e);
  process.exit(1);
});
