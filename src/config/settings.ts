import { JsonStore } from "./store";
import type { FilterKeyword } from "../core/types";
import type { Visibility } from "../naver/publish";
import { normalizeBlogId, isValidBlogId } from "../crawl/rss";

export type ImageSource = "crawl" | "myFolder";

export interface Settings {
  // --- AI ---
  anthropicApiKey: string; // .env 값이 있으면 그쪽이 우선
  model: string; // 기본 claude-opus-4-8

  // --- 대상 블로그 ---
  /** 발행 대상 블로그 아이디 = 로그인한 계정의 블로그 (여기에 글이 올라감) */
  blogId: string;
  /** 학습 대상 블로그 아이디 (문체·이미지를 크롤해 학습). 비우면 blogId로 학습 */
  learnBlogId: string;
  /** 선택된 학습 템플릿 id (있으면 크롤 대신 이 템플릿으로 생성) */
  activeTemplateId: string;
  brandName: string; // 자기소개 시 쓸 이름 (참고글 상호 복사 방지)

  // --- 글 생성 ---
  topicKeywords: string[]; // 이 키워드들을 돌아가며 글 생성
  /** 주제 키워드를 AI가 자동 선정 (발행 블로그 최근 글과 안 겹치게). 실패 시 topicKeywords로 폴백 */
  autoKeyword: boolean;
  postType: PostTypeSetting;
  lineWidth: number; // 모바일 줄바꿈 폭
  crawlCount: number; // 학습용으로 크롤링할 글 수 (기본 20)
  filters: FilterKeyword[];

  // --- 이미지 ---
  imageSources: ImageSource[]; // ["crawl", "myFolder"]
  imagesPerPost: number; // 글당 삽입 이미지 수
  filterStrength: number; // 0(원본)~1(강함). 약하게 = 0.2 권장

  // --- 발행 ---
  // 예약 실행은 없다. 사용자가 '오늘 작업 시작'을 누를 때만 돈다.
  autoPublish: boolean; // 생성 후 자동 발행 여부 (false면 로컬 초안만)
  postVisibility: Visibility; // 자동 발행 공개 범위 (all/neighbor/both/private)
  postCategory: string; // 발행할 블로그 카테고리 이름 (비우면 블로그 기본값)
  postsPerRun: number; // 1회 실행 시 생성·발행할 글 수
  /**
   * 같은 키워드를 다시 쓰기까지 두는 간격(일). 이 기간이 지난 키워드는 다시 후보가 된다.
   * 이 앱은 자사 제품을 되풀이해 홍보하는 데 쓰므로 같은 제품을 한 달에 두세 번 올리는 게 정상이다
   * → 기본 10일. 0이면 기간 제한 없이 영영 다시 쓰지 않는다(후보가 바닥난다).
   */
  keywordReuseDays: number;
  /** 글 맨 위(썸네일보다 위)에 핵심 요약을 넣을지 — 검색 AI가 인용하기 쉽게 */
  aiSummary: boolean;

  // --- 이웃 관리 ---
  neighbor: NeighborSettings;
}

type PostTypeSetting = "info" | "review" | "product";

export interface NeighborSettings {
  enabled: boolean;
  // 이웃 소통 (기존 이웃 블로그 방문 → 공감 + 댓글)
  dailyLikeLimit: number;
  dailyCommentLimit: number;
  // 서로이웃 신청 (주제 키워드로 블로그 탐색 → 신청)
  buddyRequestEnabled: boolean;
  dailyBuddyRequestLimit: number;
  buddyTopicKeywords: string[]; // 서로이웃 대상 탐색 키워드
  // 사람처럼 보이기 위한 랜덤 지연 (초)
  minDelaySec: number;
  maxDelaySec: number;
}

export const DEFAULT_MODEL = "claude-opus-4-8";

