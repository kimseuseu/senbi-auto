import { JsonStore } from "../config/store";
import type { GenerateResult } from "./types";

export interface GeneratedDraft {
  id: string;
  title: string;
  content: string; // 줄바꿈 적용본
  rawContent: string;
  mainKeyword?: string;
  score?: number;
  geoScore?: number;
  images: string[]; // 로컬 파일 경로
  status: "draft" | "published";
  publishedUrl?: string;
  createdAt: string;
}

interface DraftsDb {
  drafts: GeneratedDraft[];
}

const store = new JsonStore<DraftsDb>("drafts", { drafts: [] });

export function addDraft(
  result: GenerateResult,
  images: string[],
): GeneratedDraft {
  const draft: GeneratedDraft = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title: result.title,
    content: result.content,
    rawContent: result.rawContent,
    mainKeyword: result.mainKeyword,
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
