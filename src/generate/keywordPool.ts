import type { CrawledPost } from "../core/types";
import { overlapsExisting } from "./keywords";
import { createLogger } from "../core/logger";

const log = createLogger("keywordPool");

/**
 * 학습 블로그가 실제로 쓴 글에서 "수집한" 주제 키워드 풀.
 *
 * 원칙 두 가지 — 둘 다 코드에서 강제한다(AI 판단에 맡기지 않는다):
 *  1. 발행에 쓰는 키워드는 반드시 이 풀 안에 있어야 한다. (학습 블로그에서 수집한 것만)
 *  2. 최근 쓴 키워드·최근 발행 글과 겹치는 것은 제외한다.
 */
export interface PoolKeyword {
  /** 발행에 사용할 키워드 */
  keyword: string;
  /** 이 키워드를 뽑아낸 학습 블로그 글 제목 (근거) */
  sourceTitle: string;
  /** 근거 글 수 — 여러 글에서 반복되는 소재일수록 높다 */
  sourceCount: number;
}

/** 제목 앞뒤의 장식·상호·군더더기 제거용 */
const DECOR = /[「」『』【】《》〈〉"'“”‘’!?~★☆♡♥•·…:;_+=@#$%^&*]/g;
const BRACKET = /[[(（{<][^\])）}>]*[\])）}>]/g;

/** 주제어가 될 수 없는 군더더기 어절 (수식·마케팅·시점 표현) */
const FILLER = new Set([
  "후기", "리뷰", "추천", "정리", "총정리", "안내", "소개", "이야기", "일상",
  "방법", "이유", "팁", "노하우", "가이드", "체험", "사용기", "solution",
  "문의", "상담", "예약", "전화", "연락", "카톡", "네이버", "블로그", "포스팅",
  "오늘", "어제", "요즘", "최근", "이번", "지난", "올해", "작년", "내년",
  "진행", "완료", "시작", "다녀왔어요", "다녀온", "했어요", "합니다", "입니다",
  "그리고", "하지만", "정말", "너무", "완전", "매우", "아주", "함께", "같이",
]);

/** 숫자·단위만 있는 어절(3월, 2025, 1탄 …)은 주제어가 아니다 */
function isNumericish(w: string): boolean {
  return /^[0-9]+[가-힣a-z]{0,2}$/i.test(w);
}

function isFiller(w: string): boolean {
  const bare = w.replace(/[의은는이가을를에서와과도로만]$/u, "");
  return FILLER.has(w) || FILLER.has(bare) || isNumericish(w) || bare.length < 2;
}

/** 제목 → 주제어 후보 어절 배열 */
function contentWords(title: string, brandName?: string): string[] {
  let t = title.replace(BRACKET, " ").replace(DECOR, " ");
  if (brandName?.trim()) {
    // 상호명은 키워드에 넣지 않는다 (검색 주제가 아니라 브랜드가 되어버림)
    const b = brandName.trim();
    t = t.split(b).join(" ");
    t = t.split(b.replace(/\s+/g, "")).join(" ");
  }
  // 이모지·기호 제거 후 한글/영문/숫자 어절만
  return t
    .split(/\s+/)
    .map((w) => w.replace(/[^가-힣a-zA-Z0-9]/g, "").trim())
    .filter((w) => w.length >= 2 && !isFiller(w));
}

