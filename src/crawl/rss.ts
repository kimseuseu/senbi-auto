import type { BlogRss, RssPost } from "../core/types";
import { createLogger } from "../core/logger";

const log = createLogger("rss");

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

/**
 * 네이버 블로그 아이디로 쓸 수 있는 글자만 있는지.
 * 아이디는 폴더 이름(템플릿·계정 세션)에도 쓰이므로 `/`·`..` 같은 경로 문자가 섞이면 안 된다.
 */
export function isValidBlogId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,50}$/.test(id);
}

const BLOG_INFO_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

/**
 * 블로그의 '실제 주소 아이디'를 알아낸다.
 *
 * 네이버는 블로그 주소를 로그인 아이디와 다르게 바꿀 수 있다(예: 로그인 tmakdlf2025 → 주소 dockdock24).
 * 이때 로그인 아이디로는 글 목록(RSS)도 글 본문도 열리지 않고 **빈 결과**만 온다.
 * 사용자는 보통 로그인 아이디를 적으므로, 네이버에 물어 실제 주소로 바꿔 쓴다.
 *
 * @returns 실제 주소 아이디. 그런 블로그가 없으면 null, 확인하지 못했으면(네트워크 등) undefined
 */
export async function resolveBlogId(blogIdOrUrl: string): Promise<string | null | undefined> {
  const id = normalizeBlogId(blogIdOrUrl);
  if (!isValidBlogId(id)) return null;
  try {
    const res = await fetch(`https://m.blog.naver.com/api/blogs/${encodeURIComponent(id)}`, {
      headers: { "User-Agent": BLOG_INFO_UA, Referer: `https://m.blog.naver.com/${id}` },
    });
    // 없는 블로그는 오류 상태코드와 함께 사유(JSON)를 준다 — 상태코드만 보고 버리지 않는다
    const data = (await res.json().catch(() => null)) as {
      isSuccess?: boolean;
      result?: { blogId?: string };
      error?: { code?: string };
    } | null;
    if (!data) return undefined;
    if (!data.isSuccess) return data.error?.code === "blog_id_invalidate" ? null : undefined;
    const real = data.result?.blogId?.trim();
    return real && isValidBlogId(real) ? real : undefined;
  } catch {
    return undefined;
  }
}

/** 확인되면 실제 주소 아이디로, 확인하지 못하면 받은 아이디 그대로 */
export async function canonicalBlogId(blogIdOrUrl: string): Promise<string> {
  const id = normalizeBlogId(blogIdOrUrl);
  return (await resolveBlogId(id)) || id;
}

async function readRssXml(id: string): Promise<string> {
  const res = await fetch(`${RSS_BASE}/${encodeURIComponent(id)}.xml`);
  if (!res.ok) {
    throw new Error(`블로그 글 목록을 읽지 못했습니다 (${res.status}). 블로그 아이디를 확인해 주세요.`);
  }
  return res.text();
}

/** 블로그 RSS에서 최근 글 목록을 가져온다 (비공개/없는 블로그는 오류) */
export async function fetchBlogRss(blogIdOrUrl: string): Promise<BlogRss> {
  let id = normalizeBlogId(blogIdOrUrl);
  if (!isValidBlogId(id)) {
    throw new Error(`블로그 아이디 형식이 올바르지 않습니다: "${id.slice(0, 40)}"`);
  }
  let xml = await readRssXml(id);

  // 글이 하나도 없으면 주소가 다른 블로그일 수 있다 — 실제 주소를 알아내 다시 읽는다
  let real: string | null | undefined;
  if (!/<item>/.test(xml)) {
    real = await resolveBlogId(id);
    if (real && real !== id) {
      log.info(`"${id}" 는 로그인 아이디 — 블로그 실제 주소 "${real}" 로 읽습니다`);
      id = real;
      xml = await readRssXml(id);
    }
  }

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
      real === null
        ? `"${id}" 블로그를 찾지 못했습니다. 블로그 주소(blog.naver.com/ 뒤에 오는 아이디)를 확인해 주세요.`
        : `"${id}" 블로그에 공개된 글이 없습니다. 전체공개 글이 있어야 학습할 수 있습니다.`,
    );
  }
  return { blogId: id, blogTitle: channelTitle, posts };
}
