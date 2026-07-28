import type { CrawledPost, ContentBlock, QuoteStyle, BlockStyle } from "../core/types";
import { countChars } from "../core/text";

export const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

function decodeEntities(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/** se-main-container 영역만 잘라낸다 (없으면 null) */
function extractContainer(html: string): string | null {
  const i = html.indexOf("se-main-container");
  if (i < 0) return null;
  // 컨테이너 시작 이후 전체 — 본문 뒤 푸터에는 se-text-paragraph/se-image-resource가 없어 오탐 적음
  return html.slice(i);
}

/** SmartEditor ONE 문단에서 본문 텍스트를 재구성 */
function extractText(container: string): string {
  const paras: string[] = [];
  const pPattern =
    /<p[^>]*class="[^"]*se-text-paragraph[^"]*"[^>]*>([\s\S]*?)<\/p>/g;
  let m: RegExpExecArray | null;
  while ((m = pPattern.exec(container)) !== null) {
    const inner = decodeEntities(m[1]!.replace(/<[^>]+>/g, ""))
      .replace(/​/g, "") // zero-width space
      .replace(/[ \t]+/g, " ")
      .trim();
    paras.push(inner); // 빈 문단도 유지 → 문단 경계
  }

  if (paras.length === 0) {
    // 구버전 에디터 등 — 컨테이너 전체 텍스트로 폴백
    const text = decodeEntities(
      container
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " "),
    );
    return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  return paras
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "")
    .trim();
}

/** 썸네일·블러 파라미터를 큰 사이즈로 승격 */
function upgradeImageUrl(url: string): string {
  if (/[?&]type=/.test(url)) {
    return url.replace(/([?&]type=)[^&]*/, "$1w966");
  }
  return url;
}

/** 본문 이미지 URL 수집 (se-image-resource 우선) */
function extractImages(container: string): string[] {
  const urls = new Set<string>();
  const imgPattern = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = imgPattern.exec(container)) !== null) {
    const tag = m[0];
    if (!/se-image-resource|se-imageStrip|se_mediaImage/.test(tag)) continue;
    const src =
      tag.match(/\bdata-lazy-src="([^"]+)"/)?.[1] ??
      tag.match(/\bsrc="([^"]+)"/)?.[1];
    if (!src) continue;
    if (src.startsWith("data:")) continue; // 인라인 플레이스홀더 제외
    urls.add(upgradeImageUrl(decodeEntities(src)));
  }
  return [...urls];
}

/** 한 컴포넌트 조각 안의 se-text-paragraph 텍스트들을 재구성 */
function paraTexts(chunk: string): string {
  const pPattern =
    /<p[^>]*class="[^"]*se-text-paragraph[^"]*"[^>]*>([\s\S]*?)<\/p>/g;
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pPattern.exec(chunk)) !== null) {
    const inner = decodeEntities(m[1]!.replace(/<[^>]+>/g, ""))
      .replace(/​/g, "")
      .replace(/[ \t]+/g, " ")
      .trim();
    parts.push(inner);
  }
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "").trim();
}

/**
 * 컴포넌트 조각에서 글자 서식(폰트·크기·색·굵기·기울임)을 뽑는다.
 * ⚠️ 빈 span(공백·zero-width)이 앞에 오는 경우가 많아 **실제 글자가 든 span**을 기준으로 삼는다.
 *    (안 그러면 서명의 파란색 대신 앞선 빈 span의 검정이 학습된다)
 */
