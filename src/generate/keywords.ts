import { fetchBlogRss } from "../crawl/rss";
import { createLogger } from "../core/logger";

const log = createLogger("keywords");

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