export const DEFAULT_SETTINGS: Settings = {
  anthropicApiKey: "",
  model: DEFAULT_MODEL,

  blogId: "",
  learnBlogId: "",
  activeTemplateId: "",
  brandName: "",

  topicKeywords: [],
  autoKeyword: true,
  postType: "info",
  lineWidth: 23,
  crawlCount: 20,
  filters: [],

  imageSources: ["crawl", "myFolder"],
  imagesPerPost: 10,
  filterStrength: 0.2,

  autoPublish: false, // 안전 기본값: 처음엔 자동발행 끔
  postVisibility: "private", // 안전 기본값: 비공개 (테스트 후 전체공개로 변경)
  postCategory: "",
  postsPerRun: 1,
  keywordReuseDays: 10,
  aiSummary: true,

  neighbor: {
    enabled: false,
    dailyLikeLimit: 50,
    dailyCommentLimit: 20,
    buddyRequestEnabled: false,
    dailyBuddyRequestLimit: 30,
    buddyTopicKeywords: [],
    minDelaySec: 8,
    maxDelaySec: 25,
  },
};

const store = new JsonStore<Settings>("settings", DEFAULT_SETTINGS);

/**
 * 예약 실행이 있던 시절의 cron 값(postSchedule / neighbor.schedule)을 걷어낸다.
 * 이제 작업은 '오늘 작업 시작' 버튼으로만 도는데, 파일에 남아 있으면
 * 아직 예약이 걸린 것처럼 보여 헷갈린다.
 */
function stripLegacySchedule<T extends object>(s: T): T {
  const { postSchedule: _p, neighbor, ...rest } = s as T & {
    postSchedule?: unknown;
    neighbor?: Record<string, unknown>;
  };
  if (!neighbor) return rest as T;
  const { schedule: _n, ...nb } = neighbor;
  return { ...rest, neighbor: nb } as T;
}

/** 저장된 설정을 기본값과 병합해 반환 (필드 누락 방지) */
export function getSettings(): Settings {
  const saved = stripLegacySchedule(store.read());
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    neighbor: { ...DEFAULT_SETTINGS.neighbor, ...(saved.neighbor ?? {}) },
  };
}

export function saveSettings(patch: Partial<Settings>): Settings {
  return store.update((draft) => {
    const base = stripLegacySchedule(draft);
    const next = stripLegacySchedule(patch);
    return {
      ...base,
      ...next,
      neighbor: { ...base.neighbor, ...(next.neighbor ?? {}) },
    };
  });
}

// ---------- 입력 검증 ----------
// 대시보드 API 로 들어온 값은 그대로 저장하지 않는다. 모르는 필드는 버리고,
// 숫자는 범위 안으로 맞추고, 고를 수 있는 값이 정해진 필드는 그 안에서만 받는다.

const VISIBILITIES: readonly Visibility[] = ["all", "neighbor", "both", "private"];
const POST_TYPES: readonly PostTypeSetting[] = ["info", "review", "product"];
const IMAGE_SOURCES: readonly ImageSource[] = ["crawl", "myFolder"];

export function isVisibility(v: unknown): v is Visibility {
  return VISIBILITIES.includes(v as Visibility);
}

/** 숫자로 읽어 범위 안으로 맞춘다. 숫자가 아니면 undefined (= 그 필드는 건드리지 않는다) */
export function cleanNumber(
  v: unknown,
  min: number,
  max: number,
  integer = true,
): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  const clamped = Math.min(max, Math.max(min, n));
  return integer ? Math.round(clamped) : clamped;
}

export function cleanString(v: unknown, maxLen = 200): string | undefined {
  return typeof v === "string" ? v.trim().slice(0, maxLen) : undefined;
}

export function cleanStringList(v: unknown, maxItems = 300): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, maxItems);
}

/** undefined 인 칸은 빼고 돌려준다 (patch 에 undefined 가 섞이면 기존 값을 지운다) */
function compact<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function sanitizeNeighborPatch(v: unknown): Partial<NeighborSettings> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const n = v as Record<string, unknown>;
  const bool = (x: unknown) => (typeof x === "boolean" ? x : undefined);
  return compact<Partial<NeighborSettings>>({
    enabled: bool(n.enabled),
    dailyLikeLimit: cleanNumber(n.dailyLikeLimit, 0, 200),
    dailyCommentLimit: cleanNumber(n.dailyCommentLimit, 0, 100),
    buddyRequestEnabled: bool(n.buddyRequestEnabled),
    dailyBuddyRequestLimit: cleanNumber(n.dailyBuddyRequestLimit, 0, 100),
    buddyTopicKeywords: cleanStringList(n.buddyTopicKeywords, 50),
    minDelaySec: cleanNumber(n.minDelaySec, 1, 600),
    maxDelaySec: cleanNumber(n.maxDelaySec, 1, 600),
  });
}

