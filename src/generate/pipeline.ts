import Anthropic from "@anthropic-ai/sdk";
import type {
  ReferencePost,
  FilterKeyword,
  GenerateResult,
  FilterHit,
  PipelineStage,
  PostType,
} from "../core/types";
import { computeScore } from "../core/score";
import { computeGeoScore } from "../core/geoScore";
import { analyzeOverlap, collectHeadingLines, type OverlapReport } from "../core/similarity";
import {
  countChars,
  countCharsWithSpaces,
  wrapForMobile,
  splitFaqBlocks,
  findRemainingWords,
} from "../core/text";

// senbiPost src/lib/generate.ts 파이프라인 이식 (크롤 참고글 기반 자동 생성용)

const MAX_TOKENS = 16000;
const TARGET_MIN = 1000;
const TARGET_MAX = 1200;
const HARD_MIN = 950;
const HARD_MAX = 1300;

/**
 * 참고글과 겹치는 문장 비율의 상한. 넘으면 다시 쓴다.
 * 같은 회사 블로그끼리 비슷한 글이 올라가면 네이버가 하나를 유사문서로 처리해
 * 나중에 올린 쪽(보통 새 블로그)이 검색에서 빠진다.
 */
const OVERLAP_LIMIT = 0.3;
/** 재작성 시도 횟수 (1회 생성 + 최대 2회 재작성) */
const MAX_REWRITES = 2;

const ORIGINALITY_RULE = `참고글은 **문체와 구성만** 배우는 자료다. 문장을 옮겨 쓰지 않는다:
- 참고글의 문장을 그대로, 또는 단어 몇 개만 바꿔 쓰지 않는다. 같은 내용이라도 문장 구조·어순·서술 각도를 바꿔 처음부터 새로 쓴다.
- 소제목은 참고글에 쓰인 문구를 재사용하지 않고 새로 짓는다.
- 참고글에 나온 예시(장소·상황·비유)를 그대로 가져오지 말고, 같은 주제의 다른 장면으로 바꿔 쓴다.
- 참고글에 없는 각도(주의할 점, 고르는 기준, 준비물, 실제 쓰는 순서 등)를 최소 한 섹션은 넣어 정보량을 더한다.`;

const BANNED_GUIDANCE = `네이버 블로그에서 저품질 판정을 받기 쉬운 표현은 절대 사용하지 않는다:
- 과장·확정 광고성 표현: "100% 보장", "무조건", "최저가", "업계 최고", "완벽한", "파격", "초특가", "역대급 할인", "정품 보장", "완치", "부작용 없음" 등
- 직접적인 구매·행동 유도 문구: "지금 바로 구매하세요", "클릭하세요", "문의 주세요", "연락 주세요", "링크 클릭" 등의 반복
- 비속어, 은어, 자극적인 표현 전반
- 같은 키워드의 부자연스러운 반복(키워드 스터핑)`;

/**
 * 글 맨 위 핵심 요약 규칙.
 *
 * 검색 AI(네이버 AI 브리핑 등)는 질문에 바로 답하는 완결된 문장을 가져다 쓴다.
 * 학습 블로그는 인사말로 시작하고 23자마다 줄을 바꿔 쓰는데, 그런 도입부는 인용할 문장이 없다.
 * 그래서 본문 문체와 상관없이, 글 맨 위에 '이 글이 무엇에 답하는지'를 담백하게 적어 둔다.
 */
const SUMMARY_RULE = `[글 맨 위 핵심 요약 — summary 필드]
본문(content)과 별도로, 글 맨 위에 놓일 요약을 summary 에 쓴다. 검색 AI가 이 글을 인용할 때 그대로 가져다 쓸 수 있는 문장이어야 한다.
- 3문장, 전체 120~220자(공백 포함). 한 문장은 한 줄에 끝까지 쓰고(문장 중간에 줄을 바꾸지 않는다), 문장 사이는 줄바꿈 하나로 나눈다.
- 1번째 문장: 메인키워드가 무엇이고 어떤 때 쓰는지 바로 답하는 정의문으로 쓴다. "메인키워드(이)란 …을 말합니다" 꼴을 쓰고, 메인키워드는 글자 그대로 넣는다.
- 2번째 문장: 이 글이 다루는 내용을 본문 순서대로 짚는다(예: 쓰임새, 고르는 기준, 진행 순서, 자주 묻는 질문).
- 3번째 문장: 읽는 사람이 가져갈 결론이나 판단 기준을 한 문장으로 적는다.
- 문체: 이 부분만은 참고글의 말투를 따르지 않는다. 인사말·감탄·이모지·물음표·상호 소개 없이 "~입니다/~합니다"로 끝나는 담백한 설명문으로 쓴다.
- 본문에 있는 사실만 쓴다. 본문에 없는 수치·가격·기간·스펙을 새로 만들지 않는다.
- 금지 표현·필터 단어 규칙은 요약에도 똑같이 적용한다.`;

