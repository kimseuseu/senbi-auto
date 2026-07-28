import { getSettings, resolveApiKey, type Settings } from "../config/settings";
import { crawlBlog, toReferences } from "../crawl/crawler";
import { generateFromReferences, keywordTags } from "../generate";
import { analyzeHeadingStyle, analyzeTextStyle, buildStructuredBody } from "../generate/structure";
import { recentTitles, overlapsExisting } from "../generate/keywords";
import {
  assertKeywordAllowed,
  collectKeywordPool,
  filterFreshKeywords,
} from "../generate/keywordPool";
import { buildPostAssets, keywordHasSource } from "./assets";
import { getTemplate } from "../core/templates";
import { addDraft, markPublished, type GeneratedDraft } from "../core/drafts";
import { logPublished, usedKeywords } from "../core/activity";
import { launchContext, isLoggedIn, closeContext } from "../naver/session";
import { publishPost } from "../naver/publish";
import { markSessionInvalid, markSessionValid } from "../naver/sessionState";
import { createLogger } from "../core/logger";

const log = createLogger("postJob");

export interface PostJobResult {
  ok: boolean;
  draft?: GeneratedDraft;
  published?: boolean;
  url?: string;
  error?: string;
}

/**
 * 글 1편 파이프라인: 크롤 학습 → 키워드 선택 → 생성 → 이미지 준비 →
 * (autoPublish면) 네이버 발행, 아니면 로컬 초안 저장.
 * headless=false 로 강제하고 싶을 때 opts.headless 전달.
 */