function normKey(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

/**
 * 학습 블로그 글 제목에서 2~4어절 주제 키워드를 수집한다.
 * 제목에서 뽑기 때문에, 뽑힌 키워드는 해당 글(=이미지 출처)과 항상 연결된다.
 */
export function collectKeywordPool(
  posts: CrawledPost[],
  opts: { brandName?: string; maxPerPost?: number; seeds?: string[] } = {},
): PoolKeyword[] {
  const { brandName, maxPerPost = 2, seeds = [] } = opts;
  const byKey = new Map<string, PoolKeyword>();

  // 학습(템플릿) 단계에서 이미 뽑아 둔 키워드 — 대시보드에 보이는 그 목록
  for (const raw of seeds) {
    const words = contentWords(raw, brandName);
    if (words.length < 2) continue;
    const phrase = words.slice(0, 4).join(" ");
    const key = normKey(phrase);
    if (byKey.has(key)) continue;
    const src = posts.find((p) => normKey(p.title).includes(normKey(words[0]!)));
    byKey.set(key, { keyword: phrase, sourceTitle: src?.title ?? raw, sourceCount: 2 });
  }

  for (const p of posts) {
    const words = contentWords(p.title, brandName);
    if (words.length < 2) continue;

    // 네이버 제목은 앞쪽에 핵심 소재가 온다 → 앞 2~3어절을 우선 후보로,
    // 뒤쪽 소재(부제)도 하나 챙긴다.
    const cand = [
      words.slice(0, 3).join(" "),
      words.slice(0, 2).join(" "),
      words.length >= 4 ? words.slice(-3).join(" ") : "",
      words.length >= 3 ? words.slice(-2).join(" ") : "",
    ].filter((p) => p.split(/\s+/).length >= 2);
    const phrases = [...new Set(cand)];

    for (const phrase of phrases.slice(0, maxPerPost)) {
      const key = normKey(phrase);
      const hit = byKey.get(key);
      if (hit) {
        hit.sourceCount += 1;
      } else {
        byKey.set(key, { keyword: phrase, sourceTitle: p.title, sourceCount: 1 });
      }
    }
  }

  // 여러 글에서 반복되는 소재 우선, 그다음 짧고 검색하기 좋은 순
  const pool = [...byKey.values()].sort(
    (a, b) => b.sourceCount - a.sourceCount || a.keyword.length - b.keyword.length,
  );
  log.info(`학습 블로그 글 ${posts.length}건에서 키워드 ${pool.length}개 수집`);
  return pool;
}

export interface FilterResult {
  /** 쓸 수 있는 키워드 (겹침 제외 후) */
  fresh: PoolKeyword[];
  /** 겹쳐서 제외된 키워드와 그 사유 */
  blocked: { keyword: string; reason: string }[];
}

/**
 * 풀에서 "최근 쓴 키워드·최근 발행 글"과 겹치는 것을 제거한다.
 * blockedKeywords / blockedTitles 어느 쪽과 겹쳐도 제외.
 */
export function filterFreshKeywords(
  pool: PoolKeyword[],
  blockedKeywords: string[],
  blockedTitles: string[] = [],
): FilterResult {
  const fresh: PoolKeyword[] = [];
  const blocked: { keyword: string; reason: string }[] = [];
  const taken: string[] = []; // 이번 회차에서 이미 고른 것끼리도 안 겹치게

  for (const item of pool) {
    if (overlapsExisting(item.keyword, blockedKeywords)) {
      blocked.push({ keyword: item.keyword, reason: "최근 쓴 키워드와 겹침" });
      continue;
    }
    if (blockedTitles.length > 0 && overlapsExisting(item.keyword, blockedTitles)) {
      blocked.push({ keyword: item.keyword, reason: "최근 발행 글과 겹침" });
      continue;
    }
    if (overlapsExisting(item.keyword, taken)) {
      blocked.push({ keyword: item.keyword, reason: "다른 후보와 중복" });
      continue;
    }
    taken.push(item.keyword);
    fresh.push(item);
  }
  return { fresh, blocked };
}

/**
 * 최종 안전장치 — 발행 직전에 반드시 통과해야 하는 검사.
 * 어떤 경로로 키워드가 정해졌든(자동/수동/폴백) 이 검사를 통과하지 못하면 발행하지 않는다.
 */
export function assertKeywordAllowed(
  keyword: string,
  pool: PoolKeyword[],
  blockedKeywords: string[],
  blockedTitles: string[] = [],
): { ok: true } | { ok: false; error: string } {
  const k = keyword?.trim();
  if (!k) return { ok: false, error: "키워드가 비어 있습니다." };

  const inPool = pool.some((p) => normKey(p.keyword) === normKey(k));
  if (!inPool) {
    return {
      ok: false,
      error: `키워드 "${k}" 는 학습 블로그에서 수집한 키워드가 아닙니다. 수집된 키워드만 사용할 수 있습니다.`,
    };
  }
  if (overlapsExisting(k, blockedKeywords)) {
    return { ok: false, error: `키워드 "${k}" 는 최근 쓴 키워드와 겹칩니다.` };
  }
  if (blockedTitles.length > 0 && overlapsExisting(k, blockedTitles)) {
    return { ok: false, error: `키워드 "${k}" 는 최근 발행 글과 겹칩니다.` };
  }
  return { ok: true };
}
