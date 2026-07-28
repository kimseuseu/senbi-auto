import Anthropic from "@anthropic-ai/sdk";
import { createLogger } from "../core/logger";

const log = createLogger("social");

const COMMENT_SCHEMA = {
  type: "object",
  properties: {
    comment: {
      type: "string",
      description: "블로그 글에 남길 짧고 진정성 있는 한국어 댓글 (1~2문장)",
    },
  },
  required: ["comment"],
  additionalProperties: false,
} as const;

const BUDDY_SCHEMA = {
  type: "object",
  properties: {
    message: {
      type: "string",
      description: "서로이웃 신청 문구 (한국어, 예의 있고 자연스럽게, 1~2문장, 최대 90자)",
    },
  },
  required: ["message"],
  additionalProperties: false,
} as const;

function firstText(m: Anthropic.Message): string {
  for (const b of m.content) if (b.type === "text") return b.text;
  throw new Error("빈 응답");
}

/**
 * 글 내용을 읽고 맥락에 맞는 댓글을 생성한다.
 * 스팸성 복붙 댓글이 아니라 글마다 다른, 관련 있는 댓글 → 제재 위험도 낮춤.
 */
export async function generateComment(
  apiKey: string,
  model: string,
  postTitle: string,
  postExcerpt: string,
): Promise<string> {
  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model,
    max_tokens: 500,
    thinking: { type: "adaptive" },
    system: `너는 블로그 이웃과 소통하는 사람이다. 아래 글을 읽고 자연스럽고 진정성 있는 댓글을 한 줄 남긴다.
규칙:
- 글의 실제 내용에 반응하는 구체적인 댓글 (뻔한 "잘 보고 가요" 금지, 글 소재를 언급).
- 1~2문장, 존댓말, 이모지는 0~1개.
- 광고·홍보·링크·내 블로그 언급 금지. 상업적 냄새가 나면 안 된다.`,
    output_config: { format: { type: "json_schema", schema: COMMENT_SCHEMA } },
    messages: [
      {
        role: "user",
        content: `제목: ${postTitle}\n\n본문 발췌:\n${postExcerpt.slice(0, 800)}`,
      },
    ],
  });
  const { comment } = JSON.parse(firstText(message)) as { comment: string };
  log.debug(`댓글 생성: ${comment}`);
  return comment.trim();
}

/**
 * 서로이웃 신청 문구를 생성한다.
 */
export async function generateBuddyMessage(
  apiKey: string,
  model: string,
  targetBlogTitle: string,
  topic: string,
  myBrand?: string,
): Promise<string> {
  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model,
    max_tokens: 400,
    thinking: { type: "adaptive" },
    system: `너는 블로그 서로이웃을 정중하게 신청하는 사람이다. 상대 블로그 주제에 맞춰 자연스러운 신청 문구를 만든다.
규칙:
- 1~2문장, 존댓말, 최대 90자.
- 상대 블로그 주제(${topic})에 대한 관심을 자연스럽게 표현.
- 광고·홍보 금지, 부담스럽지 않게.${myBrand ? `\n- 필요 시 본인을 "${myBrand}"로 간단히 소개해도 됨(선택).` : ""}`,
    output_config: { format: { type: "json_schema", schema: BUDDY_SCHEMA } },
    messages: [
      { role: "user", content: `상대 블로그: ${targetBlogTitle}\n주제: ${topic}` },
    ],
  });
  const { message: msg } = JSON.parse(firstText(message)) as { message: string };
  return msg.trim().slice(0, 95);
}
