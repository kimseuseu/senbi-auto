import { JsonStore } from "../config/store";
import { reservedDraftKeywords } from "./drafts";
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

/**
 * 이 기록이 그 계정 것인가.
 * accountId 를 안 주면 전체(합계)를 본다. 계정을 남기지 않던 시절의 기록은 누구 것인지
 * 알 수 없어 모든 계정에 포함시킨다 — 한도를 넘기는 쪽보다 덜 하는 쪽이 안전하다.
 */
function mine(a: NeighborActivity, accountId?: string): boolean {
  return !accountId || !a.accountId || a.accountId === accountId;
}

export function logActivity(a: Omit<NeighborActivity, "id" | "at"> & { at?: string }): NeighborActivity {
  const rec: NeighborActivity = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: a.at ?? new Date().toISOString(),
    accountId: a.accountId,
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

/** 오늘 해당 액션 성공 횟수 — accountId 를 주면 그 계정 것만 (일일 한도는 계정마다 따로다) */
export function todayCount(action: NeighborAction, accountId?: string): number {
  const today = todayStr();
  return activityStore
    .read()
    .activities.filter(
      (a) => a.ok && a.action === action && localDay(a.at) === today && mine(a, accountId),
    ).length;
}

/** 이 블로그에 이미 해당 액션을 한 적 있는가 (중복 방지) */
export function hasActedOn(blogId: string, action: NeighborAction, accountId?: string): boolean {
  return activityStore
    .read()
    .activities.some(
      (a) => a.ok && a.action === action && a.targetBlogId === blogId && mine(a, accountId),
    );
}

/** 최근 N일 내 이 블로그에 액션한 적 있는가 — accountId 를 주면 그 계정이 한 것만 */
export function actedRecently(
  blogId: string,
  action: NeighborAction,
  days = 7,
  accountId?: string,
): boolean {
  const cutoff = Date.now() - days * 86400_000;
  return activityStore
    .read()
    .activities.some(
      (a) =>
        a.ok &&
        a.action === action &&
        a.targetBlogId === blogId &&
        mine(a, accountId) &&
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

/**
 * 최근에 쓴 키워드 — 겹침 판정의 기준.
 *
 * withinDays 안에 쓴 것만 돌려준다. 기간을 두지 않으면 발행할수록 막히는 키워드만 쌓여
 * 결국 후보가 바닥난다(실제로 34편 만에 "쓸 수 있는 새 키워드가 없습니다"로 멈췄다).
 * 0 이하를 주면 기간 제한 없이 전부.
 *
 * 발행한 글뿐 아니라 '직접 올리려고 남겨 둔 초안'의 키워드도 포함한다 — 안 그러면
 * 자동발행을 끈 상태에서 돌릴 때마다 같은 키워드로 글을 또 만든다.
 */
export function usedKeywords(withinDays = 0, blogId?: string): string[] {
  const cutoff = withinDays > 0 ? Date.now() - withinDays * 86400_000 : 0;
  const out = keywordUses(blogId)
    .filter((u) => cutoff === 0 || u.at >= cutoff)
    .map((u) => u.keyword);
  return [...new Set(out)];
}

/**
 * 키워드를 쓴 기록 전부 (언제 썼는지 포함).
 *
 * blogId 를 주면 그 블로그에 쓴 것만 본다 — 블로그마다 따로 돌아가는 홍보 채널이라
 * 다른 블로그에 올린 제품을 이 블로그에서 못 쓰게 막을 이유가 없다.
 * 어느 블로그인지 남기지 않던 시절의 기록은 모든 블로그에 포함한다.
 */
export function keywordUses(blogId?: string): { keyword: string; at: number }[] {
  const mine = (b?: string) => !blogId || !b || b === blogId;
  const published = publishedStore
    .read()
    .posts.filter((p) => p.mainKeyword && mine(blogOf(p)))
    .map((p) => ({ keyword: p.mainKeyword!, at: new Date(p.publishedAt).getTime() }));
  return [...published, ...reservedDraftKeywords(blogId)];
}

export function recentPublished(limit = 20): PublishedPost[] {
  return publishedStore.read().posts.slice(-limit).reverse();
}

/** 지금까지 발행한 글 수 (전체) */
export function publishedCount(): number {
  return publishedStore.read().posts.length;
}

/**
 * 이 블로그에 발행한 글 (최신순).
 * blogId를 안 남기던 시절의 기록은 어느 블로그 것인지 알 수 없다 — 이 블로그 기록이
 * 하나도 없을 때만 그 옛 기록을 보여 준다(단일 계정으로 쓰던 사용자 배려).
 */
export function recentPublishedFor(blogId: string, limit = 20): PublishedPost[] {
  const all = publishedStore.read().posts;
  const mine = all.filter((p) => blogOf(p) === blogId);
  const src = mine.length > 0 ? mine : all.filter((p) => !blogOf(p));
  return src.slice(-limit).reverse();
}

/**
 * 이 글을 올린 블로그. 블로그를 따로 남기지 않던 시절의 기록은 글 주소에서 읽어 낸다
 * (https://blog.naver.com/<블로그>/…). 주소도 없으면 알 수 없다.
 */
function blogOf(p: PublishedPost): string | undefined {
  if (p.blogId) return p.blogId;
  return p.url?.match(/blog\.naver\.com\/([A-Za-z0-9_-]+)/)?.[1];
}
