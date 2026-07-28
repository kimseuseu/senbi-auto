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
import {
  countChars,
  countCharsWithSpaces,
  wrapForMobile,
  findRemainingWords,
} from "../core/text";

// senbiPost src/lib/generate.ts 파이프라인 이식 (크롤 참고글 기반 자동 생성용)

const MAX_TOKENS = 16000;
const TARGET_MIN = 1000;
const TARGET_MAX = 1200;
const HARD_MIN = 950;
const HARD_MAX = 1300;

const BANNED_GUIDANCE = `네이버 블로그에서 저품질 판정을 받기 쉬운 표현은 절대 사용하지 않는다:
- 과장·확정 광고성 표현: "100% 보장", "무조건", "최저가", "업계 최고", "완벽한", "파격", "초특가", "역대급 할인", "정품 보장", "완치", "부작용 없음" 등
- 직접적인 구매·행동 유도 문구: "지금 바로 구매하세요", "클릭하세요", "문의 주세요", "연락 주세요", "링크 클릭" 등의 반복
- 비속어, 은어, 자극적인 표현 전반
- 같은 키워드의 부자연스러운 반복(키워드 스터핑)`;

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
    content: {
      type: "string",
      description:
        "블로그 본문. 문단은 빈 줄로 구분. 각 섹션 앞에는 짧은 소제목 한 줄을 둔다. 마크다운 문법 없이 순수 텍스트만.",
    },
    headings: HEADINGS_PROP,
  },
  required: ["title", "content", "headings"],
  additionalProperties: false,
} as const;