function extractStyle(chunk: string): BlockStyle | undefined {
  let attrs = "";
  for (const m of chunk.matchAll(/<span([^>]*)>([\s\S]*?)<\/span>/g)) {
    const text = (m[2] ?? "").replace(/<[^>]+>/g, "").replace(/[\s​]/g, "");
    if (text) {
      attrs = m[1] ?? "";
      break;
    }
  }
  if (!attrs) attrs = chunk; // span을 못 찾으면 조각 전체로 폴백

  const font = attrs.match(/se-ff-([a-z0-9_-]+)/)?.[1];
  const size = attrs.match(/se-fs-(fs\d+)/)?.[1];
  // `background-color:`도 "color:"로 끝나서 같이 걸린다 → 앞에 '-'가 없는 color만
  const color = attrs.match(/(?:^|[;"\s])color:\s*(#[0-9a-fA-F]{3,6})/)?.[1]?.toLowerCase();
  const bold = /<b>|<strong>|se-weight-bold/.test(chunk);
  const italic = /<i>|<em>|se-style-italic/.test(chunk);
  if (!font && !size && !color && !bold && !italic) return undefined;
  return { font, size, color, bold, italic };
}

/** 인용구 컴포넌트 클래스(se-l-quotation_*)에서 스타일 판별 */
function quoteStyleFromClass(cls: string): QuoteStyle {
  const s = cls.match(/se-l-quotation_([a-z]+)/)?.[1];
  if (s === "line" || s === "bubble" || s === "underline" || s === "postit" || s === "corner") return s;
  return "default";
}

/**
 * 본문을 SmartEditor 컴포넌트 단위로 문서 순서대로 분류한다.
 * - se-text → 본문(text)
 * - se-section + se-section-sectionTitle → 소제목(heading)
 * - se-quotation(se-l-quotation_*) → 인용구(quote) + 스타일
 * - se-image → 이미지
 * 이렇게 해야 소제목·인용구를 학습·재현할 수 있다(예전엔 전부 평문으로 섞임).
 */
function extractBlocks(container: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const bounds: { idx: number; kind: string; cls: string }[] = [];
  const re = /<div class="se-component (se-[a-z]+)([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(container)) !== null) {
    bounds.push({ idx: m.index, kind: m[1]!, cls: m[1]! + m[2]! });
  }

  for (let i = 0; i < bounds.length; i++) {
    const { idx, kind, cls } = bounds[i]!;
    const end = i + 1 < bounds.length ? bounds[i + 1]!.idx : container.length;
    const chunk = container.slice(idx, end);

    if (kind === "se-image") {
      for (const tag of chunk.match(/<img\b[^>]*>/gi) ?? []) {
        if (!/se-image-resource|se-imageStrip|se_mediaImage/.test(tag)) continue;
        const src =
          tag.match(/\bdata-lazy-src="([^"]+)"/)?.[1] ?? tag.match(/\bsrc="([^"]+)"/)?.[1];
        if (src && !src.startsWith("data:"))
          blocks.push({ type: "image", url: upgradeImageUrl(decodeEntities(src)) });
      }
      continue;
    }
    if (kind === "se-oglink") {
      // 링크 카드 — URL만 있으면 발행 때 그대로 재현할 수 있다
      const url = chunk.match(/<a href="([^"]+)"[^>]*class="[^"]*se-oglink/)?.[1]
        ?? chunk.match(/"link":\s*"([^"]+)"/)?.[1]
        ?? chunk.match(/<a href="(https?:[^"]+)"/)?.[1];
      const title = decodeEntities(chunk.match(/se-oglink-title[^>]*>([^<]{1,80})/)?.[1] ?? "").trim();
      if (url) blocks.push({ type: "oglink", url: decodeEntities(url), title: title || undefined });
      continue;
    }
    if (kind === "se-quotation") {
      const text = paraTexts(chunk);
      if (text)
        blocks.push({
          type: "quote",
          text,
          style: quoteStyleFromClass(cls),
          textStyle: extractStyle(chunk),
        });
      continue;
    }
    if (kind === "se-section") {
      const text = paraTexts(chunk);
      if (!text) continue;
      const style = extractStyle(chunk);
      if (/se-section-sectionTitle/.test(chunk)) blocks.push({ type: "heading", text, style });
      else blocks.push({ type: "text", text, style });
      continue;
    }
    if (kind === "se-text") {
      const text = paraTexts(chunk);
      if (text) blocks.push({ type: "text", text, style: extractStyle(chunk) });
      continue;
    }
    // se-oglink · se-document 등은 무시
  }
  return blocks;
}

/**
 * 모바일 글 페이지를 가져와 본문 텍스트·이미지 URL을 추출한다.
 * 실패 시 예외를 던진다(상위에서 개별 글 단위로 감싼다).
 */
export async function fetchPostContent(
  blogId: string,
  logNo: string,
  fallbackTitle = "",
): Promise<CrawledPost> {
  const url = `https://m.blog.naver.com/${encodeURIComponent(blogId)}/${logNo}`;
  const res = await fetch(url, {
    headers: { "User-Agent": MOBILE_UA, "Accept-Language": "ko-KR,ko;q=0.9" },
  });
  if (!res.ok) throw new Error(`본문 로드 실패 (${res.status})`);
  const html = await res.text();

  const container = extractContainer(html);
  const text = container ? extractText(container) : "";
  const images = container ? extractImages(container) : [];
  const blocks = container ? extractBlocks(container) : [];

  const ogTitle = decodeEntities(
    html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/)?.[1] ?? "",
  ).trim();

  return {
    blogId,
    logNo,
    url,
    title: fallbackTitle || ogTitle || `${blogId}/${logNo}`,
    text,
    images,
    blocks,
    charCount: countChars(text),
  };
}
