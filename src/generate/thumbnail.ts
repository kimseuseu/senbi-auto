import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import { createLogger } from "../core/logger";

const log = createLogger("thumbnail");

const SCHEMA = {
  type: "object",
  properties: {
    isThumbnail: { type: "boolean" },
    reason: { type: "string", description: "짧은 판단 근거" },
  },
  required: ["isThumbnail", "reason"],
  additionalProperties: false,
} as const;

/**
 * 이미지가 '썸네일/표지 카드'인지 AI 비전으로 판단한다.
 * 큰 제목 텍스트 오버레이·브랜드 로고·배너형이면 썸네일, 일반 제품/현장 사진이면 아님.
 */
export async function isThumbnail(
  buf: Buffer,
  apiKey: string,
  model: string,
): Promise<boolean> {
  try {
    const jpg = await sharp(buf, { failOn: "none" })
      .resize(480, 480, { fit: "inside" })
      .jpeg({ quality: 80 })
      .toBuffer();
    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model,
      max_tokens: 300,
      thinking: { type: "adaptive" },
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      system:
        "블로그 글의 첫 이미지가 '썸네일/표지 카드'인지 판단한다. 이미지 위에 큰 제목 텍스트가 얹혀 있거나, 브랜드 로고·워드마크가 크게 박혀 있거나, 배너·타이틀 카드 형태면 썸네일이다. 텍스트 없이 제품/현장을 그대로 찍은 사진이면 썸네일이 아니다.",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: jpg.toString("base64"),
              },
            },
            { type: "text", text: "이 이미지는 썸네일(표지)인가요?" },
          ],
        },
      ],
    });
    for (const b of msg.content) {
      if (b.type === "text") {
        const parsed = JSON.parse(b.text) as { isThumbnail: boolean; reason: string };
        log.info(`썸네일 판단: ${parsed.isThumbnail} (${parsed.reason})`);
        return parsed.isThumbnail === true;
      }
    }
    return false;
  } catch (err) {
    log.warn("썸네일 판단 실패 — 아님으로 처리", err);
    return false;
  }
}