const VALIDATE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
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
  required: ["title", "content", "replacedWords", "headings"],
  additionalProperties: false,
} as const;

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

  // ---------- 1단계: 글 생성 ----------
  const genSystem = `너는 네이버 블로그 상위 노출 글쓰기 전문가다.
아래 참고글들은 우리가 직접 작성해 온 블로그 글이다. 이 글들의 문체, 어조, 문장 길이, 도입-전개-마무리 구성, 독자에게 말 거는 방식을 학습해서 같은 사람이 쓴 것처럼 새 글을 작성한다.

${referenceBlock(usedRefs)}

작성 규칙:
1. 본문 분량은 공백을 제외하고 한글 기준 ${TARGET_MIN}~${TARGET_MAX}자. 이 범위를 반드시 지킨다.
2. 메인키워드는 제목에 1회, 본문에 4~6회 자연스럽게 녹여 쓴다.
3. 서브키워드는 각각 본문에 1~2회 자연스럽게 포함한다.
4. ${BANNED_GUIDANCE}
5. 문단은 빈 줄로 구분하고, 마크다운 문법(#, *, - 등)은 쓰지 않는다. 글은 3~6개 섹션으로 나누고, 각 섹션 앞에 짧은 소제목 한 줄(문장 아님, 8~18자)을 둔다. 그 소제목 줄들을 본문에 쓴 그대로 headings 배열에도 담는다.
   또한 **줄을 "1." "2." 같은 번호나 "-", "•" 로 시작하지 않는다**(네이버 에디터가 목록 서식으로 바꿔 글이 어색해진다). 순서를 말해야 하면 "먼저", "그다음"처럼 문장으로 푼다.
6. ${postTypeRule(input.postType ?? "info", input.productInfo)}
7. ${identityRule(input.userInfo)}${
    input.instructions?.trim()
      ? `\n8. [사용자 추가 지침 — 반드시 반영] ${input.instructions.trim()}`
      : ""
  }`;

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

  const draft = extractJson<{ title: string; content: string; headings: string[] }>(genMessage, "글 생성");

  const keywordBlock = `\n\n[검색 노출 키워드 — 아래 표현은 형태 변경·삭제 금지. 금지 표현·필터 규칙과 충돌하면 키워드 보존이 우선한다]\n- 메인키워드: "${input.mainKeyword}" (제목 1회, 본문 4~6회 유지)\n- 서브키워드: ${input.subKeywords.map((k) => `"${k}"`).join(", ")} (각 1~2회 유지)`;

  // ---------- 2단계: 검증·정제 ----------
  const validateSystem = `너는 네이버 블로그 글 검수 전문가다. 주어진 글에서 아래 작업을 수행한다:

1. ${BANNED_GUIDANCE}
   위에 해당하는 표현이 있으면 전부 찾아서 글의 의미와 흐름을 해치지 않는 자연스러운 다른 단어나 문장으로 대체한다.${filterBlock(input.filters)}
2. 대체한 모든 단어를 replacedWords 배열에 기록한다. 대체한 것이 없으면 빈 배열.
3. 본문 분량은 공백 제외 ${TARGET_MIN}~${TARGET_MAX}자를 유지한다. 벗어나면 내용을 다듬어 맞춘다.
4. 문단 구분(빈 줄)과 섹션 소제목 줄은 그대로 유지하고, 마크다운 문법은 쓰지 않는다.
   줄이 "1." "2." 같은 번호나 "-", "•" 로 시작하면 그 표기를 없애고 문장으로 자연스럽게 바꾼다.
5. 글의 주제, 문체, 키워드 배치는 바꾸지 않는다.
6. 본문에 남아 있는 섹션 소제목 줄들을 그대로 headings 배열에 담는다.${keywordBlock}`;

  input.onProgress?.("validate");
  const validateMessage = await client.messages.create({
    model: input.model,
    max_tokens: MAX_TOKENS,
    thinking: { type: "adaptive" },
    system: validateSystem,
    output_config: { format: { type: "json_schema", schema: VALIDATE_SCHEMA } },
    messages: [{ role: "user", content: `제목: ${draft.title}\n\n${draft.content}` }],
  });

  let refined = extractJson<{
    title: string;
    content: string;
    replacedWords: FilterHit[];
    headings: string[];
  }>(validateMessage, "검증·정제");

  // ---------- 3단계: 분량 보정 (필요 시 1회) ----------
  const count = countChars(refined.content);
  if (count < HARD_MIN || count > HARD_MAX) {
    input.onProgress?.("length");
    const direction = count < HARD_MIN ? "늘려" : "줄여";
    const lengthFixMessage = await client.messages.create({
      model: input.model,
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      system: `너는 블로그 글 분량 조정 전문가다. 글의 주제, 문체, 키워드, 문단 구조와 섹션 소제목 줄을 유지하면서 본문 분량만 공백 제외 ${TARGET_MIN}~${TARGET_MAX}자로 ${direction}서 다시 작성한다. 현재 분량은 공백 제외 ${count}자다. 마크다운 문법은 쓰지 않는다. 본문의 섹션 소제목 줄들을 그대로 headings 배열에 담는다.

다시 작성할 때 아래 제약을 반드시 지킨다:
${BANNED_GUIDANCE}${filterBlock(input.filters)}${keywordBlock}`,
      output_config: { format: { type: "json_schema", schema: GEN_SCHEMA } },
      messages: [
        { role: "user", content: `제목: ${refined.title}\n\n${refined.content}` },
      ],
    });
    const fixed = extractJson<{ title: string; content: string; headings: string[] }>(
      lengthFixMessage,
      "분량 보정",
    );
    refined = { ...fixed, replacedWords: refined.replacedWords };
  }

  // ---------- 4단계: 모바일 줄바꿈 (단어 보존) ----------
  input.onProgress?.("wrap");
  const wrappedContent = wrapForMobile(refined.content, input.lineWidth);

  // ---------- 5단계: 필터 단어 잔존 검사 ----------
  const remaining = findRemainingWords(
    refined.title + "\n" + refined.content,
    input.filters,
  );

  return {
    title: refined.title,
    content: wrappedContent,
    rawContent: refined.content,
    headings: (refined.headings ?? []).map((h) => h.trim()).filter(Boolean),
    charCount: countChars(refined.content),
    charCountWithSpaces: countCharsWithSpaces(refined.content),
    replacedWords: refined.replacedWords ?? [],
    remainingFilterWords: remaining,
    usedReferences: usedRefs.map((r) => r.title),
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
      content: refined.content,
      mainKeyword: input.mainKeyword,
    }),
  };
}