export async function runPostJob(
  opts: { headless?: boolean; settings?: Settings; accountId?: string } = {},
): Promise<PostJobResult> {
  const settings = opts.settings ?? getSettings();
  const apiKey = resolveApiKey(settings);

  if (!apiKey) return { ok: false, error: "ANTHROPIC_API_KEY가 없습니다." };
  if (!settings.blogId) return { ok: false, error: "발행 대상 blogId가 설정되지 않았습니다." };
  // 키워드는 학습 블로그에서 수집하므로 등록 목록이 비어 있어도 된다.
  // (등록 목록은 수동 모드에서 '우선순위'로만 쓰인다)

  try {
    // 1) 학습 데이터 확보 — 템플릿(미리 학습) 우선, 없으면 즉석 크롤
    const tpl = settings.activeTemplateId
      ? getTemplate(settings.activeTemplateId)
      : null;
    let posts: Awaited<ReturnType<typeof crawlBlog>>;
    let instructions = "";
    let learnFrom = settings.learnBlogId?.trim() || settings.blogId;
    if (tpl) {
      log.info(`템플릿 "${tpl.name}" 사용 (글 ${tpl.postCount}) → 발행 ${settings.blogId}`);
      posts = tpl.posts;
      instructions = tpl.instructions;
      if (tpl.blogId) learnFrom = tpl.blogId;
    } else {
      log.info(`크롤 학습: ${learnFrom} → 발행 ${settings.blogId} (${settings.crawlCount}건)`);
      posts = await crawlBlog(learnFrom, { count: settings.crawlCount });
    }
    if (posts.length === 0) return { ok: false, error: "참고글이 없습니다." };
    const refs = toReferences(posts);

    // 2) 키워드 선택
    //    규칙 ①: 학습 블로그에서 수집한 키워드만 쓴다 (AI가 새로 지어내지 않는다)
    //    규칙 ②: 최근 쓴 키워드와 겹치면 안 된다
    //    둘 다 아래 filterFreshKeywords + assertKeywordAllowed 로 코드에서 강제한다.
    // 템플릿의 keywords = 학습 때 수집해 대시보드에 보여주는 그 목록 → 최우선 후보
    const pool = collectKeywordPool(posts, {
      brandName: settings.brandName,
      seeds: tpl?.keywords ?? [],
    });
    if (pool.length === 0) {
      return {
        ok: false,
        error: `학습 블로그(${learnFrom})에서 키워드를 수집하지 못했습니다. 학습할 글이 더 필요합니다.`,
      };
    }

    const used = usedKeywords();
    // 학습 블로그 = 발행 블로그면 수집 키워드가 곧 자기 글 제목이라 제목 차단을 걸 수 없다.
    // (걸면 모든 후보가 막힌다) 이 경우엔 '최근 쓴 키워드' 규칙만 적용한다.
    const selfLearning = learnFrom === settings.blogId;
    const publishedTitles = selfLearning ? [] : await recentTitles(settings.blogId, 20);
    if (selfLearning) {
      log.info("학습·발행 블로그가 같음 — 최근 쓴 키워드 기준으로만 겹침을 거른다");
    } else {
      log.info(`발행 블로그 최근 글 ${publishedTitles.length}건 확인 — 겹치지 않는 새 주제 찾는 중`);
    }

    const { fresh, blocked } = filterFreshKeywords(pool, used, publishedTitles);
    log.info(
      `수집 키워드 ${pool.length}개 중 겹침 ${blocked.length}개 제외 → 사용 가능 ${fresh.length}개`,
    );
    if (blocked.length > 0) {
      log.info(`제외됨: ${blocked.slice(0, 5).map((b) => `"${b.keyword}"(${b.reason})`).join(" · ")}`);
    }
    if (fresh.length === 0) {
      return {
        ok: false,
        error: `쓸 수 있는 새 키워드가 없습니다. 수집 키워드 ${pool.length}개가 모두 최근에 쓴 주제와 겹칩니다. 학습 블로그를 다시 학습(새 글 반영)하거나 학습 글 수를 늘려 주세요.`,
      };
    }

    // 수동 키워드 목록은 '출처'가 아니라 '우선순위'로만 쓴다.
    // (등록 키워드와 소재가 맞는 수집 키워드를 앞으로 당긴다 — 규칙 ①은 그대로 지킨다)
    let ordered = fresh;
    if (!settings.autoKeyword && settings.topicKeywords.length > 0) {
      const wanted = settings.topicKeywords.filter((k) => k.trim());
      const hit = fresh.filter((f) => overlapsExisting(f.keyword, wanted));
      ordered = [...hit, ...fresh.filter((f) => !hit.includes(f))];
      log.info(
        hit.length > 0
          ? `등록 키워드와 맞는 수집 키워드 ${hit.length}개를 우선 사용`
          : "등록 키워드와 맞는 수집 키워드가 없어 수집 순서대로 사용",
      );
    }

    // ⚠️ 학습 블로그에 해당 소재의 이미지가 없으면 글만 있고 사진이 없는 글이 된다 → 그 키워드는 건너뛴다
    let keyword: string | null = null;
    const skipped: string[] = [];
    for (const cand of ordered) {
      if (keywordHasSource(posts, cand.keyword)) {
        keyword = cand.keyword;
        break;
      }
      skipped.push(cand.keyword);
    }
    if (skipped.length > 0) {
      log.info(`이미지 없는 키워드 ${skipped.length}개 건너뜀: ${skipped.slice(0, 5).join(" · ")}`);
    }
    if (!keyword) {
      return {
        ok: false,
        error: `이미지가 있는 키워드를 찾지 못했습니다(후보 ${fresh.length}개 모두 학습 블로그에 해당 사진 없음). 학습 블로그를 추가 학습해 주세요.`,
      };
    }

    // 최종 안전장치 — 어떤 경로로 정해졌든 두 규칙을 다시 검사하고, 어기면 발행하지 않는다
    const gate = assertKeywordAllowed(keyword, pool, used, publishedTitles);
    if (!gate.ok) {
      log.error(`키워드 최종 검사 실패 — 발행 중단: ${gate.error}`);
      return { ok: false, error: gate.error };
    }
    log.info(`주제 선정: "${keyword}" (학습 블로그 수집 키워드 · 최근 주제와 안 겹침 · 해당 사진 있음)`);

    // 3) 생성 (템플릿 지침 반영)
    const result = await generateFromReferences(settings, refs, keyword, apiKey, instructions);

    // 4) 이미지·썸네일·서명 준비 (키워드에 맞는 원본 글의 이미지만)
    const pa = await buildPostAssets(posts, keyword, settings, apiKey);

    // 4-1) 학습 블로그의 소제목/인용구 스타일을 판별해 본문을 구조화
    let styleProfile = analyzeHeadingStyle(posts);
    let textStyle = analyzeTextStyle(posts);
    // 구버전 크롤러로 학습된 템플릿엔 서식 정보가 없다 → 최근 글 몇 개로 스타일만 재분석
    if (!styleProfile.usesStructure && tpl?.blogId) {
      try {
        const fresh = await crawlBlog(tpl.blogId, { count: 5 });
        const p2 = analyzeHeadingStyle(fresh);
        if (p2.usesStructure) {
          styleProfile = p2;
          textStyle = analyzeTextStyle(fresh);
          log.info(`템플릿에 서식 정보가 없어 ${tpl.blogId} 최근 글로 재분석`);
        }
      } catch (err) {
        log.warn("서식 스타일 재분석 실패(무시)", err);
      }
    }
    // 실제 쓸 강조 서식은 '선택된 종류'(소제목 vs 인용구) 기준으로 고른다
    const useQuote = styleProfile.style === "quote";
    const publishStyle = {
      bodyFont: textStyle.bodyFont,
      bodySize: textStyle.bodySize,
      headingBold: useQuote ? textStyle.quoteBold : textStyle.headingBold,
      headingItalic: useQuote ? textStyle.quoteItalic : textStyle.headingItalic,
      headingSize: useQuote ? textStyle.quoteSize : textStyle.headingSize,
    };
    log.info(
      `글자 서식 학습: 서체 ${publishStyle.bodyFont ?? "기본"} · 본문 ${publishStyle.bodySize ?? "fs19"} · ${useQuote ? "인용구" : "소제목"} ${publishStyle.headingSize ?? "기본"}${publishStyle.headingBold ? " 굵게" : ""}${publishStyle.headingItalic ? " 기울임" : ""}`,
    );
    const structuredBody = buildStructuredBody(result.content, result.headings ?? [], styleProfile);
    const headingBlocks = structuredBody.filter((b) => b.kind !== "text").length;
    if (headingBlocks > 0) {
      log.info(
        `구조 판별: 섹션 제목 ${headingBlocks}개 → ${styleProfile.style === "quote" ? `인용구(${styleProfile.quoteStyle})` : "소제목"} 스타일`,
      );
    } else if (!styleProfile.usesStructure) {
      log.info("구조 판별: 학습 블로그가 소제목/인용구를 쓰지 않음 → 일반 본문");
    }

    const draft = addDraft(result, pa.bodyImages.map((a) => a.path));

    // 5) 발행 여부
    if (!settings.autoPublish) {
      log.info(`자동발행 꺼짐 — 로컬 초안 저장: "${result.title}"`);
      return { ok: true, draft, published: false };
    }

    // 발행: 로그인 세션 필요 (계정별 세션)
    const context = await launchContext({ headless: opts.headless ?? true, accountId: opts.accountId });
    try {
      if (!(await isLoggedIn(context))) {
        markSessionInvalid(opts.accountId, "로그인 쿠키 없음");
        return {
          ok: true,
          draft,
          published: false,
          error: "네이버 로그인 세션이 없어 발행하지 못했습니다. 상세 설정에서 이 계정으로 로그인하세요.",
        };
      }
      const pub = await publishPost(context, {
        blogId: settings.blogId,
        post: result,
        structuredBody,
        textStyle: publishStyle,
        introStyle: { color: textStyle.introColor, bold: textStyle.introBold },
        images: pa.bodyImages,
        thumbnail: pa.thumbnail,
        signature: pa.signature,
        tags: keywordTags(keyword), // 이 글 키워드 기반 태그 (다른 주제 안 섞음)
        visibility: settings.postVisibility,
      });
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
        markSessionValid(opts.accountId); // 발행 성공 = 세션 정상
        log.info(`✅ 발행 완료: "${result.title}" → ${pub.url}`);
        return { ok: true, draft, published: true, url: pub.url };
      }
      if (pub.sessionExpired) markSessionInvalid(opts.accountId, pub.error ?? "세션 만료");
      log.warn(`발행 실패 — 초안만 저장됨: ${pub.error ?? "알 수 없는 이유"}`);
      return { ok: true, draft, published: false, error: pub.error };
    } finally {
      await closeContext(context);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("포스트 잡 실패", err);
    return { ok: false, error: msg };
  }
}
