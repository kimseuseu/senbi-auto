import "dotenv/config";
import { crawlBlog, toReferences } from "../crawl/crawler";
import { generateFromReferences, pickNextKeyword } from "../generate";
import { buildPostAssets } from "../run/assets";
import { addDraft, markPublished } from "../core/drafts";
import { logPublished, usedKeywords } from "../core/activity";
import { launchContext, isLoggedIn, closeContext } from "../naver/session";
import { publishPost } from "../naver/publish";
import { getSettings, saveSettings, resolveApiKey } from "../config/settings";
import { ensureAppDirs } from "../config/paths";

// 전체 흐름 데모: 학습블로그 크롤 → 생성 → 이미지 → 발행블로그에 비공개 발행
async function main() {
  ensureAppDirs();
  const learnBlogId = process.argv[2] ?? "khj-1104";
  const publishBlogId = process.argv[3] ?? "ojs5404";

  saveSettings({ learnBlogId, blogId: publishBlogId });
  const settings = getSettings();
  const apiKey = resolveApiKey(settings);
  if (!apiKey) return console.log("API 키 없음");
  if (settings.topicKeywords.length === 0)
    return console.log("주제 키워드 없음 — 대시보드에서 입력 필요");

  console.log(`[1/4] 학습 크롤: ${learnBlogId} (${settings.crawlCount}건)`);
  const posts = await crawlBlog(learnBlogId, { count: settings.crawlCount });
  if (!posts.length) return console.log("크롤 실패 (공개 블로그인지 확인)");
  const refs = toReferences(posts);
  const allImages = posts.flatMap((p) => p.images);
  console.log(`  참고글 ${refs.length}건 · 이미지 ${allImages.length}장`);

  const keyword =
    process.argv[4] || pickNextKeyword(settings.topicKeywords, usedKeywords())!;
  console.log(`[2/4] 글 생성: "${keyword}" (Claude ${settings.model})`);
  const result = await generateFromReferences(settings, refs, keyword, apiKey);
  console.log(
    `  "${result.title}" — ${result.charCount}자 · 센비 ${result.score?.total} · GEO ${result.geoScore?.total}`,
  );

  console.log(`[3/4] 이미지·썸네일·서명 준비 (키워드 매칭)`);
  const pa = await buildPostAssets(posts, keyword, settings, apiKey);
  console.log(
    `  본문 ${pa.bodyImages.length}장 · 썸네일 ${pa.thumbnail ? "O" : "X"} · 서명 ${pa.signature.length}블록`,
  );
  const draft = addDraft(
    result,
    pa.bodyImages.map((a) => a.path),
  );

  console.log(`[4/4] 발행(비공개) → ${publishBlogId}`);
  const context = await launchContext({ headless: true });
  try {
    if (!(await isLoggedIn(context))) return console.log("미로그인");
    const pub = await publishPost(context, {
      blogId: publishBlogId,
      post: result,
      images: pa.bodyImages,
      thumbnail: pa.thumbnail,
      signature: pa.signature,
      tags: [keyword.replace(/\s+/g, ""), ...keyword.split(/\s+/)].slice(0, 5),
      visibility: "private",
      debugScreenshot: "/tmp/senbi-flow.png",
    });
    console.log("발행 결과:", JSON.stringify(pub));
    if (pub.ok && pub.mode === "published") {
      markPublished(draft.id, pub.url);
      logPublished({
        title: result.title,
        url: pub.url,
        mainKeyword: keyword,
        publishedAt: new Date().toISOString(),
        imageCount:
          pa.bodyImages.length +
          (pa.thumbnail ? 1 : 0) +
          pa.signature.filter((b) => b.type === "image").length,
      });
    }
    console.log("\n----- 생성 본문 미리보기 -----\n");
    console.log(result.content.slice(0, 500) + "...");
  } finally {
    await closeContext(context);
  }
}

main().catch((e) => {
  console.error("test-flow 실패:", e);
  process.exit(1);
});