const SUMMARY_PROP = {
  type: "string",
  description:
    "글 맨 위에 놓일 핵심 요약. 3문장, 한 줄에 한 문장(문장 사이는 줄바꿈 하나), 전체 120~220자. 담백한 설명문.",
} as const;

const HEADINGS_PROP = {
  type: "array",
  items: { type: "string" },
  description:
    "본문에서 섹션을 나누는 '소제목' 줄들을, 본문에 쓴 문구 그대로 순서대로. 소제목은 문장이 아닌 8~18자 짧은 제목(예: '어떤 제품인가요', '설치는 이렇게'). 본문 각 소제목 줄과 정확히 일치해야 한다.",
} as const;

const GEN_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "블로그 글 제목 (메인키워드 포함)" },
    summary: SUMMARY_PROP,
    content: {
      type: "string",
      description:
        "블로그 본문. 문단은 빈 줄로 구분. 각 섹션 앞에는 짧은 소제목 한 줄을 둔다. 마크다운 문법 없이 순수 텍스트만.",
    },
    headings: HEADINGS_PROP,
  },
  required: ["title", "summary", "content", "headings"],
  additionalProperties: false,
} as const;

const VALIDATE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: SUMMARY_PROP,
    content: { type: "string" },
    replacedWords: {
      type: "array",
      items: {
        type: "object",
        properties: {
          word: { type: "string" },
          replacement: { type: "string" },
        },
        required: ["word", "replacement"],
        additionalProperties: false,
      },
    },
    headings: HEADINGS_PROP,
  },
  required: ["title", "summary", "content", "replacedWords", "headings"],
  additionalProperties: false,
} as const;

/** 한 단계가 돌려주는 글 */
interface Draft {
  title: string;
  summary: string;
  content: string;
  headings: string[];
}

/**
 * 요약을 '한 줄에 한 문장'으로 정돈한다.
 * 모델이 문장을 한 줄에 몰아 쓰거나 빈 줄·번호를 섞어도 같은 모양으로 맞춘다.
 */
