import type { CrawledPost } from "../core/types";
import type { Settings } from "../config/settings";
import { crawlBlog } from "../crawl/crawler";
import { getTemplate, type Template } from "../core/templates";
import { recentTitles, overlapsExisting } from "../generate/keywords";
import {
  collectKeywordPool,
  filterFreshKeywords,
  type PoolKeyword,
} from "../generate/keywordPool";
import { keywordHasSource } from "./assets";
import { usedKeywords } from "../core/activity";
import { createLogger } from "../core/logger";

const log = createLogger("keywordPlan");

/**
 * 발행에 쓸 키워드를 고르는 단계 — 발행 잡(postJob)과 대시보드의 "키워드 고르기" 화면이
 * **같은 코드**를 쓴다. 화면에 보이는 후보·추천이 실제 발행에 쓰이는 것과 어긋나지 않게 하기 위함.
 */

/** 학습 데이터 (미리 학습한 템플릿 또는 즉석 크롤) */
export interface LearnSource {
  posts: CrawledPost[];
  instructions: string;
  /** 실제로 학습한 블로그 아이디 */
  learnFrom: string;
  template: Template | null;
}

/** 고를 수 있는 키워드 하나 */
export interface KeywordCandidate {
  keyword: string;
  /** 이 키워드를 뽑아낸 학습 블로그 글 제목 (근거) */
  sourceTitle: string;
  /** 근거 글 수 — 여러 글에서 반복되는 소재일수록 높다 */
  sourceCount: number;
  /** 학습 블로그에 이 소재의 사진이 있는지 — 없으면 사진 없는 글이 된다 */
  hasImage: boolean;
}

export interface KeywordSelection {
  pool: PoolKeyword[];
  /** 이미 쓴 키워드 (겹침 판정 기준) */
  used: string[];
  /** 발행 블로그 최근 글 제목 (겹침 판정 기준) */
  publishedTitles: string[];
  /** 쓸 수 있는 후보 — 발행 우선순위 순 */
  candidates: KeywordCandidate[];
  /** 겹쳐서 제외된 키워드와 사유 */
  blocked: { keyword: string; reason: string }[];
  /** 자동 선정이면 쓰일 키워드 (사진이 있는 첫 후보) */
  recommended: string | null;
  /** 키워드를 하나도 고를 수 없을 때의 사유 — 있으면 발행하지 않는다 */
  error?: string;
}

/** 1단계: 학습 데이터 확보 — 템플릿(미리 학습) 우선, 없으면 즉석 크롤 */
export async function loadLearnSource(settings: Settings): Promise<LearnSource> {
  const tpl = settings.activeTemplateId ? getTemplate(settings.activeTemplateId) : null;
  let learnFrom = settings.learnBlogId?.trim() || settings.blogId;

  if (tpl) {
    log.info(`템플릿 "${tpl.name}" 사용 (글 ${tpl.postCount}) → 발행 ${settings.blogId}`);
    if (tpl.blogId) learnFrom = tpl.blogId;
    return { posts: tpl.posts, instructions: tpl.instructions, learnFrom, template: tpl };
  }

  log.info(`크롤 학습: ${learnFrom} → 발행 ${settings.blogId} (${settings.crawlCount}건)`);
  const posts = await crawlBlog(learnFrom, { count: settings.crawlCount });
  return { posts, instructions: "", learnFrom, template: null };
}

/**
 * 2단계: 키워드 후보 정리.
 *   규칙 ①: 학습 블로그에서 수집한 키워드만 쓴다 (AI가 새로 지어내지 않는다)
 *   규칙 ②: 최근 쓴 키워드·최근 발행 글과 겹치면 안 된다
 * 둘 다 filterFreshKeywords 로 여기서 거르고, 발행 직전 assertKeywordAllowed 로 한 번 더 검사한다.
 */
export async function selectKeywords(
  settings: Settings,
  src: LearnSource,
): Promise<KeywordSelection> {
  // 템플릿의 keywords = 학습 때 수집해 대시보드에 보여주는 그 목록 → 최우선 후보
  const pool = collectKeywordPool(src.posts, {
    brandName: settings.brandName,
    seeds: src.template?.keywords ?? [],
  });
  const base = { pool, used: [] as string[], publishedTitles: [] as string[] };
  if (pool.length === 0) {
    return {
      ...base,
      candidates: [],
      blocked: [],
      recommended: null,
      error: `학습 블로그(${src.learnFrom})에서 키워드를 수집하지 못했습니다. 학습할 글이 더 필요합니다.`,
    };
  }

  const used = usedKeywords();
  // 학습 블로그 = 발행 블로그면 수집 키워드가 곧 자기 글 제목이라 제목 차단을 걸 수 없다.
  // (걸면 모든 후보가 막힌다) 이 경우엔 '최근 쓴 키워드' 규칙만 적용한다.
  const selfLearning = src.learnFrom === settings.blogId;
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
      pool,
      used,
      publishedTitles,
      candidates: [],
      blocked,
      recommended: null,
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

  // ⚠️ 학습 블로그에 해당 소재의 이미지가 없으면 글만 있고 사진이 없는 글이 된다 → 자동 선정에선 건너뛴다
  const candidates: KeywordCandidate[] = ordered.map((c) => ({
    keyword: c.keyword,
    sourceTitle: c.sourceTitle,
    sourceCount: c.sourceCount,
    hasImage: keywordHasSource(src.posts, c.keyword),
  }));
  const skipped = candidates.filter((c) => !c.hasImage).map((c) => c.keyword);
  if (skipped.length > 0) {
    log.info(`이미지 없는 키워드 ${skipped.length}개 건너뜀: ${skipped.slice(0, 5).join(" · ")}`);
  }

  const recommended = candidates.find((c) => c.hasImage)?.keyword ?? null;
  if (!recommended) {
    return {
      pool,
      used,
      publishedTitles,
      candidates,
      blocked,
      recommended: null,
      error: `이미지가 있는 키워드를 찾지 못했습니다(후보 ${candidates.length}개 모두 학습 블로그에 해당 사진 없음). 학습 블로그를 추가 학습해 주세요.`,
    };
  }

  return { pool, used, publishedTitles, candidates, blocked, recommended };
}

/** 추천 이유 — 화면에 그대로 보여 준다 */
export function recommendReason(c: KeywordCandidate): string {
  const bits = [
    c.sourceCount > 1 ? `학습 글 ${c.sourceCount}편에서 반복된 소재` : "학습 블로그에서 수집",
    "최근 쓴 주제와 안 겹침",
    c.hasImage ? "이 소재 사진 있음" : "사진 없음",
  ];
  return bits.join(" · ");
}
