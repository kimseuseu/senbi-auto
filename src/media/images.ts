import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { ImageAsset } from "../core/types";
import type { ImageSource } from "../config/settings";
import { IMAGE_CACHE_DIR, MY_IMAGES_DIR, ensureDir } from "../config/paths";
import { MOBILE_UA } from "../crawl/post";
import { createLogger } from "../core/logger";

const log = createLogger("images");

const IMG_EXT = /\.(jpe?g|png|webp|gif)$/i;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * 이미지 버퍼 확보. 로컬 파일 경로면 그대로 읽고(템플릿 사전 저장 이미지),
 * URL이면 다운로드한다. blogfiles는 ?type= 파라미터에 404나므로 제거 후 재시도.
 */
export async function downloadImage(url: string): Promise<Buffer> {
  // 로컬 파일 경로 (http로 시작 안 하면)
  if (!/^https?:\/\//i.test(url)) {
    return fs.readFileSync(url);
  }
  const candidates = [url];
  if (/[?&]type=/.test(url)) {
    candidates.push(url.replace(/[?&]type=[^&]*/, "")); // type 파라미터 제거
  }
  let lastStatus = 0;
  for (const u of candidates) {
    const res = await fetch(u, {
      headers: {
        "User-Agent": MOBILE_UA,
        Referer: "https://m.blog.naver.com/",
        Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
      },
    });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length >= 1024) return buf;
    } else {
      lastStatus = res.status;
    }
  }
  throw new Error(`이미지 다운로드 실패 (${lastStatus})`);
}

/**
 * 원본과 "약간" 다르게 보이도록 자연스러운 미세 보정 + 재인코딩.
 * - 과하지 않게: strength(0~1)로 편차 크기 조절, 기본 0.2 권장.
 * - modulate(밝기·채도·색상 미세)로 시각적 변화, 가장자리 미세 크롭 + 재인코딩으로
 *   픽셀 해시를 바꿔 완전 동일 이미지 판정을 피한다.
 */
export async function applyLightFilter(
  input: Buffer,
  strength = 0.2,
  seed = Math.random(),
): Promise<Buffer> {
  const s = clamp(strength, 0, 1);
  // seed 기반 결정적 흔들림 (이미지마다 다르게)
  const rand = (min: number, max: number, salt: number) => {
    const x = Math.sin(seed * 999 + salt) * 10000;
    const f = x - Math.floor(x); // 0~1
    return min + (max - min) * f;
  };

  const brightness = 1 + rand(-0.05, 0.06, 1) * (s / 0.2);
  const saturation = 1 + rand(-0.06, 0.1, 2) * (s / 0.2);
  const hue = Math.round(rand(-4, 4, 3) * (s / 0.2)); // degrees
  const cropPct = clamp(rand(0.01, 0.03, 4) * (s / 0.2), 0, 0.06);

  const img = sharp(input, { failOn: "none" }).rotate(); // EXIF 방향 정규화
  const meta = await img.metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;

  let pipeline = img.modulate({
    brightness: clamp(brightness, 0.9, 1.12),
    saturation: clamp(saturation, 0.85, 1.2),
    hue,
  });

  // 가장자리 미세 크롭 (내용 손실 최소)
  if (w > 40 && h > 40 && cropPct > 0) {
    const dx = Math.round(w * cropPct);
    const dy = Math.round(h * cropPct);
    pipeline = pipeline.extract({
      left: dx,
      top: dy,
      width: w - dx * 2,
      height: h - dy * 2,
    });
  }

  // 약한 샤픈으로 재압축 뭉개짐 보정 (강도 s에 비례, 아주 약하게)
  if (s > 0) pipeline = pipeline.sharpen({ sigma: 0.5 + s });

  // 메타데이터 제거 + JPEG 재인코딩 → 해시 변경
  return pipeline
    .jpeg({ quality: Math.round(86 + rand(0, 6, 5)), mozjpeg: true })
    .toBuffer();
}

let counter = 0;
function outPath(): string {
  ensureDir(IMAGE_CACHE_DIR);
  const name = `img_${Date.now()}_${counter++}.jpg`;
  return path.join(IMAGE_CACHE_DIR, name);
}

