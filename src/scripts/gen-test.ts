import "dotenv/config";
import { crawlBlog, toReferences } from "../crawl/crawler";
import { generateFromReferences } from "../generate";
import { getSettings, resolveApiKey } from "../config/settings";
import { ensureAppDirs } from "../config/paths";

// 사용법: npm run gen -- <blogId> <메인키워드> [크롤수]
async function main() {
  ensureAppDirs();
  const blogId = process.argv[2];
  const keyword = process.argv[3];
  const count = Number(process.argv[4] ?? 12);

  if (!blogId || !keyword) {
    console.error("사용법: npm run gen -- <blogId> <메인키워드> [크롤수]");
    process.exit(1);
  }

  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY가 없습니다. .env 또는 대시보드 설정에 넣어 주세요.");
    process.exit(1);
  }

  const settings = getSettings();
  // 스크립트 테스트용 최소 오버라이드
  settings.topicKeywords = [keyword, ...settings.topicKeywords];

  console.log(`\n[1/2] "${blogId}" 최근 글 ${count}건 크롤링 중...`);
  const posts = await crawlBlog(blogId, { count });
  const refs = toReferences(posts);
  console.log(`  참고글 ${refs.length}건 확보 (평균 ${Math.round(refs.reduce((n, r) => n + r.content.length, 0) / (refs.length || 1))}자)`);

  console.log(`\n[2/2] "${keyword}" 키워드로 글 생성 중... (Claude ${settings.model})`);
  const result = await generateFromReferences(settings, refs, keyword, apiKey);

  console.log("\n===== 생성 결과 =====");
  console.log(`제목: ${result.title}`);
  console.log(`분량: 공백제외 ${result.charCount}자`);
  console.log(`센비 스코어: ${result.score?.total} / GEO 지수: ${result.geoScore?.total}`);
  if (result.replacedWords.length) {
    console.log(`대체된 표현: ${result.replacedWords.map((w) => `${w.word}→${w.replacement}`).join(", ")}`);
  }
  console.log("\n----- 본문 -----\n");
  console.log(result.content);
}

main().catch((e) => {
  console.error("생성 실패:", e);
  process.exit(1);
});
