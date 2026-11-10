import type { CrawledPost } from "../core/types";
import type { Settings } from "../config/settings";
import { crawlBlogCached } from "../crawl/crawler";
import { getTemplate, type Template } from "../core/templates";
import { recentTitles, overlapsExisting } from "../generate/keywords";
import {
  collectKeywordPool,
  filterFreshKeywords,
  type PoolKeyword,
} from "../generate/keywordPool";
import { keywordHasSource } from "./assets";
import { usedKeywords, keywordUses } from "../core/activity";
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
  /** 이 블로그에 이 소재를 마지막으로 올린 게 며칠 전인지 (올린 적 없으면 null) */
  lastUsedDays: number | null;
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
  // 키워드 고르기 화면에서 방금 받은 글을 그대로 쓴다 (글마다 다시 받지 않는다)
  const posts = await crawlBlogCached(learnFrom, { count: settings.crawlCount });
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
  const pool = collectKeywordPool(src.posts, { brandName: settings.brandName });
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

  // 같은 제품을 되풀이해 홍보하는 게 목적이다 — 막는 건 '너무 짧은 간격의 반복'뿐.
  // 이 블로그에 재사용 간격 안에 올린 키워드만 막는다 (다른 블로그에 올린 것은 상관없다)
  const reuseDays = Math.max(0, settings.keywordReuseDays ?? 10);
  const used = usedKeywords(reuseDays, settings.blogId);
  // 학습 블로그 = 발행 블로그면 수집 키워드가 곧 자기 글 제목이라 제목 차단을 걸 수 없다.
  // (걸면 모든 후보가 막힌다) 이 경우엔 '최근 쓴 키워드' 규칙만 적용한다.
  const selfLearning = src.learnFrom === settings.blogId;
  const publishedTitles = selfLearning ? [] : await recentTitles(settings.blogId, 20, reuseDays);
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
      error:
        `쓸 수 있는 새 키워드가 없습니다. 수집 키워드 ${pool.length}개가 모두 ` +
        (reuseDays > 0 ? `최근 ${reuseDays}일 안에 쓴 주제` : "이미 쓴 주제") +
        `와 겹칩니다. 공통 설정의 '같은 키워드 다시 쓰기까지 간격'을 줄이거나, 학습 블로그를 다시 학습(새 글 반영)해 주세요.`,
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

  // 제품이 고르게 돌아가며 올라가게 한다: 올린 적 없는 것 먼저, 그다음 가장 오래전에 올린 것부터.
  // (순서를 고정해 두면 앞쪽 몇 개만 되풀이되고 뒤쪽 제품은 영영 차례가 오지 않는다)
  const history = keywordUses(settings.blogId);
  const lastUsedAt = (keyword: string): number =>
    history.reduce(
      (latest, u) => (u.at > latest && overlapsExisting(keyword, [u.keyword]) ? u.at : latest),
      0,
    );
  const now = Date.now();
  const timed = ordered.map((c) => ({ c, at: lastUsedAt(c.keyword) }));
  timed.sort((a, b) => a.at - b.at); // 안정 정렬 — 같은 시각끼리는 원래 순서 유지

  // ⚠️ 학습 블로그에 해당 소재의 이미지가 없으면 글만 있고 사진이 없는 글이 된다 → 자동 선정에선 건너뛴다
  const candidates: KeywordCandidate[] = timed.map(({ c, at }) => ({
    keyword: c.keyword,
    sourceTitle: c.sourceTitle,
    sourceCount: c.sourceCount,
    hasImage: keywordHasSource(src.posts, c.keyword),
    lastUsedDays: at > 0 ? Math.floor((now - at) / 86400_000) : null,
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
    c.lastUsedDays === null ? "아직 올린 적 없음" : `마지막으로 올린 지 ${c.lastUsedDays}일`,
    c.hasImage ? "이 소재 사진 있음" : "사진 없음",
  ];
  return bits.join(" · ");
}
