import { getSettings, resolveApiKey, type Settings } from "../config/settings";
import { crawlBlogCached, toReferences } from "../crawl/crawler";
import { generateFromReferences, keywordTags } from "../generate";
import {
  analyzeHeadingStyle,
  analyzeTextStyle,
  analyzeInlineColors,
  buildStructuredBody,
} from "../generate/structure";
import { assertKeywordAllowed } from "../generate/keywordPool";
import { loadLearnSource, selectKeywords } from "./keywordPlan";
import { buildPostAssets } from "./assets";
import {
  addDraft,
  markPublished,
  reserveDraftKeyword,
  type GeneratedDraft,
} from "../core/drafts";
import { logPublished } from "../core/activity";
import { markImagesUsed, sourceUrl } from "../core/usedImages";
import { launchContext, isLoggedIn, closeContext, hasSavedSession } from "../naver/session";
import { publishPost } from "../naver/publish";
import { markSessionInvalid, markSessionValid, getSessionState } from "../naver/sessionState";
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
 *
 * opts.keyword — 사용자가 화면에서 직접 고른 키워드. 주면 그걸로 쓰고, 없으면 자동 선정한다.
 * 어느 쪽이든 발행 직전 assertKeywordAllowed 를 통과해야 한다.
 */
export async function runPostJob(
  opts: {
    headless?: boolean;
    settings?: Settings;
    accountId?: string;
    keyword?: string;
  } = {},
): Promise<PostJobResult> {
  const settings = opts.settings ?? getSettings();
  const apiKey = resolveApiKey(settings);

  if (!apiKey) return { ok: false, error: "ANTHROPIC_API_KEY가 없습니다." };
  if (!settings.blogId) return { ok: false, error: "발행 대상 blogId가 설정되지 않았습니다." };
  // 발행할 수 없는 게 이미 확실하면 글부터 만들지 않는다 (만드는 데 1분 남짓 + AI 비용이 든다)
  if (settings.autoPublish) {
    const stale = opts.accountId ? getSessionState(opts.accountId).needsRelogin : false;
    if (stale || !hasSavedSession(opts.accountId)) {
      return {
        ok: false,
        error: "네이버 로그인이 필요합니다. 상세 설정 → 블로그 계정에서 이 계정으로 로그인해 주세요.",
      };
    }
  }
  // 키워드는 학습 블로그에서 수집하므로 등록 목록이 비어 있어도 된다.
  // (등록 목록은 수동 모드에서 '우선순위'로만 쓰인다)

  try {
    // 1) 학습 데이터 확보 — 템플릿(미리 학습) 우선, 없으면 즉석 크롤
    const src = await loadLearnSource(settings);
    const { posts, template: tpl, instructions } = src;
    if (posts.length === 0) return { ok: false, error: "참고글이 없습니다." };
    const refs = toReferences(posts);

    // 2) 키워드 선택 — 화면의 '키워드 고르기'와 같은 코드(keywordPlan)를 쓴다.
    //    규칙 ①: 학습 블로그에서 수집한 키워드만 쓴다 (AI가 새로 지어내지 않는다)
    //    규칙 ②: 최근 쓴 키워드와 겹치면 안 된다
    const sel = await selectKeywords(settings, src);
    // 사용자가 화면에서 고른 키워드가 있으면 그것으로, 없으면 자동 선정 결과로.
    const picked = opts.keyword?.trim();
    if (!picked && sel.error) return { ok: false, error: sel.error };
    const keyword = picked || sel.recommended;
    if (!keyword) return { ok: false, error: sel.error ?? "쓸 수 있는 키워드가 없습니다." };

    // 최종 안전장치 — 어떤 경로로 정해졌든 두 규칙을 다시 검사하고, 어기면 발행하지 않는다
    const gate = assertKeywordAllowed(keyword, sel.pool, sel.used, sel.publishedTitles);
    if (!gate.ok) {
      log.error(`키워드 최종 검사 실패 — 발행 중단: ${gate.error}`);
      return { ok: false, error: gate.error };
    }
    const hasImage = sel.candidates.find((c) => c.keyword === keyword)?.hasImage ?? false;
    log.info(
      `주제 ${picked ? "선택(사용자 지정)" : "선정"}: "${keyword}" (학습 블로그 수집 키워드 · 최근 주제와 안 겹침 · ${hasImage ? "해당 사진 있음" : "⚠️ 해당 사진 없음"})`,
    );

    // 3) 생성 (템플릿 지침 반영)
    const result = await generateFromReferences(settings, refs, keyword, apiKey, instructions);

    // 3-1) 유사문서 게이트 — 참고글을 그대로 옮겨 쓴 글은 발행하지 않는다.
    //      같은 회사 블로그끼리 비슷한 글이 올라가면 네이버가 하나를 유사문서로 처리해
    //      나중에 올린 쪽(보통 새 블로그)이 검색에서 빠진다. 초안으로만 남기고 사람이 손보게 한다.
    if (result.overlap) {
      const pct = Math.round(result.overlap.ratio * 100);
      if (result.overlapOk === false) {
        const sample = result.overlap.hits
          .slice(0, 3)
          .map((h) => `"${h.sentence.slice(0, 28)}…"`)
          .join(" · ");
        log.warn(
          `유사문서 위험 — 참고글과 겹치는 문장 ${pct}% (재작성해도 안 내려감) → 발행하지 않고 초안만 저장. 예: ${sample}`,
        );
        const draft = addDraft(result, [], settings.blogId);
        reserveDraftKeyword(draft.id); // 사람이 고쳐 올릴 글 — 다음 회차에 같은 키워드를 또 쓰지 않는다
        return {
          ok: true,
          draft,
          published: false,
          error: `참고글과 문장이 ${pct}% 겹쳐 발행을 막았습니다(유사문서 위험). 초안에서 직접 고쳐 올려 주세요.`,
        };
      }
      log.info(`독창성 검사 통과 — 참고글과 겹치는 문장 ${pct}%`);
    }

    // 4) 이미지·썸네일·서명 준비 (키워드에 맞는 원본 글의 이미지만)
    const pa = await buildPostAssets(posts, keyword, settings, apiKey);

    // 4-1) 학습 블로그의 소제목/인용구 스타일을 판별해 본문을 구조화
    let styleProfile = analyzeHeadingStyle(posts);
    let textStyle = analyzeTextStyle(posts);
    // 구버전 크롤러로 학습된 템플릿엔 서식 정보가 없다 → 최근 글 몇 개로 스타일만 재분석
    if (!styleProfile.usesStructure && tpl?.blogId) {
      try {
        const fresh = await crawlBlogCached(tpl.blogId, { count: 5 });
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
      bodyColor: textStyle.bodyColor,
      headingBold: useQuote ? textStyle.quoteBold : textStyle.headingBold,
      headingItalic: useQuote ? textStyle.quoteItalic : textStyle.headingItalic,
      headingSize: useQuote ? textStyle.quoteSize : textStyle.headingSize,
    };
    log.info(
      `글자 서식 학습: 서체 ${publishStyle.bodyFont ?? "기본"} · 본문 ${publishStyle.bodySize ?? "fs19"} · ${useQuote ? "인용구" : "소제목"} ${publishStyle.headingSize ?? "기본"}${publishStyle.headingBold ? " 굵게" : ""}${publishStyle.headingItalic ? " 기울임" : ""}`,
    );

    // 본문 안에서 상호명처럼 문구만 색이 다른 규칙 학습
    const learnedColors = analyzeInlineColors(posts, textStyle.bodyColor, textStyle.introColor);
    // 거의 모든 학습 글에 나오는 문구 = 그 블로그의 상호명.
    // 우리 상호 표기가 다르면(예: 학습 "MBC렌탈" vs 우리 "엠비씨렌탈") 우리 표기에도 같은 색을 준다.
    const brand = settings.brandName?.trim();
    const brandLike = Math.max(2, Math.ceil(posts.length * 0.7));
    const inlineColors = learnedColors.flatMap((r) => {
      const out = [{ text: r.text, style: r.style }];
      if (brand && brand !== r.text && r.posts >= brandLike) {
        out.push({ text: brand, style: r.style });
      }
      return out;
    });
    if (learnedColors.length > 0) {
      log.info(
        `문구 색 학습: ${learnedColors.map((r) => `"${r.text}" ${r.style.color}(${r.posts}편)`).join(" · ")}` +
          (inlineColors.length > learnedColors.length ? ` → 우리 상호 "${brand}"에도 적용` : ""),
      );
    }
    const structuredBody = buildStructuredBody(
      result.content,
      result.headings ?? [],
      styleProfile,
      result.title,
    );
    if (styleProfile.closingQuote?.use) {
      log.info(`마무리 인용구 추가 — 제목 반복(${styleProfile.closingQuote.style} 스타일)`);
    }
    const headingBlocks = structuredBody.filter((b) => b.kind !== "text" && !b.closing).length;
    if (headingBlocks > 0) {
      log.info(
        `구조 판별: 섹션 제목 ${headingBlocks}개 → ${styleProfile.style === "quote" ? `인용구(${styleProfile.quoteStyle})` : "소제목"} 스타일`,
      );
    } else if (!styleProfile.usesStructure) {
      log.info("구조 판별: 학습 블로그가 소제목/인용구를 쓰지 않음 → 일반 본문");
    }

    const draft = addDraft(
      result,
      pa.bodyImages.map((a) => a.path),
      settings.blogId,
    );

    // 5) 발행 여부
    if (!settings.autoPublish) {
      // 초안만 만드는 모드 — 키워드를 기록해 두지 않으면 돌릴 때마다 같은 키워드로 또 만든다
      reserveDraftKeyword(draft.id);
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
        summary: settings.aiSummary === false ? undefined : result.summary,
        structuredBody,
        textStyle: publishStyle,
        introStyle: { color: textStyle.introColor, bold: textStyle.introBold },
        inlineColors,
        images: pa.bodyImages,
        thumbnail: pa.thumbnail,
        specImage: pa.specImage,
        signature: pa.signature,
        tags: keywordTags(keyword), // 이 글 키워드 기반 태그 (다른 주제 안 섞음)
        category: settings.postCategory,
        visibility: settings.postVisibility,
      });
      if (pub.ok && pub.mode === "published") {
        markPublished(draft.id, pub.url);
        logPublished({
          title: result.title,
          url: pub.url,
          blogId: settings.blogId, // 어느 블로그에 올린 글인지 — 키워드 고르기 화면에서 블로그별로 보여 준다
          mainKeyword: keyword,
          publishedAt: new Date().toISOString(),
          imageCount:
            pa.bodyImages.length +
            (pa.thumbnail ? 1 : 0) +
            (pa.specImage ? 1 : 0) +
            pa.signature.filter((b) => b.type === "image").length,
        });
        // 이 글에 쓴 크롤 사진은 다음 글에서 피한다 (사진까지 겹치면 유사문서 판정이 강해진다)
        markImagesUsed(
          [...pa.bodyImages, ...(pa.thumbnail ? [pa.thumbnail] : []), ...(pa.specImage ? [pa.specImage] : [])]
            .map((a) => sourceUrl(a.source))
            .filter((u): u is string => Boolean(u)),
        );
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
