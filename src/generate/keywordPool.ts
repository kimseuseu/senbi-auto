import type { CrawledPost } from "../core/types";
import { overlapsExisting, actionSuffix, ACTION_WORDS } from "./keywords";
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

/** 구절이 끊기는 자리 — 이 기호를 넘어서는 한 덩어리로 묶지 않는다 */
const BOUNDARY = /[!?,:;|｜"“”…「」『』【】《》〈〉]|\.{2,}|\s[-–—]\s/g;
/** 괄호 묶음 — 부연 설명이라 키워드에서 뺀다 (그 자리는 경계로 남긴다) */
const BRACKET = /[[(（{<][^\])）}>]*[\])）}>]/g;
/** 뜻 없는 장식 기호 — 앞뒤 말을 이어 주는 기호(·&/)도 여기서 공백으로 바꾼다 */
const DECOR = /['‘’~★☆♡♥•·_+=@#$%^&*/]/g;
/** 경계 자리 표시 (제목에 나올 수 없는 글자) */
const MARK = "\u0001";

/** 주제어가 될 수 없는 군더더기 어절 (수식·마케팅·시점 표현) */
const FILLER = new Set([
  "후기", "리뷰", "추천", "정리", "총정리", "안내", "소개", "이야기", "일상",
  "방법", "이유", "팁", "노하우", "가이드", "체험", "사용기", "solution",
  "문의", "상담", "예약", "전화", "연락", "카톡", "네이버", "블로그", "포스팅",
  "오늘", "어제", "요즘", "최근", "이번", "지난", "올해", "작년", "내년",
  "진행", "완료", "시작", "다녀왔어요", "다녀온", "했어요", "합니다", "입니다",
  "그리고", "하지만", "정말", "너무", "완전", "매우", "아주", "함께", "같이",
  "ft", "feat", "vs", "한정", "특가", "상태",
]);

/** 숫자·단위만 있는 어절(3월, 2025, 1탄, 15RT …)은 주제어가 아니다 */
function isNumericish(w: string): boolean {
  return /^[0-9]+[가-힣a-z]{0,2}$/i.test(w);
}

function isFiller(w: string): boolean {
  const bare = w.replace(/[의은는이가을를에서와과도로만]$/u, "");
  return (
    FILLER.has(w.toLowerCase()) || FILLER.has(bare) || isNumericish(w) || bare.length < 2
  );
}

/**
 * 문장 조각임을 알려 주는 어절인지.
 *
 * 제목이 "단 한달 사용에 구매하시겠어요?" 같은 문장형이면 앞 어절을 잘라 봐야
 * "한달 사용에" 같은 말이 안 되는 키워드만 나온다. 이런 어절이 끼어 있으면
 * 그 구간은 키워드로 쓰지 않는다.
 */
function isClauseWord(w: string): boolean {
  // 격조사가 붙은 말 (사용에 · 분위기를 · 현장에서) — 어간이 2자 이상일 때만 (가을·마을 같은 명사 보호)
  if (/^[가-힣a-zA-Z0-9]{2,}(에서|에|을|를)$/.test(w)) return true;
  // 관형형·주제 조사 (바꾸는 · 있는 · 렌탈은 아님: '는'만 본다)
  if (/는$/.test(w)) return true;
  // 서술형 어미
  return /(세요|까요|어요|아요|에요|예요|네요|해요|나요|인가요|니다|다면|으면|하면|려면|된다|한다)$/.test(w);
}

const ACTION_PARTICLE = /^(으로|로|은|이|도|과|와|의|부터|까지|만)$/;

/** 거래어에 조사가 붙은 말이면 거래어까지만 남긴다 ("렌탈로" → "렌탈", "렌탈부터" → "렌탈") */
function trimActionParticle(w: string): string {
  for (const a of ACTION_WORDS) {
    const at = w.lastIndexOf(a);
    if (at >= 0 && ACTION_PARTICLE.test(w.slice(at + a.length))) return w.slice(0, at + a.length);
  }
  return w;
}

interface Token {
  word: string;
  /** 구절이 끊기는 자리 (문장부호·괄호) */
  boundary: boolean;
  /** 주제어가 될 수 없는 어절 (군더더기·숫자·너무 짧음) — 건너뛴다 */
  filler: boolean;
  /** 문장 조각임을 알려 주는 어절 — 여기서 구절이 끊긴다 */
  clause: boolean;
}

/** 제목 → 어절 목록 (원래 순서 그대로, 끊기는 자리 포함) */
function tokenize(title: string, brands: string[]): Token[] {
  let t = title.replace(BRACKET, ` ${MARK} `).replace(BOUNDARY, ` ${MARK} `).replace(DECOR, " ");
  // 상호명은 키워드에 넣지 않는다 (검색 주제가 아니라 브랜드가 되어버림)
  for (const b of brands) t = t.split(b).join(" ");

  const out: Token[] = [];
  for (const raw of t.split(/\s+/)) {
    if (raw === MARK) {
      out.push({ word: "", boundary: true, filler: false, clause: false });
      continue;
    }
    // 이모지·기호 제거 후 한글/영문/숫자만
    const word = trimActionParticle(raw.replace(/[^가-힣a-zA-Z0-9]/g, ""));
    if (!word) continue;
    out.push({ word, boundary: false, filler: isFiller(word), clause: isClauseWord(word) });
  }
  return out;
}

/**
 * 괄호 안에 되풀이해서 적는 말 = 그 블로그의 상호.
 * ("… 가이드 (feat. 현대더도크)" 처럼 글마다 붙이는 서명이 계정 이름과 표기가 다를 수 있다)
 */
function bracketBrands(titles: string[]): string[] {
  const seen = new Map<string, number>();
  for (const title of titles) {
    const inTitle = new Set<string>();
    for (const seg of title.match(BRACKET) ?? []) {
      for (const raw of seg.replace(DECOR, " ").split(/[\s.,]+/)) {
        const w = raw.replace(/[^가-힣a-zA-Z0-9]/g, "");
        if (w.length < 3 || isFiller(w) || actionSuffix(w) !== null) continue;
        inTitle.add(w);
      }
    }
    for (const w of inTitle) seen.set(w, (seen.get(w) ?? 0) + 1);
  }
  const need = Math.max(3, Math.ceil(titles.length * 0.15));
  return [...seen.entries()].filter(([, n]) => n >= need).map(([w]) => w);
}

interface TitleContext {
  /** 키워드에서 뺄 상호 표기들 */
  brands: string[];
  /** 이 블로그 제목 대부분에 거래어가 있는가 — 그렇다면 거래어 없는 제목은 문장형이라 쓰지 않는다 */
  actionHeavy: boolean;
}

function titleContext(titles: string[], brandName?: string): TitleContext {
  const brands = new Set(bracketBrands(titles));
  const b = brandName?.trim();
  if (b) {
    brands.add(b);
    brands.add(b.replace(/\s+/g, ""));
  }
  const withAction = titles.filter((t) => ACTION_WORDS.some((a) => t.includes(a))).length;
  return {
    // 긴 표기부터 지워야 "현대더도크"가 "현대"만 남는 식으로 깨지지 않는다
    brands: [...brands].filter(Boolean).sort((x, y) => y.length - x.length),
    actionHeavy: titles.length >= 4 && withAction >= titles.length * 0.5,
  };
}

interface Phrase {
  keyword: string;
  /** "소재 + 거래어"로 끝까지 온전한 구인지 (앞 어절을 기계적으로 자른 것이 아닌지) */
  complete: boolean;
}

/** 거래어 앞에 붙일 수 있는 소재 어절 수 (이보다 길면 거래어 바로 앞쪽만 쓴다) */
const MAX_SUBJECT_WORDS = 4;
const LONG_SUBJECT_KEEP = 3;

/**
 * 제목 하나에서 키워드 후보를 뽑는다.
 *
 * 기준은 **거래어(렌탈·대여·임대·매입…)와 그 바로 앞의 소재**다.
 *   "컨베이어 피자 오븐 렌탈 행사 현장 …"           → 컨베이어 피자 오븐 렌탈
 *   "공장 물류센터 폭염 해결! 산업용 이동식 냉풍기 렌탈" → 산업용 이동식 냉풍기 렌탈
 *   "물류 병목 현상 해결하는 자동 반자동 밴딩기 렌탈"   → 자동 반자동 밴딩기 렌탈
 * 제목 맨 앞을 기계적으로 자르면 문장형 제목에서 "물류 병목 렌탈", "부쩍 더워진 렌탈" 같은
 * 말이 안 되는 키워드가 나온다. 우리말은 꾸미는 말이 앞에 오므로, 거래어에서 거꾸로
 * 문장부호·서술어를 만날 때까지만 거슬러 올라간다.
 */
function phrasesFromTitle(title: string, ctx: TitleContext): Phrase[] {
  const tokens = tokenize(title, ctx.brands);
  const usable = (t: Token) => !t.boundary && !t.filler;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (!usable(tok)) continue;
    const action = actionSuffix(tok.word);
    if (!action) continue;
    // "에어컨 설치 불가 현장" — 거래가 아니라 상황 설명이다
    const next = tokens[i + 1];
    if (next && /^(불가|없이|금지|걱정)/.test(next.word)) continue;

    const before: string[] = [];
    for (let j = i - 1; j >= 0; j--) {
      const u = tokens[j]!;
      if (u.boundary || u.clause) break;
      if (u.filler) continue;
      before.unshift(u.word);
    }
    if (before.length === 0) {
      // 소재가 거래어에 붙어 있다("대형트리렌탈 연말 …") — 뒤따르는 말 하나까지 함께 쓴다
      if (tok.word.length <= action.length) continue;
      const after = tokens[i + 1];
      const tail = after && usable(after) && !after.clause && !actionSuffix(after.word);
      return [{ keyword: tail ? `${tok.word} ${after.word}` : tok.word, complete: true }];
    }
    const subject =
      before.length > MAX_SUBJECT_WORDS ? before.slice(-LONG_SUBJECT_KEEP) : before;
    return [{ keyword: [...subject, tok.word].join(" "), complete: true }];
  }

  // 거래어로 키워드를 잡는 블로그인데 이 제목엔 쓸 만한 거래어가 없다 = 문장형 제목
  if (ctx.actionHeavy) return [];

  // 거래어를 쓰지 않는 블로그 — 제목 앞 2어절 (사이에 끊기는 자리가 없을 때만)
  const head: string[] = [];
  for (const t of tokens) {
    if (t.boundary || t.clause) break;
    if (t.filler) continue;
    head.push(t.word);
    if (head.length === 2) return [{ keyword: head.join(" "), complete: false }];
  }
  return [];
}

