import { JsonStore } from "../config/store";

/**
 * 이미 발행에 쓴 크롤 이미지 URL 기록.
 *
 * 왜 필요한가: 학습 블로그 사진을 그대로 다시 올리면 글에 더해 사진까지 겹쳐
 * 유사문서 판정이 강해진다. 한 번 쓴 사진은 다음 글에서 피한다.
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

export function markImagesUsed(urls: string[]): void {
  if (urls.length === 0) return;
  const at = new Date().toISOString();
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  store.update((d) => {
    for (const [u, t] of Object.entries(d.urls)) {
      if (Date.parse(t) < cutoff) delete d.urls[u];
    }
    for (const u of urls) d.urls[u] ??= at;
    return d;
  });
}

/** ImageAsset.source("crawl:URL")에서 원본 URL만 뽑는다 */
export function sourceUrl(source: string): string | null {
  const m = /^(?:crawl|sig):(.+)$/.exec(source);
  return m ? m[1]! : null;
}
