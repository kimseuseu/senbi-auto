import type { CrawledPost, QuoteStyle, BlockStyle } from "../core/types";

/** 학습 블로그의 글자 서식 프로필 — 소제목과 인용구는 강조가 다를 수 있어 따로 학습 */
export interface TextStyleProfile {
  bodyFont?: string; // 예: nanumbarungothic
  bodySize?: string; // 예: fs19
  bodyColor?: string; // 예: #000000
  headingBold: boolean; // 소제목
  headingItalic: boolean;
  headingSize?: string; // 예: fs24
  quoteBold: boolean; // 인용구
  quoteItalic: boolean;
  quoteSize?: string;
  /** 인사말(첫 문단)의 색·굵기 — 원문이 인사말을 강조하는 경우가 많다 */
  introColor?: string;
  introBold: boolean;
}

/**
 * 최근 글일수록 큰 가중치.
 *
 * 왜 필요한가: 블로그는 시간이 지나며 서식을 바꾼다. 20건을 똑같이 세면
 * 과거에 쓰던 서식이 최근 서식을 이겨버려, 지금 블로그와 다른 모양으로 글이 올라간다.
 * (실측: 소제목 14건 vs 인용구 6건이라 옛 소제목이 뽑혔지만 최근 글은 전부 인용구였다)
 * posts 배열은 최신순이라는 전제 — 크롤러·RSS 모두 최신순으로 준다.
 */
export function recencyWeight(index: number): number {
  return 1 / (1 + index * 0.45);
}

/** 가중 최빈값 뽑기 */
function dominant(values: { value?: string; weight: number }[]): string | undefined {
  const bag = new Map<string, number>();
  for (const v of values) if (v.value) bag.set(v.value, (bag.get(v.value) ?? 0) + v.weight);
  let best: string | undefined;
  let n = 0;
  for (const [k, c] of bag) if (c > n) ((n = c), (best = k));
  return best;
}

type Weighted = { style: BlockStyle; weight: number };

/** 학습 글들에서 본문·소제목의 글자 서식을 학습한다 (최근 글 가중) */
export function analyzeTextStyle(posts: CrawledPost[]): TextStyleProfile {
  const bodyStyles: Weighted[] = [];
  const headStyles: Weighted[] = [];
  const quoteStyles: Weighted[] = [];
  posts.forEach((p, i) => {
    const weight = recencyWeight(i);
    for (const b of p.blocks) {
      if (b.type === "text" && b.style) bodyStyles.push({ style: b.style, weight });
      else if (b.type === "heading" && b.style) headStyles.push({ style: b.style, weight });
      else if (b.type === "quote" && b.textStyle) quoteStyles.push({ style: b.textStyle, weight });
    }
  });
  // 가중치 합의 과반이면 '그렇다'로 본다
  const majority = (arr: Weighted[], pick: (s: BlockStyle) => boolean | undefined) => {
    const total = arr.reduce((n, w) => n + w.weight, 0);
    if (total === 0) return false;
    const hit = arr.reduce((n, w) => n + (pick(w.style) ? w.weight : 0), 0);
    return hit > total / 2;
  };
  const pickField = (arr: Weighted[], f: (s: BlockStyle) => string | undefined) =>
    dominant(arr.map((w) => ({ value: f(w.style), weight: w.weight })));

  // 인사말 = 각 글의 첫 텍스트 블록
  const intros: Weighted[] = [];
  posts.forEach((p, i) => {
    const first = p.blocks.find((b) => b.type === "text");
    if (first && first.type === "text" && first.style) {
      intros.push({ style: first.style, weight: recencyWeight(i) });
    }
  });

  return {
    introColor: pickField(intros, (s) => s.color),
    introBold: majority(intros, (s) => s.bold),
    bodyFont: pickField(bodyStyles, (s) => s.font),
    bodySize: pickField(bodyStyles, (s) => s.size),
    bodyColor: pickField(bodyStyles, (s) => s.color),
    headingBold: majority(headStyles, (s) => s.bold),
    headingItalic: majority(headStyles, (s) => s.italic),
    headingSize: pickField(headStyles, (s) => s.size),
    quoteBold: majority(quoteStyles, (s) => s.bold),
    quoteItalic: majority(quoteStyles, (s) => s.italic),
    quoteSize: pickField(quoteStyles, (s) => s.size),
  };
}

