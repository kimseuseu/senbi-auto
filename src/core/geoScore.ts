import type { SenbiScore, ScoreAxis } from "./types";
import { countChars, buildFlexiblePattern } from "./text";

/**
 * GEO 지수 — 네이버 AI 브리핑 "인용 적합도" 0~100 점수.
 * senbiPost src/lib/geoScore.ts 이식.
 */

const DEFINITION_PATTERNS: RegExp[] = [
  /[가-힣A-Za-z0-9)][가-힣A-Za-z0-9]*(?:란|이란)\s/,
  /(?:를|을)\s*(?:말합니다|말한다|뜻합니다|뜻한다|의미합니다|의미한다|가리킵니다|가리킨다|지칭합니다|일컫습니다|일컫는다)/,
  /(?:라고|이라고)\s*(?:합니다|한다|부릅니다|부른다|불립니다|불린다)/,
  /(?:는|은)\s+[^.!?\n]{1,40}?(?:하는\s*것|하는\s*방법|하는\s*과정)(?:입니다|이다|을\s*말합니다)/,
];

const STRUCTURE_PATTERNS: RegExp[] = [
  /(^|\n)\s*\d+[.)]\s/,
  /(^|\n)\s*[①-⑳]/,
  /(^|\n)\s*[-•·▪]\s/,
  /(?:첫째|둘째|셋째|넷째|다섯째)[,.\s]/,
  /(?:먼저|우선)[,\s][\s\S]{0,60}?(?:다음으로|그다음|이어서|마지막으로|끝으로)/,
  /(?:\d+단계|\d+번째)/,
];

const COMPARISON_PATTERNS: RegExp[] = [
  /장점|단점|장단점/,
  /차이(?:점)?|다른\s*점/,
  /비교(?:하면|해\s*보면|해보면)?/,
  /(?:vs\.?|대비|반면|이에\s*비해|~에\s*비해|보다는)/i,
  /(?:정리하면|요약하면|한눈에|한\s*줄\s*요약|핵심만|결론적으로)/,
];

const FACT_PATTERN =
  /\d+(?:[.,]\d+)?\s*(?:원|만원|억원|억|천원|%|퍼센트|프로|킬로그램|kg|그램|g|cm|센티|밀리|mm|미터|㎡|m²|평|인치|리터|ℓ|l|㎖|ml|시간|분|초|일간|일|주일|주|개월|달|년간|년|명|가지|개|대|회|건|호실|호|위|배|도|℃|와트|w|볼트|v|암페어|헤르츠|hz|기가|메가|픽셀|화소|km|킬로미터|평형|리)/gi;

const STANDALONE_NUMBER = /(?:19|20)\d{2}\s*년|제?\s*\d+\s*(?:회|기|차)/g;

function countMatches(text: string, patterns: RegExp[]): number {
  let n = 0;
  for (const p of patterns) if (p.test(text)) n += 1;
  return n;
}

