import type {
  CrawledPost,
  ImageAsset,
  PreparedSignature,
} from "../core/types";
import type { Settings } from "../config/settings";
import { detectSignature, type Signature } from "../generate/signature";
import { isThumbnail } from "../generate/thumbnail";
import { looksLikeSpecTable, isSpecTable } from "../generate/specTable";
import {
  downloadImage,
  prepareImages,
  prepareOrdered,
  prepareSharp,
  prepareVerbatim,
} from "../media/images";
import { filterUnusedImages } from "../core/usedImages";
import { createLogger } from "../core/logger";

const log = createLogger("assets");

function bigrams(s: string): string[] {
  const clean = s.replace(/\s+/g, "");
  const out: string[] = [];
  for (let i = 0; i + 2 <= clean.length; i++) out.push(clean.slice(i, i + 2));
  return out;
}

function corpusDf(posts: CrawledPost[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const p of posts) {
    for (const g of new Set(bigrams(p.title))) df.set(g, (df.get(g) ?? 0) + 1);
  }
  return df;
}

/** 키워드와 제목/본문 관련도 순위 (공통 렌탈어는 IDF로 깎고 고유 어절 우선) */
export function rankPostsByKeyword(
  posts: CrawledPost[],
  keyword: string,
): CrawledPost[] {
  const kb = [...new Set(bigrams(keyword))];
  if (kb.length === 0) return posts;
  const N = Math.max(1, posts.length);
  const df = corpusDf(posts);
  const idf = (g: string) => Math.log((N + 1) / ((df.get(g) ?? 0) + 1)) + 1;
  const scored = posts.map((p) => {
    const tb = new Set(bigrams(p.title));
    let score = 0;
    for (const g of kb) {
      if (tb.has(g)) score += idf(g);
      else if (p.text.includes(g)) score += idf(g) * 0.2;
    }
    return { p, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.p);
}

/**
 * 키워드에 맞는 '진짜' 글이 학습 블로그에 있는지 판정.
 * 공통 렌탈어가 아닌 '고유 어절'(코퍼스 소수 글에만 등장)을 상위 글이 공유해야 인정.
 */
export function keywordHasSource(
  posts: CrawledPost[],
  keyword: string,
): boolean {
  const kb = [...new Set(bigrams(keyword))];
  const N = Math.max(1, posts.length);
  const df = corpusDf(posts);
  const distinctive = kb.filter((g) => {
    const d = df.get(g) ?? 0;
    return d > 0 && d <= Math.max(1, Math.floor(N * 0.4));
  });
  if (distinctive.length === 0) return false;
  const top = rankPostsByKeyword(posts, keyword)[0];
  if (!top) return false;
  const tb = new Set(bigrams(top.title));
  return distinctive.some((g) => tb.has(g));
}

export interface PostAssets {
  thumbnail?: ImageAsset; // 맨 위 단독·가운데
  bodyImages: ImageAsset[]; // 본문 이미지 (1장씩 단독 배치)
  /** 제품사양 표 이미지 — 자주 묻는 질문 앞에 넣는다 */
  specImage?: ImageAsset;
  signature: PreparedSignature; // 맨 아래 서명 (글·이미지 순서대로)
  /** 학습 블로그에 이 키워드 연관 글이 없어 이미지 연관성이 낮음 */
  weakMatch?: boolean;
}

/** 감지된 서명 → 발행용 블록 준비 (텍스트 그대로 · 이미지는 원본) */
async function prepareSignatureBlocks(sig: Signature): Promise<PreparedSignature> {
  const out: PreparedSignature = [];
  for (const b of sig.blocks) {
    if (b.type === "image") {
      const img = await prepareVerbatim(b.url);
      if (img) out.push({ type: "image", image: img });
    } else if (b.type === "oglink") {
      out.push({ type: "oglink", url: b.url, title: b.title }); // 링크 카드는 URL로 재현
    } else {
      // text·heading·quote 모두 서명에선 텍스트로 취급 (원문 색·굵기는 그대로 가져간다)
      const style = b.type === "quote" ? b.textStyle : b.style;
      out.push({ type: "text", text: b.text, style });
    }
  }
  return out;
}

/**
 * 생성 키워드에 맞는 원본 글을 골라 그 글 이미지만 사용하고,
 * 첫 이미지가 썸네일이면 분리, 반복 서명 블록을 감지해 함께 반환.
 * 연관 글이 없으면 엉뚱한 이미지 대신 내 폴더 이미지만(또는 생략) 쓴다.
 */
export async function buildPostAssets(
  posts: CrawledPost[],
  keyword: string,
  settings: Settings,
  apiKey: string,
): Promise<PostAssets> {
  const sig = await detectSignature(posts);
  const signature = await prepareSignatureBlocks(sig);
  const sigUrls = new Set(
    sig.blocks
      .filter((b) => b.type === "image")
      .map((b) => (b as { url: string }).url),
  );
  const isSig = (u: string) => sigUrls.has(u);

  // --- 연관 글이 없으면: 엉뚱한 썸네일·이미지 금지 → 내 폴더 이미지만 ---
  if (!keywordHasSource(posts, keyword)) {
    log.warn(
      `키워드 "${keyword}" 연관 글이 학습 블로그에 없음 → 썸네일 생략, 내 폴더 이미지만 사용(없으면 이미지 없이 발행)`,
    );
    const bodyImages = settings.imageSources.includes("myFolder")
      ? await prepareImages({
          crawledImageUrls: [],
          count: settings.imagesPerPost,
          sources: ["myFolder"],
          filterStrength: settings.filterStrength,
        })
      : [];
    return { bodyImages, signature, weakMatch: true };
  }

  // --- 연관 글 있음: 그 글의 이미지만 사용 ---
  const ranked = rankPostsByKeyword(posts, keyword);
  const main = ranked[0]!;
  log.info(`키워드 "${keyword}" → 이미지 출처 글: "${main.title}"`);

  let pool = main.images.filter((u) => !isSig(u));

  // 썸네일 판별 (풀 첫 이미지) — 대표 이미지는 색 보정 없이 화질 유지
  let thumbnail: ImageAsset | undefined;
  const first = pool[0];
  if (first) {
    try {
      const buf = await downloadImage(first);
      if (await isThumbnail(buf, apiKey, settings.model)) {
        const t = await prepareSharp(first);
        if (t) {
          thumbnail = t;
          pool = pool.slice(1);
        }
      }
    } catch {
      /* 무시 */
    }
  }

  // 제품사양 표 찾기 — 값싼 사전 필터로 후보를 좁힌 뒤 비전으로 1장만 확인
  let specImage: ImageAsset | undefined;
  for (const url of pool.slice(0, 12)) {
    try {
      const buf = await downloadImage(url);
      if (!(await looksLikeSpecTable(buf))) continue;
      if (!(await isSpecTable(buf, apiKey, settings.model))) continue;
      const s = await prepareSharp(url); // 표는 글씨가 있어 필터 걸면 뭉개진다
      if (s) {
        specImage = s;
        pool = pool.filter((u) => u !== url);
        log.info("제품사양 표 이미지 확보 — 자주 묻는 질문 앞에 배치");
      }
      break;
    } catch {
      /* 다음 후보 */
    }
  }

  // 이미 발행에 쓴 사진은 뺀다 — 사진까지 겹치면 유사문서 판정이 강해진다
  const beforeDedupe = pool.length;
  pool = filterUnusedImages(pool);
  if (beforeDedupe !== pool.length) {
    log.info(`이전 글에 쓴 사진 ${beforeDedupe - pool.length}장 제외`);
  }

  // 내 이미지 폴더가 켜져 있으면 먼저 채운다 (학습 블로그 사진 재사용을 줄인다)
  let bodyImages: ImageAsset[] = [];
  if (settings.imageSources.includes("myFolder")) {
    bodyImages = await prepareImages({
      crawledImageUrls: [],
      count: settings.imagesPerPost,
      sources: ["myFolder"],
      filterStrength: settings.filterStrength,
    });
    if (bodyImages.length > 0) log.info(`내 이미지 폴더에서 ${bodyImages.length}장 우선 사용`);
  }

  // 모자란 만큼 크롤 이미지로 채운다.
  // ⚠️ 보충은 '같은 주제 글'에서만 한다. 순위만 보고 아무 글이나 끌어오면
  //    그레이팅 도크 글에 정육 쇼케이스 사진이 섞이는 식으로 글과 사진이 어긋난다.
  if (bodyImages.length < settings.imagesPerPost && settings.imageSources.includes("crawl")) {
    const need = () => settings.imagesPerPost - bodyImages.length;
    bodyImages = bodyImages.concat(
      await prepareOrdered(pool, need(), settings.filterStrength),
    );
    if (need() > 0) {
      // 같은 키워드가 제목에 들어 있는 글에서만 추가로 가져온다
      const sameTopic = ranked
        .slice(1)
        .filter((p) => keywordHasSource([p], keyword) || p.title.includes(keyword));
      for (const p of sameTopic) {
        if (need() <= 0) break;
        const extra = filterUnusedImages(p.images.slice(1).filter((u) => !isSig(u)));
        const more = await prepareOrdered(extra, need(), settings.filterStrength);
        if (more.length > 0) log.info(`같은 주제 글 "${p.title.slice(0, 20)}"에서 ${more.length}장 보충`);
        bodyImages = bodyImages.concat(more);
      }
    }
    if (need() > 0) {
      log.info(
        `사진 ${bodyImages.length}/${settings.imagesPerPost}장만 확보 — 주제가 다른 사진을 섞지 않고 이대로 발행합니다`,
      );
    }
  }

  return { thumbnail, bodyImages, specImage, signature };
}
