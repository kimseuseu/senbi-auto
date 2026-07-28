import "dotenv/config";
import { getAccount, resolveAccountSettings } from "../core/accounts";
import { runPostJob } from "../run/postJob";
import { ensureAppDirs } from "../config/paths";

/**
 * 일회성 검증: 발행 버튼 타임아웃 수정 확인용.
 * acc-ojs5404 계정으로 글 1편을 **비공개(private)**로 실제 발행 시도.
 *   npx tsx src/scripts/test-publish-one.ts
 */
async function main() {
  ensureAppDirs();
  const acc = getAccount("acc-ojs5404");
  if (!acc) {
    console.error("계정 acc-ojs5404 없음");
    process.exit(1);
  }
  const settings = resolveAccountSettings(acc);
  settings.postVisibility = "private"; // 안전: 비공개
  settings.autoPublish = true;
  settings.postsPerRun = 1;

  console.log(`테스트 발행 시작 — 계정 ${acc.name}(${acc.blogId}), 비공개, headless`);
  const r = await runPostJob({ headless: true, settings, accountId: acc.id });
  console.log("결과:", JSON.stringify(r, null, 2));
  process.exit(r.ok && r.published ? 0 : 1);
}

main().catch((e) => {
  console.error("테스트 실패:", e);
  process.exit(1);
});
