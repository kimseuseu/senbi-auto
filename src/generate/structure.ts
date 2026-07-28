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

/** 최빈값 뽑기 */
function dominant(values: (string | undefined)[]): string | undefined {
  const bag = new Map<string, number>();
  for (const v of values) if (v) bag.set(v, (bag.get(v) ?? 0) + 1);
  let best: string | undefined;
  let n = 0;
  for (const [k, c] of bag) if (c > n) ((n = c), (best = k));
  return best;
}

/** 학습 글들에서 본문·소제목의 글자 서식을 학습한다 */
export function analyzeTextStyle(posts: CrawledPost[]): TextStyleProfile {
  const bodyStyles: BlockStyle[] = [];
  const headStyles: BlockStyle[] = [];
  const quoteStyles: BlockStyle[] = [];
  for (const p of posts) {
    for (const b of p.blocks) {
      if (b.type === "text" && b.style) bodyStyles.push(b.style);
      else if (b.type === "heading" && b.style) headStyles.push(b.style);
      else if (b.type === "quote" && b.textStyle) quoteStyles.push(b.textStyle);
    }
  }
  const majority = (arr: BlockStyle[], pick: (s: BlockStyle) => boolean | undefined) =>
    arr.length > 0 && arr.filter(pick).length > arr.length / 2;

  // 인사말 = 각 글의 첫 텍스트 블록
  const intros: BlockStyle[] = [];
  for (const p of posts) {
    const first = p.blocks.find((b) => b.type === "text");
    if (first && first.type === "text" && first.style) intros.push(first.style);
  }

  return {
    introColor: dominant(intros.map((s) => s.color)),
    introBold: majority(intros, (s) => s.bold),
    bodyFont: dominant(bodyStyles.map((s) => s.font)),
    bodySize: dominant(bodyStyles.map((s) => s.size)),
    bodyColor: dominant(bodyStyles.map((s) => s.color)),
    headingBold: majority(headStyles, (s) => s.bold),
    headingItalic: majority(headStyles, (s) => s.italic),
    headingSize: dominant(headStyles.map((s) => s.size)),
    quoteBold: majority(quoteStyles, (s) => s.bold),
    quoteItalic: majority(quoteStyles, (s) => s.italic),
    quoteSize: dominant(quoteStyles.map((s) => s.size)),
  };
}

/** 학습 블로그의 섹션-제목 표기 방식 프로필 */
export interface HeadingStyleProfile {
  style: "heading" | "quote"; // 소제목 vs 인용구 (더 많이 쓴 쪽)
  quoteStyle: QuoteStyle; // style==="quote"일 때의 인용구 스타일
  usesStructure: boolean; // 학습 블로그가 소제목/인용구를 실제로 쓰는지
}

/** 학습 글들의 블록에서 지배적 섹션-제목 스타일을 판별한다. */
export function analyzeHeadingStyle(posts: CrawledPost[]): HeadingStyleProfile {
  let headingCount = 0;
  let quoteCount = 0;
  const quoteStyleCount: Partial<Record<QuoteStyle, number>> = {};
  for (const p of posts) {
    for (const b of p.blocks) {
      if (b.type === "heading") headingCount++;
      else if (b.type === "quote") {
        quoteCount++;
        quoteStyleCount[b.style] = (quoteStyleCount[b.style] ?? 0) + 1;
      }
    }
  }
  let quoteStyle: QuoteStyle = "line";
  let best = 0;
  for (const [s, n] of Object.entries(quoteStyleCount)) {
    if ((n ?? 0) > best) {
      best = n ?? 0;
      quoteStyle = s as QuoteStyle;
    }
  }
  return {
    style: quoteCount > headingCount ? "quote" : "heading",
    quoteStyle,
    usesStructure: headingCount + quoteCount >= 2,
  };
}

/** 발행용 본문 블록 (문단·소제목·인용구 순서) */
export interface BodyBlock {
  kind: "text" | "heading" | "quote";
  text: string; // text=줄바꿈 적용본, heading/quote=제목 문구(한 줄)
  quoteStyle?: QuoteStyle;
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
  return blocks;
}
