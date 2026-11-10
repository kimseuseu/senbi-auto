import "dotenv/config";
import { crawlBlog } from "../crawl/crawler";
import { getSettings } from "../config/settings";
import { getTemplate } from "../core/templates";
import { ensureAppDirs } from "../config/paths";
import { usedKeywords } from "../core/activity";
import { keywordHasSource } from "../run/assets";
import {
  assertKeywordAllowed,
  collectKeywordPool,
  filterFreshKeywords,
} from "../generate/keywordPool";
import { overlapsExisting } from "../generate/keywords";

// 키워드 두 규칙이 실제로 작동하는지 점검한다.
//  ① 학습 블로그에서 수집한 키워드만 사용
//  ② 최근 쓴 키워드와 겹치면 사용 불가
// 사용법: npx tsx src/scripts/verify-keyword-rules.ts [학습블로그ID]

let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
}

async function main() {
  ensureAppDirs();
  const s = getSettings();
  const argBlog = process.argv[2]?.trim();
  const tpl = !argBlog && s.activeTemplateId ? getTemplate(s.activeTemplateId) : null;

  let posts;
  let learnFrom: string;
  if (tpl) {
    posts = tpl.posts;
    learnFrom = tpl.blogId ?? "(템플릿)";
    console.log(`학습 소스: 템플릿 "${tpl.name}" (글 ${posts.length})\n`);
  } else {
    learnFrom = argBlog || s.learnBlogId?.trim() || s.blogId;
    if (!learnFrom) throw new Error("학습 블로그 ID가 없습니다. 인자로 넘겨 주세요.");
    posts = await crawlBlog(learnFrom, { count: s.crawlCount || 20 });
    console.log(`학습 소스: ${learnFrom} 크롤 ${posts.length}건\n`);
  }

  // ---------- 수집 ----------
  const pool = collectKeywordPool(posts, { brandName: s.brandName });
  console.log(`[수집된 키워드 ${pool.length}개]`);
  for (const p of pool.slice(0, 20)) {
    console.log(`  · ${p.keyword}   ← "${p.sourceTitle.slice(0, 40)}"`);
  }
  check("학습 블로그에서 키워드를 수집했다", pool.length > 0, `${pool.length}개`);

  // ---------- 겹침 필터 ----------
  const reuseDays = Math.max(0, s.keywordReuseDays ?? 10);
  const used = usedKeywords(reuseDays);
  console.log(
    `\n[최근 ${reuseDays || "∞"}일 안에 쓴 키워드 ${used.length}개] ${used.slice(-8).join(" · ") || "(없음)"}`,
  );
  const { fresh, blocked } = filterFreshKeywords(pool, used, []);
  console.log(`사용 가능 ${fresh.length}개 / 겹쳐서 제외 ${blocked.length}개`);
  for (const b of blocked.slice(0, 8)) console.log(`  × ${b.keyword} (${b.reason})`);

  // ---------- 규칙 검증 ----------
  console.log("\n[규칙 검증]");
  const pick = fresh[0];
  check("겹치지 않는 키워드가 남아 있다", Boolean(pick), pick ? `"${pick.keyword}"` : "0개");
  if (!pick) return;

  // ① 수집하지 않은 키워드는 거부되어야 한다
  const invented = "인공지능 로봇 청소기 렌탈";
  const r1 = assertKeywordAllowed(invented, pool, used, []);
  check(
    "① 수집 안 된 키워드는 거부된다",
    !r1.ok,
    r1.ok ? "통과되어 버림(문제)" : r1.error,
  );

  // ② 방금 쓴 키워드는 다음 회차에서 거부되어야 한다
  const asIfUsed = [...used, pick.keyword];
  const r2 = assertKeywordAllowed(pick.keyword, pool, asIfUsed, []);
  check(
    "② 방금 쓴 키워드는 다음 회차에서 거부된다",
    !r2.ok,
    r2.ok ? "통과되어 버림(문제)" : r2.error,
  );

  // ②-1 표현만 바꾼 유사 키워드도 걸러져야 한다.
  //      assertKeywordAllowed 는 규칙 ①(수집 여부)을 먼저 보므로, 어순을 바꾼 말은 거기서 먼저 걸려
  //      겹침 규칙이 실제로 작동하는지는 알 수 없다 → 겹침 판정만 따로 검사한다.
  const words = pick.keyword.split(/\s+/);
  if (words.length >= 2) {
    const rephrased = [...words].reverse().join(" ");
    check(
      "②-1 어순만 바꾼 유사 키워드도 겹침으로 판정된다",
      overlapsExisting(rephrased, [pick.keyword]),
      `"${rephrased}" ↔ "${pick.keyword}"`,
    );
  }

  // ②-2 거래어만 바꾼 키워드(렌탈 ↔ 대여)도 같은 소재로 걸러져야 한다
  check(
    "②-2 거래어만 바꾼 키워드도 겹침으로 판정된다",
    overlapsExisting("돈풍기 임대", ["돈풍기 대여"]) &&
      !overlapsExisting("업소용 냉동고 렌탈", ["업소용 냉장고 렌탈"]),
    "돈풍기 임대 ↔ 돈풍기 대여 (겹침) · 업소용 냉동고 ↔ 업소용 냉장고 (다른 소재)",
  );

  // ②-3 재사용 금지 기간이 지난 키워드는 다시 쓸 수 있어야 한다 (후보 고갈 방지)
  const everUsed = usedKeywords(0);
  check(
    "②-3 기간이 지난 키워드는 막는 목록에서 빠진다",
    usedKeywords(1).length <= used.length && used.length <= everUsed.length,
    `1일 ${usedKeywords(1).length}개 ≤ ${reuseDays}일 ${used.length}개 ≤ 전체 ${everUsed.length}개`,
  );

  // ③ 정상 키워드는 통과해야 한다
  const r4 = assertKeywordAllowed(pick.keyword, pool, used, []);
  check("③ 수집됐고 안 겹치는 키워드는 통과한다", r4.ok, `"${pick.keyword}"`);

  // ④ 다음 회차 시뮬레이션 — 쓴 키워드를 빼고 다시 고르면 다른 키워드가 나온다
  const next = filterFreshKeywords(pool, asIfUsed, []).fresh[0];
  check(
    "④ 다음 회차엔 다른 키워드가 선택된다",
    Boolean(next) && next!.keyword !== pick.keyword,
    next ? `"${pick.keyword}" → "${next.keyword}"` : "남은 키워드 없음",
  );

  // ⑤ 실제 발행 경로와 동일하게, 이미지 출처까지 있는 키워드가 있는지
  const withImage = fresh.find((f) => keywordHasSource(posts, f.keyword));
  check(
    "⑤ 사진 출처까지 있는 키워드가 있다",
    Boolean(withImage),
    withImage ? `"${withImage.keyword}"` : "없음 — 학습 글을 더 늘려야 함",
  );

  console.log(`\n${failed === 0 ? "전부 통과" : `실패 ${failed}건`}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("검증 실패:", e);
  process.exit(1);
});
