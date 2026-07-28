import type { CrawledPost, ContentBlock } from "../core/types";
import { downloadImage } from "../media/images";
import { aHash, hamming } from "../media/hash";
import { createLogger } from "../core/logger";

const log = createLogger("signature");

/** 감지된 서명 = 글마다 반복되는 마지막 블록 시퀀스 (원문 순서) */
export interface Signature {
  blocks: ContentBlock[];
}

const TAIL = 10; // 말미 몇 블록까지 볼지
const MAX_POSTS = 6;

/**
 * 학습 글들에서 "글마다 같은 마지막 부분"(서명 블록)을 순서대로 감지한다.
 * 텍스트는 문자열 일치, 이미지는 지각적 해시로 비교해 공통 말미 시퀀스를 찾는다.
 */
export async function detectSignature(posts: CrawledPost[]): Promise<Signature> {
  const usable = posts.filter((p) => p.blocks.length > 0).slice(0, MAX_POSTS);
  if (usable.length < 2) return { blocks: [] };

  const hashCache = new Map<string, bigint | null>();
  async function hashOf(url: string): Promise<bigint | null> {
    if (hashCache.has(url)) return hashCache.get(url)!;
    let h: bigint | null = null;
    try {
      h = await aHash(await downloadImage(url));
    } catch {
      h = null;
    }
    hashCache.set(url, h);
    return h;
  }
  async function blockEq(a: ContentBlock, b: ContentBlock): Promise<boolean> {
    if (a.type === "text" && b.type === "text") return a.text === b.text;
    if (a.type === "heading" && b.type === "heading") return a.text === b.text;
    if (a.type === "quote" && b.type === "quote")
      return a.text === b.text && a.style === b.style;
    if (a.type === "image" && b.type === "image") {
      const [ha, hb] = await Promise.all([hashOf(a.url), hashOf(b.url)]);
      return ha !== null && hb !== null && hamming(ha, hb) <= 6;
    }
    return false;
  }

  const base = usable[0]!.blocks;
  const others = usable.slice(1);
  const need = Math.max(1, Math.floor(others.length / 2)); // 나머지 중 과반

  let bestD = 0;
  for (let d = 1; d <= Math.min(TAIL, base.length); d++) {
    const baseTail = base.slice(base.length - d);
    let matches = 0;
    for (const o of others) {
      if (o.blocks.length < d) continue;
      const oTail = o.blocks.slice(o.blocks.length - d);
      let ok = true;
      for (let i = 0; i < d; i++) {
        if (!(await blockEq(baseTail[i]!, oTail[i]!))) {
          ok = false;
          break;
        }
      }
      if (ok) matches++;
    }
    if (matches >= need) bestD = d;
  }

  const blocks = base.slice(base.length - bestD);
  log.info(
    `서명 감지: ${blocks.length}블록 (텍스트 ${blocks.filter((b) => b.type === "text").length} · 이미지 ${blocks.filter((b) => b.type === "image").length})`,
  );
  return { blocks };
}
