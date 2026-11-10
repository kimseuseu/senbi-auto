import { JsonStore } from "../config/store";

/**
 * 이미 발행에 쓴 크롤 이미지 URL 기록.
 *
 * 같은 제품을 되풀이해 올리다 보면 그 제품 사진은 금방 다 쓴다. 그래서 '쓴 사진은 못 쓴다'가
 * 아니라 **안 쓴 사진을 먼저 쓰고, 다 썼으면 가장 오래전에 쓴 사진부터 다시 쓴다.**
 * 연달아 올리는 글끼리 같은 사진이 겹치는 것만 피하면 된다.
 */
interface UsedImagesDb {
  /** 크롤 원본 URL → 처음 쓴 시각(ISO) */
  urls: Record<string, string>;
}

const store = new JsonStore<UsedImagesDb>("used-images", { urls: {} });

/** 보관 기간 — 이보다 오래된 기록은 정리한다 (사진 고갈 방지) */
const KEEP_DAYS = 120;

export function isImageUsed(url: string): boolean {
  return Boolean(store.read().urls[url]);
}

/** 아직 안 쓴 URL만 남긴다 (순서 유지) */
export function filterUnusedImages(urls: string[]): string[] {
  const used = store.read().urls;
  return urls.filter((u) => !used[u]);
}

/** 이미 쓴 URL만, 오래전에 쓴 것부터 */
export function usedImagesOldestFirst(urls: string[]): string[] {
  const used = store.read().urls;
  return urls
    .filter((u) => used[u])
    .sort((a, b) => Date.parse(used[a]!) - Date.parse(used[b]!));
}

export function markImagesUsed(urls: string[]): void {
  if (urls.length === 0) return;
  const at = new Date().toISOString();
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  store.update((d) => {
    for (const [u, t] of Object.entries(d.urls)) {
      if (Date.parse(t) < cutoff) delete d.urls[u];
    }
    for (const u of urls) d.urls[u] = at; // 마지막으로 쓴 시각 (다시 쓸 순서를 정한다)
    return d;
  });
}

/** ImageAsset.source("crawl:URL")에서 원본 URL만 뽑는다 */
export function sourceUrl(source: string): string | null {
  const m = /^(?:crawl|sig):(.+)$/.exec(source);
  return m ? m[1]! : null;
}
