// 생성문이 학습 원문을 그대로 옮겨 쓰지 않았는지 검사한다.
//
// 왜 필요한가: 참고글을 학습해 쓰다 보면 문장이 거의 그대로 복제되는 일이 잦다.
// 같은 회사 블로그 두 개가 비슷한 글을 올리면 네이버가 하나를 유사문서로 처리해
// 새 블로그 쪽이 검색에서 누락된다. 발행 전에 코드로 막는다.
//
// 한글은 어절 단위 토큰화가 불안정해서(조사 변형) 글자 2-gram Dice 계수를 쓴다.

/** 문장 비교용 정규화 — 공백·문장부호 제거 */
function normalize(s: string): string {
  return s.replace(/[\s.,!?~·…"'"'()[\]{}<>「」『』]/g, "");
}

function bigrams(s: string): string[] {
  const c = normalize(s);
  if (c.length < 2) return c ? [c] : [];
  const out: string[] = [];
  for (let i = 0; i + 2 <= c.length; i++) out.push(c.slice(i, i + 2));
  return out;
}

/** 두 문장의 유사도 0~1 (글자 2-gram Dice 계수) */
export function sentenceSimilarity(a: string, b: string): number {
  const ga = bigrams(a);
  const gb = bigrams(b);
  if (ga.length === 0 || gb.length === 0) return 0;
  const bag = new Map<string, number>();
  for (const g of ga) bag.set(g, (bag.get(g) ?? 0) + 1);
  let hit = 0;
  for (const g of gb) {
    const n = bag.get(g) ?? 0;
    if (n > 0) {
      hit++;
      bag.set(g, n - 1);
    }
  }
  return (2 * hit) / (ga.length + gb.length);
}

/** 본문을 문장 단위로 쪼갠다 (너무 짧은 조각은 버림 — 인사말·감탄사 오탐 방지) */
export function splitSentences(text: string, minLen = 8): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => normalize(s).length >= minLen);
}

export interface OverlapHit {
  /** 생성문 쪽 문장 */
  sentence: string;
  /** 가장 비슷한 참고글 문장 */
  source: string;
  score: number;
}

export interface OverlapReport {
  /** 참고글과 겹치는 것으로 판정된 문장 비율 0~1 */
  ratio: number;
  /** 문장별 최고 유사도의 평균 (전반적으로 얼마나 베꼈는지) */
  meanScore: number;
  totalSentences: number;
  hits: OverlapHit[];
}

/** 문장 하나가 '겹쳤다'고 볼 기준 */
const HIT_THRESHOLD = 0.75;

/**
 * 생성 본문을 참고글 전체와 문장 단위로 대조한다.
 * ratio = (0.75 이상 비슷한 문장 수) / (전체 문장 수)
 */
export function analyzeOverlap(
  generated: string,
  referenceTexts: string[],
  hitThreshold = HIT_THRESHOLD,
): OverlapReport {
  const mine = splitSentences(generated);
  const theirs = referenceTexts.flatMap((t) => splitSentences(t));
  if (mine.length === 0 || theirs.length === 0) {
    return { ratio: 0, meanScore: 0, totalSentences: mine.length, hits: [] };
  }

  const hits: OverlapHit[] = [];
  let sum = 0;
  for (const s of mine) {
    let best = 0;
    let bestSrc = "";
    for (const t of theirs) {
      const score = sentenceSimilarity(s, t);
      if (score > best) {
        best = score;
        bestSrc = t;
      }
    }
    sum += best;
    if (best >= hitThreshold) hits.push({ sentence: s, source: bestSrc, score: best });
  }

  hits.sort((a, b) => b.score - a.score);
  return {
    ratio: hits.length / mine.length,
    meanScore: sum / mine.length,
    totalSentences: mine.length,
    hits,
  };
}

/** 참고글들에서 소제목처럼 쓰인 짧은 줄 — 생성 시 '쓰지 말 것' 목록으로 넘긴다 */
export function collectHeadingLines(referenceTexts: string[]): string[] {
  const out = new Set<string>();
  for (const t of referenceTexts) {
    for (const raw of t.split(/\n+/)) {
      const line = raw.trim();
      const len = normalize(line).length;
      // 문장부호로 안 끝나는 6~20자 짧은 줄 = 소제목으로 본다
      if (len >= 6 && len <= 20 && !/[.!?]$/.test(line)) out.add(line);
    }
  }
  return [...out];
}