/** 내 이미지 폴더의 이미지 파일 목록 */
export function listMyImages(): string[] {
  try {
    return fs
      .readdirSync(MY_IMAGES_DIR)
      .filter((f) => IMG_EXT.test(f))
      .map((f) => path.join(MY_IMAGES_DIR, f));
  } catch {
    return [];
  }
}

async function saveProcessed(buf: Buffer, source: string): Promise<ImageAsset> {
  const file = outPath();
  const processed = sharp(buf);
  const meta = await processed.metadata();
  fs.writeFileSync(file, buf);
  return {
    path: file,
    source,
    width: meta.width ?? 0,
    height: meta.height ?? 0,
  };
}

export interface PickImagesInput {
  crawledImageUrls: string[];
  count: number;
  sources: ImageSource[];
  filterStrength: number;
}

/**
 * 글에 넣을 이미지를 조달·처리한다.
 * - "crawl": 크롤 이미지 URL을 다운로드 → 약한 필터
 * - "myFolder": 내 이미지 폴더에서 랜덤 선택 → 약한 필터
 * 두 소스를 섞어 count개를 채운다(crawl 우선, 부족하면 myFolder로 보충).
 */
export async function prepareImages(
  input: PickImagesInput,
): Promise<ImageAsset[]> {
  const { count, sources, filterStrength } = input;
  const assets: ImageAsset[] = [];

  const useCrawl = sources.includes("crawl");
  const useMine = sources.includes("myFolder");

  // 1) 크롤 이미지
  if (useCrawl) {
    for (const url of input.crawledImageUrls) {
      if (assets.length >= count) break;
      try {
        const raw = await downloadImage(url);
        const filtered = await applyLightFilter(raw, filterStrength);
        assets.push(await saveProcessed(filtered, `crawl:${url}`));
      } catch (err) {
        log.warn(`크롤 이미지 처리 실패: ${url}`, err);
      }
    }
  }

  // 2) 내 이미지로 보충
  if (useMine && assets.length < count) {
    const mine = listMyImages().sort(() => Math.random() - 0.5);
    for (const file of mine) {
      if (assets.length >= count) break;
      try {
        const raw = fs.readFileSync(file);
        const filtered = await applyLightFilter(raw, filterStrength);
        assets.push(await saveProcessed(filtered, `myFolder:${path.basename(file)}`));
      } catch (err) {
        log.warn(`내 이미지 처리 실패: ${file}`, err);
      }
    }
  }

  log.info(`이미지 ${assets.length}/${count}장 준비 완료`);
  return assets;
}

/** 단일 이미지: 다운로드 → 약한 필터 → 저장 */
export async function prepareOneFiltered(
  url: string,
  filterStrength: number,
): Promise<ImageAsset | null> {
  try {
    const raw = await downloadImage(url);
    const filtered = await applyLightFilter(raw, filterStrength);
    return await saveProcessed(filtered, `crawl:${url}`);
  } catch (err) {
    log.warn(`이미지 처리 실패: ${url}`, err);
    return null;
  }
}

/** URL 목록을 순서 유지하며 최대 count개 필터 처리 */
export async function prepareOrdered(
  urls: string[],
  count: number,
  filterStrength: number,
): Promise<ImageAsset[]> {
  const out: ImageAsset[] = [];
  for (const url of urls) {
    if (out.length >= count) break;
    const a = await prepareOneFiltered(url, filterStrength);
    if (a) out.push(a);
  }
  return out;
}

/** 서명 이미지: 필터 없이 원본 그대로(PNG 무손실) 저장 — 연락처 등 선명 유지 */
export async function prepareVerbatim(url: string): Promise<ImageAsset | null> {
  try {
    const raw = await downloadImage(url);
    const png = await sharp(raw, { failOn: "none" }).png().toBuffer();
    const meta = await sharp(png).metadata();
    ensureDir(IMAGE_CACHE_DIR);
    const file = path.join(IMAGE_CACHE_DIR, `sig_${Date.now()}_${counter++}.png`);
    fs.writeFileSync(file, png);
    return {
      path: file,
      source: `sig:${url}`,
      width: meta.width ?? 0,
      height: meta.height ?? 0,
    };
  } catch (err) {
    log.warn(`서명 이미지 처리 실패: ${url}`, err);
    return null;
  }
}