/** 본문 안에서 특정 문구만 색이 다른 규칙 (상호명 등) */
export interface InlineColorRule {
  text: string;
  style: BlockStyle;
  /** 몇 편에서 이 문구를 이 색으로 썼는지 */
  posts: number;
}

/**
 * 본문 기본색과 다른 색이 걸린 짧은 문구를 학습한다.
 *
 * 원문은 인사말의 상호명처럼 줄 안의 한 단어만 색을 바꾼다. 여러 글에 반복해서
 * 나오는 것만 규칙으로 삼아야 그 글에만 있던 우연한 강조를 따라가지 않는다.
 * 서명 영역(글 말미)은 원문 블록을 통째로 복사하므로 여기서 제외한다.
 */
export function analyzeInlineColors(
  posts: CrawledPost[],
  bodyColor?: string,
  /** 인사말 줄 색 — 이 색은 줄 전체에 따로 칠하므로 문구 규칙에서 뺀다 */
  introColor?: string,
  minPosts = 2,
): InlineColorRule[] {
  const base = (bodyColor ?? "#000000").toLowerCase();
  const intro = introColor?.toLowerCase();
  const seen = new Map<string, { style: BlockStyle; posts: Set<number> }>();

  posts.forEach((p, pi) => {
    // 말미 6블록은 서명으로 보고 건너뛴다
    const body = p.blocks.slice(0, Math.max(0, p.blocks.length - 6));
    for (const b of body) {
      if (b.type !== "text" && b.type !== "heading" && b.type !== "quote") continue;
      for (const r of b.runs ?? []) {
        const color = r.style?.color?.toLowerCase();
        const text = r.text.trim();
        if (!color || color === base || (intro && color === intro)) continue;
        // 문장 전체가 아니라 '문구'만 — 너무 길면 우리 글에 그대로 나올 리 없다
        if (text.length < 2 || text.length > 16) continue;
        const key = `${text}|${color}`;
        const hit = seen.get(key) ?? { style: { ...r.style, color }, posts: new Set<number>() };
        hit.posts.add(pi);
        seen.set(key, hit);
      }
    }
  });

  return [...seen.entries()]
    .map(([key, v]) => ({ text: key.split("|")[0]!, style: v.style, posts: v.posts.size }))
    .filter((r) => r.posts >= minPosts)
    .sort((a, b) => b.posts - a.posts)
    .slice(0, 8);
}

/** 학습 블로그의 섹션-제목 표기 방식 프로필 */
export interface HeadingStyleProfile {
  style: "heading" | "quote"; // 소제목 vs 인용구 (더 많이 쓴 쪽)
  quoteStyle: QuoteStyle; // style==="quote"일 때의 인용구 스타일
  usesStructure: boolean; // 학습 블로그가 소제목/인용구를 실제로 쓰는지
  /** 글 끝에 제목을 인용구로 한 번 더 넣는 습관이 있는지 + 그때 쓰는 스타일 */
  closingQuote?: { use: boolean; style: QuoteStyle };
}

/** 제목과 마무리 인용구가 같은 글인지 — 앞부분이 겹치면 같은 문구로 본다 */
function repeatsTitle(quoteText: string, title: string): boolean {
  const a = normalize(quoteText);
  const b = normalize(title);
  if (a.length < 8 || b.length < 8) return false;
  const head = b.slice(0, Math.min(12, b.length));
  return a.includes(head) || b.includes(a.slice(0, Math.min(12, a.length)));
}

