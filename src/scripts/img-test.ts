import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { crawlBlog } from "../crawl/crawler";
import { downloadImage, applyLightFilter } from "../media/images";
import { ensureAppDirs, IMAGE_CACHE_DIR } from "../config/paths";

// 사용법: npm run tsx src/scripts/img-test.ts <blogId> [출력폴더]
async function main() {
  ensureAppDirs();
  const blogId = process.argv[2] ?? "naver_diary";
  const outDir = process.argv[3] ?? IMAGE_CACHE_DIR;
  fs.mkdirSync(outDir, { recursive: true });

  const posts = await crawlBlog(blogId, { count: 3 });
  const withImg = posts.find((p) => p.images.length > 0);
  if (!withImg) {
    console.error("이미지가 있는 글을 못 찾음");
    process.exit(1);
  }

  const urls = withImg.images.slice(0, 2);
  console.log(`대상 글: ${withImg.title}`);
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]!;
    const raw = await downloadImage(url);
    const filtered = await applyLightFilter(raw, 0.2);
    const origPath = path.join(outDir, `orig_${i}.jpg`);
    const filtPath = path.join(outDir, `filtered_${i}.jpg`);
    fs.writeFileSync(origPath, raw);
    fs.writeFileSync(filtPath, filtered);
    console.log(`\n[${i}] 원본 ${(raw.length / 1024).toFixed(0)}KB → 필터 ${(filtered.length / 1024).toFixed(0)}KB`);
    console.log(`  원본:   ${origPath}`);
    console.log(`  필터후: ${filtPath}`);
  }
}

main().catch((e) => {
  console.error("이미지 테스트 실패:", e);
  process.exit(1);
});
