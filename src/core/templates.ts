import fs from "node:fs";
import path from "node:path";
import { JsonStore } from "../config/store";
import { dataPath, ensureDir } from "../config/paths";
import type { CrawledPost } from "./types";
import { crawlBlog } from "../crawl/crawler";
import { normalizeBlogId, isValidBlogId, canonicalBlogId } from "../crawl/rss";
import { downloadImage } from "../media/images";
import { createLogger } from "./logger";

const log = createLogger("templates");

/** 학습한 블로그 1개 = 템플릿 */
export interface Template {
  id: string;
  name: string;
  blogId: string;
  posts: CrawledPost[]; // 이미지 URL은 로컬 저장 경로로 치환됨
  keywords: string[]; // 제목에서 추출
  instructions: string; // 수동 추가 지침
  createdAt: string;
  updatedAt: string;
  postCount: number;
  imageCount: number;
}

/** 목록·선택용 요약 (무거운 posts 제외) */
export interface TemplateSummary {
  id: string;
  name: string;
  blogId: string;
  keywords: string[];
  instructions: string;
  postCount: number;
  imageCount: number;
  updatedAt: string;
}

interface TemplatesDb {
  templates: Template[];
}
const store = new JsonStore<TemplatesDb>("templates", { templates: [] });

const TEMPLATES_ROOT = dataPath("templates");

/**
 * 템플릿 폴더 경로. id 는 URL 로 들어오는 값이라 `../` 가 섞이면 데이터 폴더 밖을
 * 가리킬 수 있다 — 템플릿 폴더 바로 아래가 아니면 null.
 */
function templateDir(id: string): string | null {
  if (!id || id !== path.basename(id) || id === "." || id === "..") return null;
  const dir = path.resolve(TEMPLATES_ROOT, id);
  return path.dirname(dir) === path.resolve(TEMPLATES_ROOT) ? dir : null;
}

function templateImgDir(id: string): string {
  const dir = templateDir(id);
  if (!dir) throw new Error("템플릿 아이디가 올바르지 않습니다.");
  return ensureDir(path.join(dir, "img"));
}

/** 제목에서 대표 키워드 추출 — 첫 구분자 앞 구간 */
export function extractKeyword(title: string): string {
  return title
    .replace(/\[[^\]]*\]/g, " ")
    .split(/[,·|/]/)[0]!
    .replace(/\s+/g, " ")
    .trim();
}

