import { JsonStore } from "./store";
import type { FilterKeyword } from "../core/types";
import type { Visibility } from "../naver/publish";

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

/** 실제로 사용할 API 키 (env 우선) */
export function resolveApiKey(s: Settings = getSettings()): string {
  return (process.env.ANTHROPIC_API_KEY?.trim() || s.anthropicApiKey || "").trim();
}