/** 학습 글들의 블록에서 지배적 섹션-제목 스타일을 판별한다 (최근 글 가중). */
export function analyzeHeadingStyle(posts: CrawledPost[]): HeadingStyleProfile {
  let headingScore = 0;
  let quoteScore = 0;
  let blockTotal = 0;
  const quoteStyleScore: Partial<Record<QuoteStyle, number>> = {};

  // 마무리 인용구(제목 반복) 습관 집계
  let closingHit = 0;
  let closingTotal = 0;
  const closingStyleScore: Partial<Record<QuoteStyle, number>> = {};

  posts.forEach((p, i) => {
    const w = recencyWeight(i);
    const quotes: { text: string; style: QuoteStyle }[] = [];
    for (const b of p.blocks) {
      if (b.type === "heading") {
        headingScore += w;
        blockTotal++;
      } else if (b.type === "quote") {
        quoteScore += w;
        blockTotal++;
        quoteStyleScore[b.style] = (quoteStyleScore[b.style] ?? 0) + w;
        quotes.push({ text: b.text, style: b.style });
      }
    }
    // 이 글의 마지막 인용구가 제목을 되풀이하는가
    closingTotal += w;
    const last = quotes[quotes.length - 1];
    if (last && repeatsTitle(last.text, p.title)) {
      closingHit += w;
      closingStyleScore[last.style] = (closingStyleScore[last.style] ?? 0) + w;
    }
  });

  const topStyle = (bag: Partial<Record<QuoteStyle, number>>, fallback: QuoteStyle): QuoteStyle => {
    let best = 0;
    let out: QuoteStyle = fallback;
    for (const [s, n] of Object.entries(bag)) {
      if ((n ?? 0) > best) {
        best = n ?? 0;
        out = s as QuoteStyle;
      }
    }
    return out;
  };

  return {
    style: quoteScore > headingScore ? "quote" : "heading",
    quoteStyle: topStyle(quoteStyleScore, "line"),
    usesStructure: blockTotal >= 2,
    closingQuote: {
      // 학습 글 절반 이상이 제목을 인용구로 되풀이하면 우리도 그렇게 쓴다
      use: closingTotal > 0 && closingHit > closingTotal / 2,
      style: topStyle(closingStyleScore, "default"),
    },
  };
}

/** 발행용 본문 블록 (문단·소제목·인용구 순서) */
export interface BodyBlock {
  kind: "text" | "heading" | "quote";
  text: string; // text=줄바꿈 적용본, heading/quote=제목 문구(한 줄)
  quoteStyle?: QuoteStyle;
  /** 글 끝 마무리 인용구 — 섹션 제목이 아니므로 사진을 뒤에 붙이지 않는다 */
  closing?: boolean;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, "").trim();
}

/**
 * 줄바꿈 적용본(content)을 문단으로 나누고, headings에 해당하는 문단을
 * 학습 프로필에 따라 소제목/인용구 블록으로 표시한다.
 * 매칭 실패나 구조 미사용 시 전부 text 블록(현행과 동일)이라 안전하다.
 */
export function buildStructuredBody(
  content: string,
  headings: string[],
  profile: HeadingStyleProfile,
  /** 있으면 글 끝에 제목을 인용구로 한 번 더 넣는다 (학습 블로그 습관일 때만) */
  title?: string,
): BodyBlock[] {
  const headingNorms = new Set(headings.map(normalize).filter(Boolean));
  const paragraphs = content
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const blocks: BodyBlock[] = [];
  for (const para of paragraphs) {
    const flat = para.replace(/\n/g, " ").trim();
    const isHeading = profile.usesStructure && headingNorms.has(normalize(flat));
    if (isHeading) {
      if (profile.style === "quote")
        blocks.push({ kind: "quote", text: flat, quoteStyle: profile.quoteStyle });
      else blocks.push({ kind: "heading", text: flat });
    } else {
      blocks.push({ kind: "text", text: para });
    }
  }

  // 마무리 인용구 — 학습 블로그가 글 끝에 제목을 되풀이하는 습관이 있을 때만
  if (profile.closingQuote?.use && title?.trim()) {
    blocks.push({
      kind: "quote",
      text: title.trim(),
      quoteStyle: profile.closingQuote.style,
      closing: true,
    });
  }
  return blocks;
}