function cleanFilters(v: unknown): FilterKeyword[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: FilterKeyword[] = [];
  for (const raw of v.slice(0, 300)) {
    if (!raw || typeof raw !== "object") continue;
    const f = raw as Record<string, unknown>;
    const word = cleanString(f.word, 60);
    if (!word) continue;
    out.push({
      id: cleanString(f.id, 60) || `${Date.now()}-${out.length}`,
      word,
      replacement: cleanString(f.replacement, 60) || undefined,
      createdAt: cleanString(f.createdAt, 40) || new Date().toISOString(),
    });
  }
  return out;
}

/**
 * 블로그 아이디 칸 — 비우는 것은 허용, 채웠으면 아이디 형식이어야 한다.
 * (URL 을 통째로 붙여 넣어도 아이디만 뽑아 저장한다)
 */
function cleanBlogId(v: unknown, label: string): { value?: string; error?: string } {
  if (typeof v !== "string") return {};
  if (!v.trim()) return { value: "" };
  const id = normalizeBlogId(v);
  if (!isValidBlogId(id)) {
    return { error: `${label} 형식이 올바르지 않습니다(영문·숫자·-·_ 만 가능).` };
  }
  return { value: id };
}

export type Sanitized<T> = { ok: true; patch: Partial<T> } | { ok: false; error: string };

export function sanitizeSettingsPatch(input: unknown): Sanitized<Settings> {
  if (!input || typeof input !== "object") return { ok: false, error: "설정 값이 비어 있습니다." };
  const p = input as Record<string, unknown>;
  const bool = (x: unknown) => (typeof x === "boolean" ? x : undefined);

  const blogId = cleanBlogId(p.blogId, "발행 대상 블로그 아이디");
  if (blogId.error) return { ok: false, error: blogId.error };
  const learnBlogId = cleanBlogId(p.learnBlogId, "학습 대상 블로그 아이디");
  if (learnBlogId.error) return { ok: false, error: learnBlogId.error };

  const sources = Array.isArray(p.imageSources)
    ? IMAGE_SOURCES.filter((s) => (p.imageSources as unknown[]).includes(s))
    : undefined;

  return {
    ok: true,
    patch: compact<Partial<Settings>>({
      // 빈 문자열이면 기존 키·모델을 지키려고 아예 뺀다
      anthropicApiKey: cleanString(p.anthropicApiKey, 300) || undefined,
      model: cleanString(p.model, 80) || undefined,
      blogId: blogId.value,
      learnBlogId: learnBlogId.value,
      activeTemplateId: cleanString(p.activeTemplateId, 120),
      brandName: cleanString(p.brandName, 60),
      topicKeywords: cleanStringList(p.topicKeywords),
      autoKeyword: bool(p.autoKeyword),
      postType: POST_TYPES.includes(p.postType as PostTypeSetting)
        ? (p.postType as PostTypeSetting)
        : undefined,
      lineWidth: cleanNumber(p.lineWidth, 10, 60),
      crawlCount: cleanNumber(p.crawlCount, 1, 50),
      filters: cleanFilters(p.filters),
      imageSources: sources,
      imagesPerPost: cleanNumber(p.imagesPerPost, 0, 30),
      filterStrength: cleanNumber(p.filterStrength, 0, 1, false),
      autoPublish: bool(p.autoPublish),
      postVisibility: isVisibility(p.postVisibility) ? p.postVisibility : undefined,
      postCategory: cleanString(p.postCategory, 60),
      postsPerRun: cleanNumber(p.postsPerRun, 1, 20),
      keywordReuseDays: cleanNumber(p.keywordReuseDays, 0, 3650),
      aiSummary: bool(p.aiSummary),
      neighbor: sanitizeNeighborPatch(p.neighbor) as NeighborSettings | undefined,
    }),
  };
}

/** 실제로 사용할 API 키 (env 우선) */
export function resolveApiKey(s: Settings = getSettings()): string {
  return (process.env.ANTHROPIC_API_KEY?.trim() || s.anthropicApiKey || "").trim();
}