export function computeGeoScore(input: {
  title: string;
  content: string;
  mainKeyword?: string;
}): SenbiScore {
  const axes: ScoreAxis[] = [];
  const { title, content } = input;
  const main = input.mainKeyword?.trim();
  const chars = countChars(content) || 1;

  const paragraphs = content
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const firstPara = paragraphs[0] ?? content.slice(0, 240);
  const head = content.slice(0, 240);

  const sentences = content
    .split(/(?<=[.!?。])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  // ---------- 정의형 답변 (25) ----------
  const defCount = sentences.filter((s) =>
    DEFINITION_PATTERNS.some((p) => p.test(s)),
  ).length;
  let defScore: number;
  let defSuggestion: string | undefined;
  if (defCount >= 3) defScore = 25;
  else if (defCount === 2) defScore = 21;
  else if (defCount === 1) defScore = 15;
  else {
    defScore = 5;
    defSuggestion =
      '"OO란 ~를 말합니다"처럼 핵심을 한 문장으로 정의·직답하는 문장을 넣어 주세요.';
  }
  axes.push({
    key: "definition",
    label: "정의형 답변",
    score: defScore,
    max: 25,
    suggestion: defSuggestion,
  });

  // ---------- 도입부 집중 (20) ----------
  let introScore = 0;
  const introBits: string[] = [];
  if (main) {
    const kwPattern = buildFlexiblePattern(main, "i", "\\s*");
    const kwInHead = kwPattern ? kwPattern.test(head) : false;
    if (kwInHead) introScore += 11;
    else introBits.push(`도입부(앞 2~3문장)에 핵심 키워드 "${main}"를 넣어 주세요`);
  } else {
    introScore += 6;
  }
  const answerInFirstPara =
    DEFINITION_PATTERNS.some((p) => p.test(firstPara)) ||
    /(?:입니다|합니다|됩니다|좋습니다|가능합니다)[.!?]/.test(firstPara);
  if (answerInFirstPara) introScore += main ? 9 : 8;
  else introBits.push("첫 문단에서 질문에 바로 답하는 문장으로 시작해 주세요");
  introScore = Math.min(introScore, 20);
  axes.push({
    key: "intro",
    label: "도입부 집중",
    score: introScore,
    max: 20,
    suggestion: introBits.length > 0 ? introBits.join(" · ") : undefined,
  });

  // ---------- 단계·순서 구조 (20) ----------
  const structCount = countMatches(content, STRUCTURE_PATTERNS);
  let structScore: number;
  let structSuggestion: string | undefined;
  if (structCount >= 3) structScore = 20;
  else if (structCount === 2) structScore = 15;
  else if (structCount === 1) structScore = 10;
  else {
    structScore = 4;
    structSuggestion =
      "내용을 '첫째·둘째' 또는 '1. 2. 3.' 같은 단계·목록 구조로 정리하면 AI 인용에 유리합니다.";
  }
  axes.push({
    key: "structure",
    label: "단계·순서 구조",
    score: structScore,
    max: 20,
    suggestion: structSuggestion,
  });

  // ---------- 비교·정리 (15) ----------
  const compCount = countMatches(content, COMPARISON_PATTERNS);
  let compScore: number;
  let compSuggestion: string | undefined;
  if (compCount >= 2) compScore = 15;
  else if (compCount === 1) compScore = 10;
  else {
    compScore = 3;
    compSuggestion = "장단점·차이·비교나 '정리하면 ~' 요약을 넣어 주세요.";
  }
  axes.push({
    key: "comparison",
    label: "비교·정리",
    score: compScore,
    max: 15,
    suggestion: compSuggestion,
  });

  // ---------- 구체 팩트 밀도 (20) ----------
  const factMatches =
    (content.match(FACT_PATTERN)?.length ?? 0) +
    (content.match(STANDALONE_NUMBER)?.length ?? 0) +
    (title.match(FACT_PATTERN)?.length ?? 0);
  const per200 = factMatches / (chars / 200);
  let factScore: number;
  let factSuggestion: string | undefined;
  if (per200 >= 1.5) factScore = 20;
  else if (per200 >= 1) factScore = 16;
  else if (per200 >= 0.5) factScore = 11;
  else if (factMatches > 0) factScore = 6;
  else {
    factScore = 2;
    factSuggestion = "가격·기간·규격·수량 등 구체적인 숫자를 넣어 주세요.";
  }
  if (factScore < 16 && factScore > 2)
    factSuggestion = "구체적인 숫자(가격·기간·규격 등)를 더 넣으면 AI 인용에 유리합니다.";
  axes.push({
    key: "facts",
    label: "구체 팩트 밀도",
    score: factScore,
    max: 20,
    suggestion: factSuggestion,
  });

  const total = Math.min(
    100,
    axes.reduce((a, x) => a + x.score, 0),
  );
  return { total, axes };
}

export function geoGrade(total: number): {
  label: string;
  tone: "good" | "ok" | "warn";
} {
  if (total >= 80) return { label: "AI 인용 최적", tone: "good" };
  if (total >= 60) return { label: "인용 가능 — 보완 여지", tone: "ok" };
  return { label: "인용 어려움 — 구조 보완", tone: "warn" };
}
