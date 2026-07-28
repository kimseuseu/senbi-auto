import type { CrawledPost, ReferencePost } from "../core/types";
import { fetchBlogRss, normalizeBlogId } from "./rss";
import { fetchPostContent } from "./post";
import { createLogger } from "../core/logger";

const log = createLogger("crawler");

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 동시성 제한 병렬 실행 */
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx]!, idx);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

export interface CrawlOptions {
  count?: number; // 가져올 글 수 (기본 20)
  concurrency?: number; // 동시 요청 수 (기본 4)
  minCharCount?: number; // 본문이 너무 짧은 글 제외 (기본 200)
}

/**
 * 블로그의 최근 글을 크롤링해 본문·이미지까지 채운 CrawledPost[] 반환.
 * 개별 글 실패는 건너뛴다(전체를 막지 않음).
 */
export async function crawlBlog(
  blogIdOrUrl: string,
  opts: CrawlOptions = {},
): Promise<CrawledPost[]> {
  const { count = 20, concurrency = 4, minCharCount = 200 } = opts;
  const blogId = normalizeBlogId(blogIdOrUrl);

  const rss = await fetchBlogRss(blogId);
  const targets = rss.posts.slice(0, count);
  log.info(`${blogId}: RSS ${rss.posts.length}건 중 ${targets.length}건 크롤링`);

  const crawled = await mapConcurrent(targets, concurrency, async (t, i) => {
    try {
      if (i > 0) await sleep(300 + Math.random() * 400); // 완만한 간격
      const post = await fetchPostContent(blogId, t.logNo, t.title);
      return post;
    } catch (err) {
      log.warn(`글 ${t.logNo} 크롤 실패`, err);
      return null;
    }
  });

  const ok = crawled.filter(
    (p): p is CrawledPost => p !== null && p.charCount >= minCharCount,
  );
  log.info(
    `크롤 완료: ${ok.length}건 (이미지 총 ${ok.reduce((n, p) => n + p.images.length, 0)}장)`,
  );
  return ok;
}

/** CrawledPost[] → 생성 파이프라인용 ReferencePost[] */
export function toReferences(posts: CrawledPost[]): ReferencePost[] {
  return posts.map((p) => ({
    id: `${p.blogId}-${p.logNo}`,
    title: p.title,
    content: p.text,
    createdAt: new Date().toISOString(),
  }));
}
