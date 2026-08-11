import { JsonStore } from "../config/store";
import type { NeighborActivity, NeighborAction, PublishedPost } from "./types";

// ---------- 이웃 활동 로그 ----------

interface ActivityDb {
  activities: NeighborActivity[];
}

const activityStore = new JsonStore<ActivityDb>("activity", { activities: [] });

function localDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA"); // YYYY-MM-DD (로컬 tz)
}

function todayStr(): string {
  return new Date().toLocaleDateString("en-CA");
}

export function logActivity(a: Omit<NeighborActivity, "id" | "at"> & { at?: string }): NeighborActivity {
  const rec: NeighborActivity = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: a.at ?? new Date().toISOString(),
    action: a.action,
    targetBlogId: a.targetBlogId,
    targetLogNo: a.targetLogNo,
    message: a.message,
    ok: a.ok,
    error: a.error,
  };
  activityStore.update((db) => {
    db.activities.push(rec);
    // 최근 5000건만 유지
    if (db.activities.length > 5000) db.activities = db.activities.slice(-5000);
    return db;
  });
  return rec;
}

/** 오늘 해당 액션 성공 횟수 */
export function todayCount(action: NeighborAction): number {
  const today = todayStr();
  return activityStore
    .read()
    .activities.filter((a) => a.ok && a.action === action && localDay(a.at) === today)
    .length;
}

/** 이 블로그에 이미 해당 액션을 한 적 있는가 (중복 방지) */
export function hasActedOn(blogId: string, action: NeighborAction): boolean {
  return activityStore
    .read()
    .activities.some((a) => a.ok && a.action === action && a.targetBlogId === blogId);
}

/** 최근 N일 내 이 블로그에 액션한 적 있는가 */
export function actedRecently(blogId: string, action: NeighborAction, days = 7): boolean {
  const cutoff = Date.now() - days * 86400_000;
  return activityStore
    .read()
    .activities.some(
      (a) =>
        a.ok &&
        a.action === action &&
        a.targetBlogId === blogId &&
        new Date(a.at).getTime() >= cutoff,
    );
}

// ---------- 발행 글 기록 ----------

interface PublishedDb {
  posts: PublishedPost[];
}

const publishedStore = new JsonStore<PublishedDb>("published", { posts: [] });

export function logPublished(p: Omit<PublishedPost, "id">): PublishedPost {
  const rec: PublishedPost = { id: `${Date.now()}`, ...p };
  publishedStore.update((db) => {
    db.posts.push(rec);
    return db;
  });
  return rec;
}

export function usedKeywords(): string[] {
  return publishedStore
    .read()
    .posts.map((p) => p.mainKeyword)
    .filter((k): k is string => Boolean(k));
}

export function recentPublished(limit = 20): PublishedPost[] {
  return publishedStore.read().posts.slice(-limit).reverse();
}

/**
 * 이 블로그에 발행한 글 (최신순).
 * blogId를 안 남기던 시절의 기록은 어느 블로그 것인지 알 수 없다 — 이 블로그 기록이
 * 하나도 없을 때만 그 옛 기록을 보여 준다(단일 계정으로 쓰던 사용자 배려).
 */
export function recentPublishedFor(blogId: string, limit = 20): PublishedPost[] {
  const all = publishedStore.read().posts;
  const mine = all.filter((p) => p.blogId === blogId);
  const src = mine.length > 0 ? mine : all.filter((p) => !p.blogId);
  return src.slice(-limit).reverse();
}
