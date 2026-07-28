import type { BlogRss, RssPost } from "../core/types";

const RSS_BASE = "https://rss.blog.naver.com";

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/** blog.naver.com/{id} 에서 아이디만 뽑아낸다. URL 전체를 넣어도 됨. */
export function normalizeBlogId(input: string): string {
  const s = input.trim();
  const m = s.match(/blog\.naver\.com\/([A-Za-z0-9_-]+)/);
  if (m) return m[1]!.toLowerCase();
  return s.replace(/^@/, "").toLowerCase();
}

/** 블로그 RSS에서 최근 글 목록을 가져온다 (비공개/없는 블로그는 오류) */
export async function fetchBlogRss(blogIdOrUrl: string): Promise<BlogRss> {
  const id = normalizeBlogId(blogIdOrUrl);
  const res = await fetch(`${RSS_BASE}/${encodeURIComponent(id)}.xml`);
  if (!res.ok) {
    throw new Error(
      `블로그 RSS를 읽지 못했습니다 (${res.status}). 아이디를 확인해 주세요.`,
    );
  }
  const xml = await res.text();

  const channelTitle = decodeXml(
    xml.match(/<channel>[\s\S]*?<title>([\s\S]*?)<\/title>/)?.[1] ?? id,
  );

  const posts: RssPost[] = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemPattern.exec(xml)) !== null) {
    const item = m[1]!;
    const title = decodeXml(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
    const link = decodeXml(
      item.match(/<guid>([\s\S]*?)<\/guid>/)?.[1] ??
        item.match(/<link>([\s\S]*?)<\/link>/)?.[1] ??
        "",
    );
    const logNo = link.match(/\/(\d+)(?:[?#]|\s*$)/)?.[1];
    const pubDate = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim();
    if (title && logNo) posts.push({ title, logNo, pubDate });
  }

  if (posts.length === 0) {
    throw new Error(
      "블로그에서 글을 찾지 못했습니다. RSS 공개 설정을 확인해 주세요.",
    );
  }
  return { blogId: id, blogTitle: channelTitle, posts };
}
