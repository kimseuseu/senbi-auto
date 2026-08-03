import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import { createLogger } from "../core/logger";

const log = createLogger("specTable");

const SCHEMA = {
  type: "object",
  properties: {
    isSpecTable: { type: "boolean" },
    reason: { type: "string", description: "짧은 판단 근거" },
  },
  required: ["isSpecTable", "reason"],
  additionalProperties: false,
} as const;

/**
 * 제품사양 표처럼 보이는지 값싸게 걸러낸다 (비전 호출 전 사전 필터).
 * 스펙 표는 대개 흰 배경 + 회색 글씨라 채도가 거의 없고 밝다.
 * 현장 사진은 색이 있어서 여기서 걸러진다.
 */
export async function looksLikeSpecTable(buf: Buffer): Promise<boolean> {
  try {
    const img = sharp(buf, { failOn: "none" });
    const { channels } = await img.stats();
    const [r, g, b] = channels;
    if (!r || !g || !b) return false;
    // 채널 평균이 서로 비슷하면 무채색
    const mean = (r.mean + g.mean + b.mean) / 3;
    const spread = Math.max(
      Math.abs(r.mean - mean),
      Math.abs(g.mean - mean),
      Math.abs(b.mean - mean),
    );
    // 밝은 배경(평균 190 이상) + 거의 무채색(채널 편차 6 이하)
    return mean >= 190 && spread <= 6;
  } catch {
    return false;
  }
}

/** 이미지가 '제품사양 표'인지 AI 비전으로 확인한다 (사전 필터를 통과한 후보에만 호출) */
export async function isSpecTable(
  buf: Buffer,
  apiKey: string,
  model: string,
): Promise<boolean> {
  try {
    const jpg = await sharp(buf, { failOn: "none" })
      .resize(640, 640, { fit: "inside" })
      .jpeg({ quality: 80 })
      .toBuffer();
    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model,
      max_tokens: 300,
      thinking: { type: "adaptive" },
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      system:
        "이미지가 '제품 사양(스펙) 표'인지 판단한다. 모델명·크기·전원·출력·중량 같은 항목과 값이 표 형태로 정리돼 있으면 사양표다. 제품이나 현장을 찍은 일반 사진, 배너, 로고, 연락처 이미지는 사양표가 아니다.",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: jpg.toString("base64") },
            },
            { type: "text", text: "이 이미지는 제품사양 표인가요?" },
          ],
        },
      ],
    });
    for (const b of msg.content) {
      if (b.type === "text") {
        const parsed = JSON.parse(b.text) as { isSpecTable: boolean; reason: string };
        log.info(`사양표 판단: ${parsed.isSpecTable} (${parsed.reason})`);
        return parsed.isSpecTable === true;
      }
    }
    return false;
  } catch (err) {
    log.warn("사양표 판단 실패 — 아님으로 처리", err);
    return false;
  }
}
