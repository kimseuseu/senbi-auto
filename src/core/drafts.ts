import { JsonStore } from "../config/store";
import type { GenerateResult } from "./types";

export interface GeneratedDraft {
  id: string;
  title: string;
  /** 글 맨 위 핵심 요약 (한 줄에 한 문장) */
  summary?: string;
  content: string; // 줄바꿈 적용본
  rawContent: string;
  mainKeyword?: string;
  /** 어느 블로그에 올리려고 만든 글인지 (예전 초안엔 없다) */
  blogId?: string;
  score?: number;
  geoScore?: number;
  images: string[]; // 로컬 파일 경로
  status: "draft" | "published";
  publishedUrl?: string;
  /**
   * 이 초안의 키워드를 '쓴 것'으로 칠지.
   * 사람이 직접 올릴 초안(자동발행 꺼짐·유사문서로 발행 보류)은 true — 다음 회차에 같은 키워드를 또 쓰지 않는다.
   * 발행하다 오류로 실패한 초안은 false — 같은 키워드로 다시 시도할 수 있어야 한다.
   */
  keywordReserved?: boolean;
  createdAt: string;
}

interface DraftsDb {
  drafts: GeneratedDraft[];
}

const store = new JsonStore<DraftsDb>("drafts", { drafts: [] });

export function addDraft(
  result: GenerateResult,
  images: string[],
  blogId?: string,
): GeneratedDraft {
  const draft: GeneratedDraft = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title: result.title,
    summary: result.summary,
    content: result.content,
    rawContent: result.rawContent,
    mainKeyword: result.mainKeyword,
    blogId,
    score: result.score?.total,
    geoScore: result.geoScore?.total,
    images,
    status: "draft",
    createdAt: new Date().toISOString(),
  };
  store.update((db) => {
    db.drafts.push(draft);
    if (db.drafts.length > 500) db.drafts = db.drafts.slice(-500);
    return db;
  });
  return draft;
}

/** 이 초안의 키워드를 '쓴 것'으로 표시 (사람이 직접 올릴 초안) */
export function reserveDraftKeyword(id: string): void {
  store.update((db) => {
    const d = db.drafts.find((x) => x.id === id);
    if (d) d.keywordReserved = true;
    return db;
  });
}

/** '쓴 것'으로 표시된 초안들의 키워드와 만든 시각 — blogId 를 주면 그 블로그용 초안만 */
export function reservedDraftKeywords(blogId?: string): { keyword: string; at: number }[] {
  return store
    .read()
    .drafts.filter(
      (d) =>
        d.keywordReserved &&
        d.status === "draft" &&
        d.mainKeyword &&
        (!blogId || !d.blogId || d.blogId === blogId),
    )
    .map((d) => ({ keyword: d.mainKeyword!, at: new Date(d.createdAt).getTime() }));
}

export function markPublished(id: string, url?: string): void {
  store.update((db) => {
    const d = db.drafts.find((x) => x.id === id);
    if (d) {
      d.status = "published";
      d.publishedUrl = url;
    }
    return db;
  });
}

export function listDrafts(limit = 50): GeneratedDraft[] {
  return store.read().drafts.slice(-limit).reverse();
}

export function getDraft(id: string): GeneratedDraft | undefined {
  return store.read().drafts.find((d) => d.id === id);
}