export function tidySummary(raw: string | undefined): string {
  if (!raw?.trim()) return "";
  return raw
    .split(/\n+|(?<=[.!?])\s+(?=[가-힣A-Za-z0-9"'(])/)
    .map((s) => s.replace(/^\s*(?:\d+[.)]|[-•*])\s*/, "").trim())
    .filter((s) => s.length >= 8)
    .slice(0, 4)
    .join("\n");
}

function firstText(message: Anthropic.Message): string {
  for (const block of message.content) {
    if (block.type === "text") return block.text;
  }
  throw new Error("AI 응답에서 텍스트를 찾지 못했습니다.");
}

function extractJson<T>(message: Anthropic.Message, stage: string): T {
  if (message.stop_reason === "refusal") {
    throw new Error(`${stage} 단계에서 안전상의 이유로 거부되었습니다. 키워드/참고글을 바꿔 다시 시도해 주세요.`);
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error(`${stage} 단계에서 응답이 잘렸습니다. 참고글 수를 줄여 주세요.`);
  }
  const raw = firstText(message);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${stage} 단계의 AI 응답을 해석하지 못했습니다.`);
  }
}

/** 키워드 등장 횟수 기반으로 관련성 높은 참고글을 고른다 */
export function pickReferences(
  references: ReferencePost[],
  keywords: string[],
  limit = 5,
): ReferencePost[] {
  if (references.length <= limit) return references;
  const scored = references.map((ref) => {
    const haystack = (ref.title + " " + ref.content).toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      const needle = kw.toLowerCase();
      let idx = haystack.indexOf(needle);
      while (idx !== -1) {
        score += 1;
        idx = haystack.indexOf(needle, idx + needle.length);
      }
    }
    return { ref, score };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.ref.createdAt.localeCompare(a.ref.createdAt);
  });
  return scored.slice(0, limit).map((s) => s.ref);
}

function referenceBlock(refs: ReferencePost[]): string {
  if (refs.length === 0) {
    return "(등록된 참고글이 없음 — 자연스러운 정보성 블로그 문체로 작성)";
  }
  return refs
    .map(
      (r, i) =>
        `<참고글 ${i + 1}>\n제목: ${r.title}\n${r.content.slice(0, 3000)}\n</참고글 ${i + 1}>`,
    )
    .join("\n\n");
}

function filterBlock(filters: FilterKeyword[]): string {
  if (filters.length === 0) return "";
  const lines = filters.map((f) =>
    f.replacement
      ? `- "${f.word}" → 반드시 "${f.replacement}"(으)로 대체`
      : `- "${f.word}" → 문맥에 맞는 자연스러운 다른 표현으로 대체`,
  );
  return `\n\n[사용자 지정 필터 단어 — 지정 대체어 형태를 제외하고 본문·제목 어디에도 남으면 안 됨]\n${lines.join("\n")}`;
}

function identityRule(userInfo?: { question: string; answer: string }[]): string {
  const base =
    "참고글에 등장하는 업체명·상호·전화번호·주소·링크는 참고글 출처의 것이므로 절대 그대로 옮기지 않는다.";
  const answered = (userInfo ?? []).filter((u) => u.answer.trim());
  if (answered.length === 0) {
    return `${base} 자기소개가 필요한 자리에는 특정 상호 대신 "저희"처럼 중립적으로 쓴다.`;
  }
  const infoLines = answered.map((u) => `- ${u.question} → ${u.answer.trim()}`).join("\n");
  return `${base} 아래 [작성자 제공 정보]는 이 글의 실제 사실이므로 자연스럽게 반영한다. 여기에 없는 신원·연락처·가격·스펙은 지어내지 않는다.

[작성자 제공 정보]
${infoLines}`;
}

function postTypeRule(postType: PostType, productInfo?: string): string {
  switch (postType) {
    case "review":
      return "실제로 경험해 본 것 같은 후기 글로 쓴다. 구체적인 사용 장면과 상황 묘사를 담되, 검증할 수 없는 효능을 단정하지 않는다.";
    case "product":
      return productInfo
        ? `아래 [제품·서비스 정보]를 바탕으로 한 소개 글로 쓴다. 정보에 없는 스펙이나 조건을 지어내지 않는다.\n\n[제품·서비스 정보]\n${productInfo}`
        : "제품·서비스를 소개하는 글로 쓴다. 확인되지 않은 스펙·수치·가격·조건은 지어내지 말고 용도·활용 장면 중심으로 쓴다.";
    default:
      return "실제 경험을 바탕으로 쓴 것 같은 진정성 있는 정보성 글로 쓴다.";
  }
}

export interface PipelineInput {
  mainKeyword: string;
  subKeywords: string[];
  references: ReferencePost[];
  filters: FilterKeyword[];
  lineWidth: number;
  apiKey: string;
  model: string;
  postType?: PostType;
  productInfo?: string;
  userInfo?: { question: string; answer: string }[];
  /** 템플릿에 수동으로 추가한 지침 */
  instructions?: string;
  onProgress?: (stage: PipelineStage) => void;
}

export async function runPipeline(input: PipelineInput): Promise<GenerateResult> {
  const client = new Anthropic({ apiKey: input.apiKey });
  const keywords = [input.mainKeyword, ...input.subKeywords];

  input.onProgress?.("references");
  const usedRefs = pickReferences(input.references, keywords);
  const refTexts = usedRefs.map((r) => r.content);

  // 참고글에서 소제목으로 쓰인 줄 — 그대로 재사용하면 복제로 보이므로 금지 목록으로 넘긴다
  const bannedHeadings = collectHeadingLines(refTexts).slice(0, 40);
  const bannedHeadingBlock =
    bannedHeadings.length > 0
      ? `\n\n[이미 쓴 소제목 — 이 문구들은 그대로 쓰지 말고 새로 지을 것]\n${bannedHeadings.map((h) => `- ${h}`).join("\n")}`
      : "";

  // ---------- 1단계: 글 생성 ----------
  const genSystem = `너는 네이버 블로그 상위 노출 글쓰기 전문가다.
아래 참고글들은 우리가 직접 작성해 온 블로그 글이다. 이 글들의 문체, 어조, 문장 길이, 도입-전개-마무리 구성, 독자에게 말 거는 방식을 학습해서 같은 사람이 쓴 것처럼 새 글을 작성한다.

${referenceBlock(usedRefs)}

가장 중요한 규칙 — 독창성:
${ORIGINALITY_RULE}${bannedHeadingBlock}

작성 규칙:
1. 본문 분량은 공백을 제외하고 한글 기준 ${TARGET_MIN}~${TARGET_MAX}자. 이 범위를 반드시 지킨다.
2. 메인키워드는 제목에 1회, 본문에 4~6회 자연스럽게 녹여 쓴다.
3. 서브키워드는 각각 본문에 1~2회 자연스럽게 포함한다.
4. ${BANNED_GUIDANCE}
5. 문단은 빈 줄로 구분하고, 마크다운 문법(#, *, - 등)은 쓰지 않는다. 글은 3~6개 섹션으로 나누고, 각 섹션 앞에 짧은 소제목 한 줄(문장 아님, 8~18자)을 둔다. 그 소제목 줄들을 본문에 쓴 그대로 headings 배열에도 담는다.
   또한 **줄을 "1." "2." 같은 번호나 "-", "•" 로 시작하지 않는다**(네이버 에디터가 목록 서식으로 바꿔 글이 어색해진다). 순서를 말해야 하면 "먼저", "그다음"처럼 문장으로 푼다.
6. 마지막에서 두 번째 섹션은 **자주 묻는 질문**으로 만든다. 소제목 아래에 질문·답변을 3개, 아래 형식 그대로 쓴다.
   "Q. 질문 한 줄" 다음 줄에 "A. 답변 한두 줄". 각 Q와 A는 별도 문단(빈 줄로 구분)으로 둔다.
   질문은 **반드시 물음표로 끝낸다**(물음표가 없으면 질문과 답이 한 줄에 붙어버린다).
   질문은 독자가 실제로 검색할 법한 것(기간·설치·비용·수량 등)으로 고른다.
7. ${postTypeRule(input.postType ?? "info", input.productInfo)}
8. ${identityRule(input.userInfo)}${
    input.instructions?.trim()
      ? `\n9. [사용자 추가 지침 — 반드시 반영] ${input.instructions.trim()}`
      : ""
  }

${SUMMARY_RULE}
요약은 본문 분량(${TARGET_MIN}~${TARGET_MAX}자)에 포함하지 않는다. 본문 첫 문단은 요약을 되풀이하지 말고 평소처럼 참고글의 방식대로 시작한다.`;

  input.onProgress?.("generate");
  const genMessage = await client.messages.create({
    model: input.model,
    max_tokens: MAX_TOKENS,
    thinking: { type: "adaptive" },
    system: genSystem,
    output_config: { format: { type: "json_schema", schema: GEN_SCHEMA } },
    messages: [
      {
        role: "user",
        content: `메인키워드: ${input.mainKeyword}\n서브키워드: ${input.subKeywords.join(", ")}\n\n위 키워드로 네이버 블로그 글을 작성해줘.`,
      },
    ],
  });

  const draft = extractJson<Draft>(genMessage, "글 생성");

  const keywordBlock = `\n\n[검색 노출 키워드 — 아래 표현은 형태 변경·삭제 금지. 금지 표현·필터 규칙과 충돌하면 키워드 보존이 우선한다]\n- 메인키워드: "${input.mainKeyword}" (제목 1회, 본문 4~6회 유지)\n- 서브키워드: ${input.subKeywords.map((k) => `"${k}"`).join(", ")} (각 1~2회 유지)`;

  // ---------- 2단계: 검증·정제 ----------
  const validateSystem = `너는 네이버 블로그 글 검수 전문가다. 주어진 글에서 아래 작업을 수행한다:

1. ${BANNED_GUIDANCE}
   위에 해당하는 표현이 있으면 전부 찾아서 글의 의미와 흐름을 해치지 않는 자연스러운 다른 단어나 문장으로 대체한다.${filterBlock(input.filters)}
2. 대체한 모든 단어를 replacedWords 배열에 기록한다. 대체한 것이 없으면 빈 배열.
3. 본문 분량은 공백 제외 ${TARGET_MIN}~${TARGET_MAX}자를 유지한다. 벗어나면 내용을 다듬어 맞춘다.
4. 문단 구분(빈 줄)과 섹션 소제목 줄은 그대로 유지하고, 마크다운 문법은 쓰지 않는다.
   줄이 "1." "2." 같은 번호나 "-", "•" 로 시작하면 그 표기를 없애고 문장으로 자연스럽게 바꾼다.
   단 **"Q." "A." 로 시작하는 줄은 그 표기를 반드시 그대로 둔다**(자주 묻는 질문 형식).
5. 글의 주제, 문체, 키워드 배치는 바꾸지 않는다.
6. 본문에 남아 있는 섹션 소제목 줄들을 그대로 headings 배열에 담는다.
7. 글 맨 위 요약(summary)도 1번과 같은 기준으로 검수하고, 아래 규칙에 맞지 않으면 고쳐 쓴다. 본문을 고쳤다면 요약도 고친 본문에 맞춘다.${keywordBlock}

${SUMMARY_RULE}`;

  input.onProgress?.("validate");
  const validateMessage = await client.messages.create({
    model: input.model,
    max_tokens: MAX_TOKENS,
    thinking: { type: "adaptive" },
    system: validateSystem,
    output_config: { format: { type: "json_schema", schema: VALIDATE_SCHEMA } },
    messages: [
      {
        role: "user",
        content: `제목: ${draft.title}\n\n[글 맨 위 요약]\n${draft.summary}\n\n[본문]\n${draft.content}`,
      },
    ],
  });

  let refined = extractJson<Draft & { replacedWords: FilterHit[] }>(validateMessage, "검증·정제");

  // ---------- 3단계: 분량 보정 (필요 시 1회) ----------
  const count = countChars(refined.content);
  if (count < HARD_MIN || count > HARD_MAX) {
    input.onProgress?.("length");
    const direction = count < HARD_MIN ? "늘려" : "줄여";
    const lengthFixMessage = await client.messages.create({
      model: input.model,
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      system: `너는 블로그 글 분량 조정 전문가다. 글의 주제, 문체, 키워드, 문단 구조와 섹션 소제목 줄을 유지하면서 본문 분량만 공백 제외 ${TARGET_MIN}~${TARGET_MAX}자로 ${direction}서 다시 작성한다. 현재 분량은 공백 제외 ${count}자다. 마크다운 문법은 쓰지 않는다. 본문의 섹션 소제목 줄들을 그대로 headings 배열에 담는다. 글 맨 위 요약(summary)은 고친 본문에 맞춰 아래 규칙대로 다시 쓴다(요약은 본문 분량에 포함하지 않는다).

다시 작성할 때 아래 제약을 반드시 지킨다:
${BANNED_GUIDANCE}${filterBlock(input.filters)}${keywordBlock}

${SUMMARY_RULE}`,
      output_config: { format: { type: "json_schema", schema: GEN_SCHEMA } },
      messages: [
        {
          role: "user",
          content: `제목: ${refined.title}\n\n[글 맨 위 요약]\n${refined.summary}\n\n[본문]\n${refined.content}`,
        },
      ],
    });
    const fixed = extractJson<Draft>(lengthFixMessage, "분량 보정");
    refined = { ...fixed, replacedWords: refined.replacedWords };
  }

  // ---------- 3.5단계: 유사문서 게이트 ----------
  // 참고글을 그대로 옮겨 쓴 문장이 많으면 다시 쓴다. 넘긴 채로 발행하면
  // 네이버가 둘 중 하나를 유사문서로 처리해 새 블로그 쪽이 검색에서 빠진다.
  let overlap = analyzeOverlap(refined.content, refTexts);
  for (let attempt = 1; attempt <= MAX_REWRITES && overlap.ratio > OVERLAP_LIMIT; attempt++) {
    input.onProgress?.("originality");
    const worst = overlap.hits.slice(0, 12);
    const rewriteSystem = `너는 블로그 글을 '베낀 티 안 나게' 다시 쓰는 전문가다.
아래 글은 참고글의 문장을 그대로 옮긴 부분이 많아 중복 콘텐츠로 판정될 위험이 크다.
글의 주제·문체·분량·섹션 구성·키워드 배치는 유지하되, **아래 지적된 문장들은 반드시 다른 문장으로 새로 쓴다.**

${ORIGINALITY_RULE}

[그대로 베낀 문장 — 전부 새로 쓸 것]
${worst.map((h, i) => `${i + 1}. 내 글: "${h.sentence}"\n   원문: "${h.source}"`).join("\n")}

바꿀 때 지킬 것:
- 단어만 바꾸지 말고 문장을 다시 구성한다(어순·주어·서술 각도 변경).
- 지적되지 않은 문장도 원문과 비슷하면 함께 손본다.
- 소제목이 지적됐다면 새 문구로 바꾸고, headings 배열도 바꾼 문구로 채운다.
- "Q." "A." 로 시작하는 줄의 표기는 유지한다.
- 본문 분량은 공백 제외 ${TARGET_MIN}~${TARGET_MAX}자.
- 글 맨 위 요약(summary)은 고친 본문에 맞춰 아래 규칙대로 다시 쓴다.

${BANNED_GUIDANCE}${filterBlock(input.filters)}${keywordBlock}

${SUMMARY_RULE}`;

    const rewriteMessage = await client.messages.create({
      model: input.model,
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      system: rewriteSystem,
      output_config: { format: { type: "json_schema", schema: GEN_SCHEMA } },
      messages: [
        {
          role: "user",
          content: `제목: ${refined.title}\n\n[글 맨 위 요약]\n${refined.summary}\n\n[본문]\n${refined.content}`,
        },
      ],
    });
    const rewritten = extractJson<Draft>(rewriteMessage, "독창성 재작성");
    const next = analyzeOverlap(rewritten.content, refTexts);
    // 더 나빠지면 이전 결과를 지킨다
    if (next.ratio <= overlap.ratio) {
      refined = { ...rewritten, replacedWords: refined.replacedWords };
      overlap = next;
    }
    if (overlap.ratio <= OVERLAP_LIMIT) break;
  }

  // ---------- 4단계: 모바일 줄바꿈 (단어 보존) ----------
  input.onProgress?.("wrap");
  refined.content = splitFaqBlocks(refined.content); // Q./A. 를 문단으로 떼어낸 뒤 줄바꿈
  const wrappedContent = wrapForMobile(refined.content, input.lineWidth);

  // ---------- 5단계: 필터 단어 잔존 검사 ----------
  const summary = tidySummary(refined.summary);
  const remaining = findRemainingWords(
    refined.title + "\n" + summary + "\n" + refined.content,
    input.filters,
  );
  // 인용 적합도는 독자(와 검색 AI)가 실제로 보게 될 순서대로 — 요약이 맨 앞이다
  const asPublished = summary ? `${summary}\n\n${refined.content}` : refined.content;

  return {
    title: refined.title,
    summary,
    content: wrappedContent,
    rawContent: refined.content,
    headings: (refined.headings ?? []).map((h) => h.trim()).filter(Boolean),
    charCount: countChars(refined.content),
    charCountWithSpaces: countCharsWithSpaces(refined.content),
    replacedWords: refined.replacedWords ?? [],
    remainingFilterWords: remaining,
    usedReferences: usedRefs.map((r) => r.title),
    overlap,
    overlapOk: overlap.ratio <= OVERLAP_LIMIT,
    postType: input.postType ?? "info",
    mainKeyword: input.mainKeyword,
    subKeywords: input.subKeywords,
    score: computeScore({
      title: refined.title,
      content: refined.content,
      mainKeyword: input.mainKeyword,
      subKeywords: input.subKeywords,
      remainingFilterWords: remaining,
    }),
    geoScore: computeGeoScore({
      title: refined.title,
      content: asPublished,
      mainKeyword: input.mainKeyword,
    }),
  };
}
