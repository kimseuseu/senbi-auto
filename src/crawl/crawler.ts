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
  log.info(`${rss.blogId}: RSS ${rss.posts.length}건 중 ${targets.length}건 크롤링`);

  const crawled = await mapConcurrent(targets, concurrency, async (t, i) => {
    try {
      if (i > 0) await sleep(300 + Math.random() * 400); // 완만한 간격
      // 글 본문은 블로그의 실제 주소로만 열린다 (로그인 아이디로는 '글 없음'이 뜬다)
      const post = await fetchPostContent(rss.blogId, t.logNo, t.title);
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

// ---------- 크롤 결과 재사용 ----------
// 학습 블로그는 하루에 글이 한두 편 늘 뿐인데, 키워드 고르기 화면에서 한 번,
// 글을 쓸 때마다 또 한 번씩 45건을 통째로 다시 받아 왔다(글 3편이면 4번).
// 잠깐 사이에 다시 받을 이유가 없으므로 한 번 받은 결과를 일정 시간 돌려 쓴다.

const CRAWL_TTL_MS = 30 * 60 * 1000;
const crawlCache = new Map<string, { at: number; posts: CrawledPost[] }>();
const crawlInflight = new Map<string, Promise<CrawledPost[]>>();

/**
 * crawlBlog 와 같지만, 최근에 받은 결과가 있으면 그걸 돌려준다.
 * 더 많은 글을 받아 둔 게 있으면 앞에서부터 잘라 쓴다(최신순이라 결과가 같다).
 * ⚠️ 돌려받은 배열·글 객체는 여러 곳이 함께 쓰므로 고치지 말 것.
 */
export async function crawlBlogCached(
  blogIdOrUrl: string,
  opts: { count?: number } = {},
): Promise<CrawledPost[]> {
  const count = opts.count ?? 20;
  const blogId = normalizeBlogId(blogIdOrUrl);
  const now = Date.now();

  for (const [key, hit] of crawlCache) {
    if (now - hit.at > CRAWL_TTL_MS) crawlCache.delete(key);
  }
  // 같은 블로그를 count 이상으로 받아 둔 것 중 가장 최근 것
  let best: { at: number; posts: CrawledPost[] } | null = null;
  for (const [key, hit] of crawlCache) {
    const [id, n] = key.split("|");
    if (id !== blogId || Number(n) < count) continue;
    if (!best || hit.at > best.at) best = hit;
  }
  if (best) {
    const mins = Math.round((now - best.at) / 60000);
    log.info(`${blogId}: ${mins}분 전에 받아 둔 글 ${best.posts.length}건 재사용 (다시 크롤하지 않음)`);
    return best.posts.slice(0, count);
  }

  // 화면과 작업이 동시에 요청해도 한 번만 받는다
  const key = `${blogId}|${count}`;
  const running = crawlInflight.get(key);
  if (running) return running;
  const job = crawlBlog(blogId, { count })
    .then((posts) => {
      if (posts.length > 0) crawlCache.set(key, { at: Date.now(), posts });
      return posts;
    })
    .finally(() => crawlInflight.delete(key));
  crawlInflight.set(key, job);
  return job;
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