function normKey(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

/**
 * 학습 블로그 글 제목에서 주제 키워드를 수집한다.
 * 제목에서 뽑기 때문에, 뽑힌 키워드는 해당 글(=이미지 출처)과 항상 연결된다.
 */
export function collectKeywordPool(
  posts: CrawledPost[],
  opts: { brandName?: string } = {},
): PoolKeyword[] {
  const ctx = titleContext(
    posts.map((p) => p.title),
    opts.brandName,
  );
  const byKey = new Map<string, PoolKeyword & { complete: boolean }>();

  for (const p of posts) {
    for (const phrase of phrasesFromTitle(p.title, ctx)) {
      const key = normKey(phrase.keyword);
      const hit = byKey.get(key);
      if (hit) {
        hit.sourceCount += 1;
      } else {
        byKey.set(key, {
          keyword: phrase.keyword,
          sourceTitle: p.title,
          sourceCount: 1,
          complete: phrase.complete,
        });
      }
    }
  }

  // 여러 글에서 반복되는 소재 우선 → 끝까지 온전한 구 우선 → 짧고 검색하기 좋은 순
  const pool = [...byKey.values()]
    .sort(
      (a, b) =>
        b.sourceCount - a.sourceCount ||
        Number(b.complete) - Number(a.complete) ||
        a.keyword.length - b.keyword.length,
    )
    .map(({ complete: _c, ...rest }) => rest);
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