async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (t: T, i: number) => Promise<R>,
): Promise<R[]> {
  const res: R[] = new Array(items.length);
  let c = 0;
  async function w() {
    while (c < items.length) {
      const i = c++;
      res[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, w));
  return res;
}

/** 한 글의 이미지를 로컬에 저장하고 URL→로컬경로 치환 (반환: 저장 수) */
async function localizeImages(post: CrawledPost, imgDir: string): Promise<number> {
  const urlToLocal = new Map<string, string>();
  let n = 0;
  await mapConcurrent(post.images, 4, async (url, i) => {
    try {
      const buf = await downloadImage(url);
      const ext = url.match(/\.(png|jpe?g|webp|gif)/i)?.[1] ?? "jpg";
      const file = path.join(imgDir, `${post.logNo}_${i}.${ext}`);
      fs.writeFileSync(file, buf);
      urlToLocal.set(url, file);
      n++;
    } catch (e) {
      log.warn(`이미지 저장 실패: ${url}`, e);
    }
  });
  post.images = post.images.map((u) => urlToLocal.get(u) ?? u);
  post.blocks = post.blocks.map((b) =>
    b.type === "image"
      ? { type: "image", url: urlToLocal.get(b.url) ?? b.url }
      : b,
  );
  return n;
}

/** 블로그 학습 → 템플릿 생성 (크롤 + 이미지 로컬저장 + 키워드추출) */
export async function learnBlog(
  blogIdOrUrl: string,
  name: string,
  count = 20,
): Promise<Template> {
  if (!isValidBlogId(normalizeBlogId(blogIdOrUrl))) {
    throw new Error("블로그 아이디 형식이 올바르지 않습니다(영문·숫자·-·_ 만 가능).");
  }
  // 로그인 아이디를 적었더라도 블로그의 실제 주소로 저장한다
  const blogId = await canonicalBlogId(blogIdOrUrl);
  const id = `${blogId}-${Date.now()}`;
  const imgDir = templateImgDir(id);
  log.info(`학습 시작: ${blogId} (${count}글)`);
  const posts = await crawlBlog(blogId, { count });
  if (posts.length === 0) throw new Error("크롤된 글이 없습니다(공개 블로그인지 확인).");

  let imageCount = 0;
  for (const post of posts) imageCount += await localizeImages(post, imgDir);

  const keywords = [
    ...new Set(posts.map((p) => extractKeyword(p.title)).filter(Boolean)),
  ];
  const now = new Date().toISOString();
  const tpl: Template = {
    id,
    name: name.trim() || blogId,
    blogId,
    posts,
    keywords,
    instructions: "",
    createdAt: now,
    updatedAt: now,
    postCount: posts.length,
    imageCount,
  };
  store.update((db) => {
    db.templates.push(tpl);
    return db;
  });
  log.info(
    `학습 완료: "${tpl.name}" — 글 ${posts.length} · 이미지 ${imageCount} · 키워드 ${keywords.length}`,
  );
  return tpl;
}

/** 추가 학습 — 새 글·이미지 병합 (중복 logNo 제외) */
export async function addLearning(id: string, count = 20): Promise<Template | null> {
  const tpl = getTemplate(id);
  if (!tpl) return null;
  const imgDir = templateImgDir(id);
  const posts = await crawlBlog(tpl.blogId, { count });
  const existing = new Set(tpl.posts.map((p) => p.logNo));
  const fresh = posts.filter((p) => !existing.has(p.logNo));
  let added = 0;
  for (const post of fresh) added += await localizeImages(post, imgDir);

  const merged = [...fresh, ...tpl.posts];
  const keywords = [
    ...new Set(merged.map((p) => extractKeyword(p.title)).filter(Boolean)),
  ];
  store.update((db) => {
    const t = db.templates.find((x) => x.id === id);
    if (t) {
      t.posts = merged;
      t.keywords = keywords;
      t.postCount = merged.length;
      t.imageCount += added;
      t.updatedAt = new Date().toISOString();
    }
    return db;
  });
  log.info(`추가 학습: "${tpl.name}" — 새 글 ${fresh.length} · 새 이미지 ${added}`);
  return getTemplate(id);
}

export function getTemplate(id: string): Template | null {
  return store.read().templates.find((t) => t.id === id) ?? null;
}

export function listTemplateSummaries(): TemplateSummary[] {
  return store.read().templates.map((t) => ({
    id: t.id,
    name: t.name,
    blogId: t.blogId,
    keywords: t.keywords,
    instructions: t.instructions,
    postCount: t.postCount,
    imageCount: t.imageCount,
    updatedAt: t.updatedAt,
  }));
}

export function setInstructions(id: string, instructions: string): void {
  store.update((db) => {
    const t = db.templates.find((x) => x.id === id);
    if (t) {
      t.instructions = instructions;
      t.updatedAt = new Date().toISOString();
    }
    return db;
  });
}

/** @returns 지웠으면 true, 그런 템플릿이 없으면 false (없는 id 로는 아무 폴더도 건드리지 않는다) */
export function deleteTemplate(id: string): boolean {
  if (!getTemplate(id)) return false;
  store.update((db) => {
    db.templates = db.templates.filter((t) => t.id !== id);
    return db;
  });
  const dir = templateDir(id);
  if (!dir) return true;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 무시 */
  }
  return true;
}
