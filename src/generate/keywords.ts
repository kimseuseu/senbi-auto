import Anthropic from "@anthropic-ai/sdk";
import { fetchBlogRss } from "../crawl/rss";
import { createLogger } from "../core/logger";

const log = createLogger("keywords");

const SCHEMA = {
  type: "object",
  properties: {
    keywords: {
      type: "array",
      description: "서로 다른 소재의 새 주제 5개 내외",
      items: {
        type: "object",
        properties: {
          keyword: {
            type: "string",
            description: "네이버 검색용 주제 키워드 (예: '이동식 에어컨 렌탈'). 2~5어절, 브랜드명 제외.",
          },
          reason: { type: "string", description: "왜 이 주제가 새롭고 적합한지 한 문장" },
        },
        required: ["keyword", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["keywords"],
  additionalProperties: false,
} as const;

/** 제목/키워드 비교용 정규화 — 공백·조사성 어미 제거 후 소문자 */
function norm(s: string): string {
  return s.replace(/\s+/g, "").replace(/[,·|~\-–—()[\]]/g, "").toLowerCase();
}

/** 이미 다룬 주제와 겹치는지 (핵심 명사 2어절 이상 공유하면 겹침으로 본다) */
export function overlapsExisting(keyword: string, existing: string[]): boolean {
  const k = norm(keyword);
  if (!k) return true;
  for (const e of existing) {
    const n = norm(e);
    if (!n) continue;
    if (n.includes(k) || k.includes(n)) return true;
    // 두 어절 이상 겹치면 사실상 같은 주제
    const words = keyword.split(/\s+/).filter((w) => w.length >= 2);
    const shared = words.filter((w) => n.includes(norm(w))).length;
    if (words.length >= 2 && shared >= 2) return true;
  }
  return false;
}

/** 발행 대상 블로그의 최근 글 제목 (RSS — 본문 안 받아서 가볍다) */
export async function recentTitles(blogId: string, count = 20): Promise<string[]> {
  try {
    const rss = await fetchBlogRss(blogId);
    return rss.posts.slice(0, count).map((p) => p.title.trim()).filter(Boolean);
  } catch (err) {
    log.warn(`최근 글 제목 조회 실패 (${blogId})`, err);
    return [];
  }
}

export interface ProposeInput {
  apiKey: string;
  model: string;
  brandName?: string;
  /** 업종·문체 파악용 — 학습 블로그 글 제목 */
  domainTitles: string[];
  /** 겹치면 안 되는 것 — 발행 블로그 최근 글 제목 */
  publishedTitles: string[];
  /** 겹치면 안 되는 것 — 과거 사용 키워드 */
  usedKeywords: string[];
  /** 이번 제안에서 이미 거른 후보 */
  avoid?: string[];
}

/**
 * 학습 블로그의 업종을 파악하고, 발행 블로그가 아직 안 다룬 새 주제 키워드를 제안한다.
 * 겹침 검사는 AI 응답을 그대로 믿지 않고 코드에서 한 번 더 거른다.
 */
export async function proposeKeywords(input: ProposeInput): Promise<{ keyword: string; reason: string }[]> {
  const client = new Anthropic({ apiKey: input.apiKey });
  const banned = [...input.publishedTitles, ...input.usedKeywords, ...(input.avoid ?? [])];

  const system = `너는 네이버 블로그 주제 기획자다. 아래 블로그가 다루는 업종을 파악하고, **아직 다루지 않은 새 주제 키워드**를 제안한다.

[이 블로그가 써온 글 제목 — 업종·톤 파악용]
${input.domainTitles.slice(0, 40).map((t) => `- ${t}`).join("\n") || "(없음)"}

[이미 발행해서 겹치면 안 되는 주제들]
${banned.slice(0, 60).map((t) => `- ${t}`).join("\n") || "(없음)"}

규칙:
1. 위 업종에서 실제로 검색될 법한 구체적인 상품·서비스 주제를 고른다. (예: "이동식 에어컨 렌탈")
2. **[겹치면 안 되는 주제들]과 소재가 겹치면 안 된다.** 같은 물건을 표현만 바꾼 것도 겹치는 것으로 본다.
3. 키워드는 2~5어절, 브랜드명·상호는 넣지 않는다.
4. 이 업체가 실제로 취급할 법한 것만 고른다. 업종에서 벗어난 주제는 금지.
5. 서로 다른 소재로 여러 개 제안한다.${input.brandName ? `\n6. 이 블로그 운영 업체: ${input.brandName}` : ""}`;

  const msg = await client.messages.create({
    model: input.model,
    max_tokens: 2000,
    thinking: { type: "adaptive" },
    system,
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: "새로 쓸 주제 키워드를 제안해줘." }],
  });

  let parsed: { keywords: { keyword: string; reason: string }[] };
  try {
    const text = msg.content.find((b) => b.type === "text");
    parsed = JSON.parse(text && "text" in text ? text.text : "{}");
  } catch {
    log.warn("키워드 제안 응답 해석 실패");
    return [];
  }

  // AI가 겹친 걸 줄 수도 있으니 코드로 한 번 더 거른다
  const fresh = (parsed.keywords ?? []).filter((k) => k.keyword?.trim() && !overlapsExisting(k.keyword, banned));
  log.info(`키워드 제안 ${parsed.keywords?.length ?? 0}개 중 새 주제 ${fresh.length}개`);
  return fresh;
}
