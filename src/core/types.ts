// ============================================================
// 공용 타입 — senbiPost 파이프라인 타입 + 자동화 전용 타입
// ============================================================

// ---------- 글 생성 (senbiPost 이식) ----------

export interface ReferencePost {
  id: string;
  title: string;
  content: string;
  createdAt: string;
}

export interface FilterKeyword {
  id: string;
  word: string;
  replacement?: string; // 비우면 AI가 문맥에 맞게 대체
  createdAt: string;
}

export type PostType = "info" | "review" | "product";

export interface FilterHit {
  word: string;
  replacement: string;
}

export interface ScoreAxis {
  key: string;
  label: string;
  score: number;
  max: number;
  suggestion?: string;
}

export interface SenbiScore {
  total: number;
  axes: ScoreAxis[];
}

export type PipelineStage =
  | "references"
  | "generate"
  | "validate"
  | "length"
  | "originality"
  | "wrap";

/** 참고글과 얼마나 겹치는지 (유사문서 게이트 결과) */
export interface OverlapSummary {
  ratio: number; // 겹치는 문장 비율 0~1
  meanScore: number; // 문장별 최고 유사도 평균
  totalSentences: number;
  hits: { sentence: string; source: string; score: number }[];
}

export interface GenerateResult {
  title: string;
  /**
   * 글 맨 위에 놓는 핵심 요약 (검색 AI 인용용). 한 줄에 한 문장.
   * 본문과 달리 학습 블로그 문체를 따르지 않고, 줄바꿈 처리도 하지 않는다.
   */
  summary?: string;
  content: string; // 줄바꿈 처리 완료된 최종 본문
  rawContent: string; // 줄바꿈 처리 전 본문
  headings?: string[]; // 섹션 소제목 줄들 (본문과 일치) — 소제목/인용구 재현용
  charCount: number;
  charCountWithSpaces: number;
  replacedWords: FilterHit[];
  remainingFilterWords: string[];
  usedReferences: string[];
  /** 참고글과의 문장 겹침 검사 결과 */
  overlap?: OverlapSummary;
  /** 겹침이 허용치 이하인지 — false면 발행하지 않고 초안으로만 남긴다 */
  overlapOk?: boolean;
  postType: PostType;
  mainKeyword?: string;
  subKeywords?: string[];
  score?: SenbiScore;
  geoScore?: SenbiScore;
}

// ---------- 크롤링 ----------

/** RSS에서 얻은 글 목록 항목 */
export interface RssPost {
  title: string;
  logNo: string;
  pubDate?: string;
}

export interface BlogRss {
  blogId: string;
  blogTitle: string;
  posts: RssPost[];
}

/** 네이버 인용구 스타일 — 원문 `se-l-quotation_*` / 툴바 `se-toolbar-option-insert-quotation-*` 토큰과 1:1 */
export type QuoteStyle =
  | "default" // 따옴표
  | "line" // 버티컬 라인
  | "bubble" // 말풍선
  | "underline" // 라인&따옴표
  | "postit" // 포스트잇
  | "corner"; // 프레임

/** 글자 서식 (원문에서 학습해 그대로 재현) */
export interface BlockStyle {
  font?: string; // se-ff-* (예: nanumbarungothic)
  size?: string; // se-fs-* (예: fs19)
  color?: string; // #rrggbb
  bold?: boolean;
  italic?: boolean;
}

/**
 * 한 문단 안에서 서식이 같은 글자 조각.
 *
 * 원문은 "각종 집기 렌탈 전문 MBC렌탈입니다." 처럼 **한 줄 안에서 상호명만 색이 다른**
 * 경우가 흔하다. 문단 단위 style만으로는 이걸 재현할 수 없어서 조각 단위로 따로 담는다.
 */
export interface TextRun {
  text: string;
  style?: BlockStyle;
}

/** 본문을 문서 순서대로 표현한 블록 (서명 감지·복사·구조 재현용) */
export type ContentBlock =
  | { type: "text"; text: string; style?: BlockStyle; runs?: TextRun[] }
  | { type: "heading"; text: string; style?: BlockStyle; runs?: TextRun[] } // 소제목 (se-section-sectionTitle)
  | { type: "quote"; text: string; style: QuoteStyle; textStyle?: BlockStyle; runs?: TextRun[] } // 인용구 (se-quotation)
  | { type: "oglink"; url: string; title?: string } // 링크 카드 (se-oglink)
  | { type: "image"; url: string };

/** 크롤링해 본문·이미지까지 채운 글 */
export interface CrawledPost {
  blogId: string;
  logNo: string;
  url: string;
  title: string;
  text: string;
  images: string[]; // 원본 이미지 URL
  blocks: ContentBlock[]; // 텍스트·이미지 문서 순서
  charCount: number;
}

// ---------- 이미지 자산 ----------

export interface ImageAsset {
  /** 처리된 이미지의 로컬 경로 */
  path: string;
  /** 출처 (crawl:URL 또는 myFolder:파일명) */
  source: string;
  width: number;
  height: number;
}

/** 준비 완료된 서명 블록 (순서대로 발행에 삽입) */
export type PreparedSignatureBlock =
  | { type: "text"; text: string; style?: BlockStyle; runs?: TextRun[] } // 원문의 색·굵기까지 재현
  | { type: "oglink"; url: string; title?: string } // 링크 카드 (URL 입력 후 카드만 남김)
  | { type: "image"; image: ImageAsset };
export type PreparedSignature = PreparedSignatureBlock[];

// ---------- 자동화 작업/결과 ----------

export type JobKind = "post" | "neighbor";
export type JobStatus = "pending" | "running" | "done" | "error";

export interface JobRecord {
  id: string;
  kind: JobKind;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  /** 산출물 요약 (발행 URL, 처리한 이웃 수 등) */
  summary?: string;
}

/** 발행된 글 기록 */
export interface PublishedPost {
  id: string;
  title: string;
  url?: string;
  /** 발행한 블로그 아이디 (다계정 구분 — 예전 기록엔 없다) */
  blogId?: string;
  mainKeyword?: string;
  publishedAt: string;
  imageCount: number;
}

/** 이웃 관리 활동 로그 (일일 한도 계산·중복 방지에 사용) */
export type NeighborAction = "comment" | "like" | "buddy-request";

export interface NeighborActivity {
  id: string;
  /** 어느 계정으로 한 활동인지 (일일 한도·중복 방지는 계정마다 따로 — 예전 기록엔 없다) */
  accountId?: string;
  action: NeighborAction;
  targetBlogId: string;
  targetLogNo?: string;
  message?: string; // 댓글·서로이웃 문구
  at: string; // ISO
  ok: boolean;
  error?: string;
}
