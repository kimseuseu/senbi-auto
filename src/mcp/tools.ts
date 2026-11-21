import sharp from "sharp";
import { getSettings, resolveApiKey, isVisibility, type Settings } from "../config/settings";
import { listAccounts, getAccount } from "../core/accounts";
import { recentPublishedFor } from "../core/activity";
import { toReferences } from "../crawl/crawler";
import { writingContext } from "../generate";
import { buildWritingGuide, finalizeDraft, LIMITS } from "../generate/pipeline";
import { assertKeywordAllowed } from "../generate/keywordPool";
import { downloadImage } from "../media/images";
import { reservedDraftKeywords, markPublished as markDraftPublished, getDraft } from "../core/drafts";
import { hasSavedSession } from "../naver/session";
import { startLogin, loginStatus, isLoginInProgress, recentOtherLogin } from "../naver/login";
import { assetJudgeCandidates, type AssetJudge } from "../run/assets";
import {
  loadLearnSource,
  selectKeywords,
  recommendReason,
  type LearnSource,
  type KeywordSelection,
} from "../run/keywordPlan";
import { finishPost, type PublishMode } from "../run/postJob";
import type { GenerateResult } from "../core/types";
import { SOCIAL_TOOLS, SOCIAL_HANDLERS } from "./socialTools";
import {
  ACCOUNT_PROP,
  exclusive,
  lock,
  text,
  json,
  error,
  str,
  resolveTarget,
  type Args,
  type Content,
  type ToolResult,
} from "./common";

const POST_PROPS = {
  accountId: ACCOUNT_PROP,
  keyword: { type: "string", description: "이 글의 메인키워드 (senbi_keywords 후보 중 하나, 글자 그대로)" },
  title: { type: "string", description: "글 제목 (메인키워드 포함)" },
  summary: {
    type: "string",
    description: "글 맨 위 핵심 요약. 3문장, 한 줄에 한 문장, 전체 120~220자.",
  },
  content: {
    type: "string",
    description:
      "본문. 문단은 빈 줄로 구분, 섹션마다 소제목 한 줄. 마크다운 없이 순수 텍스트. 줄바꿈 폭은 도구가 맞추므로 문장 중간에 줄을 바꾸지 않는다.",
  },
  headings: {
    type: "array",
    items: { type: "string" },
    description: "본문의 소제목 줄들을 본문에 쓴 그대로, 순서대로.",
  },
} as const;
const POST_REQUIRED = ["keyword", "title", "summary", "content", "headings"];

const CORE_TOOLS = [
  {
    name: "senbi_accounts",
    description:
      "등록된 네이버 블로그 계정 목록 — 블로그 아이디, 로그인 여부, 공개 범위·카테고리, 최근 올린 글. 작업을 시작할 때 먼저 부른다.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "senbi_keywords",
    description:
      "이 블로그에 지금 쓸 수 있는 키워드 후보(학습 블로그에서 수집, 발행 우선순위 순)와 추천 키워드, 최근에 쓴 키워드, 간격 때문에 제외된 키워드. 키워드는 여기 후보에서만 고른다.",
    inputSchema: {
      type: "object",
      properties: { accountId: ACCOUNT_PROP },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "senbi_brief",
    description:
      "키워드 하나로 글을 쓰기 위한 자료 — 글쓰기 지침, 문체를 배울 참고글, 쓰면 안 되는 소제목·필터 단어, 그리고 판별이 필요한 사진(첫 사진이 썸네일인지, 제품사양 표가 있는지). 받은 지침대로 글을 직접 쓴다.",
    inputSchema: {
      type: "object",
      properties: { accountId: ACCOUNT_PROP, keyword: POST_PROPS.keyword },
      required: ["keyword"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "senbi_check",
    description:
      "쓴 글을 발행 기준으로 검사한다 — 분량, 참고글과 겹치는 문장, 남은 필터 단어, 소제목 일치, 키워드 횟수, 점수. 문제가 있으면 고쳐서 다시 검사한다. 아무것도 올리지 않는다.",
    inputSchema: {
      type: "object",
      properties: POST_PROPS,
      required: POST_REQUIRED,
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "senbi_publish",
    description:
      "쓴 글을 네이버 블로그에 올린다 — 사진·썸네일·서명을 붙이고 학습 블로그의 서식대로 에디터에 입력한다. 몇 분 걸린다. mode: publish(바로 발행) / naverDraft(네이버 임시저장까지 — 사용자가 보고 직접 발행) / local(이 PC에 초안만). 실제 블로그에 글이 올라가므로 사용자가 발행을 요청했을 때만 publish 를 쓴다. 검사(senbi_check)를 통과하지 못한 글은 올리지 않는다.",
    inputSchema: {
      type: "object",
      properties: {
        ...POST_PROPS,
        mode: { type: "string", enum: ["publish", "naverDraft", "local"] },
        visibility: {
          type: "string",
          enum: ["all", "neighbor", "both", "private"],
          description: "공개 범위. 생략하면 계정 설정을 따른다. private = 비공개(시험 발행용).",
        },
        firstImageIsThumbnail: {
          type: "boolean",
          description:
            "senbi_brief 가 보여 준 첫 사진이 썸네일(제목 글자·로고가 얹힌 표지 카드)인지. true면 맨 위에 화질 그대로 둔다.",
        },
        specImageUrl: {
          type: "string",
          description:
            "senbi_brief 가 보여 준 사양표 후보 중 실제 제품사양 표인 사진의 URL. 없으면 생략.",
        },
        scheduledAt: {
          type: "string",
          description:
            '예약 발행 시각. 이 PC의 현지 시각으로 "2026-11-21T09:30" 꼴, 분은 10분 단위, 지금부터 30분 뒤 ~ 한 달 안. mode 가 publish 일 때만 쓴다. 주면 지금 올리지 않고 그 시각에 네이버가 올린다.',
        },
        excludeImageUrls: {
          type: "array",
          items: { type: "string" },
          description:
            "senbi_brief 가 보여 준 본문 사진 후보 중 본문에 넣으면 안 되는 사진의 URL — 배너, 상호·전화번호 카드, 로고, 글자만 있는 안내 이미지, 이 제품과 상관없는 사진.",
        },
        draftId: {
          type: "string",
          description:
            "senbi_drafts 의 초안을 다시 올리는 것이면 그 초안 id. 발행에 성공하면 그 초안을 '올린 글'로 정리한다.",
        },
        showBrowser: { type: "boolean", description: "true면 브라우저 창을 띄워 입력 과정을 보여 준다." },
      },
      required: [...POST_REQUIRED, "mode"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "senbi_login",
    description:
      "네이버 로그인 창을 이 PC 화면에 띄운다(앱을 열 필요 없다). 아이디·비밀번호·2단계 인증은 사용자가 그 창에서 직접 입력하고, 로그인이 확인되면 세션을 저장하고 창을 닫는다. 끝날 때까지(최대 5분) 기다렸다가 결과를 돌려준다. 발행이 '세션 만료'로 막혔거나 loggedIn 이 false 일 때 쓴다. 부르기 전에 사용자에게 창이 뜬다고 알린다.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: ACCOUNT_PROP,
        confirmedRecentLogin: {
          type: "boolean",
          description:
            "6시간 안에 다른 계정이 로그인했다는 경고를 받은 뒤, 사용자가 그래도 하겠다고 했을 때만 true.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
] as const;

export const TOOLS = [...CORE_TOOLS, ...SOCIAL_TOOLS];

// ---------- 공통 ----------

/** 학습 자료 + 키워드 후보 + (키워드를 주면) 그 키워드를 써도 되는지 */
async function plan(
  settings: Settings,
  keyword?: string,
): Promise<{ src: LearnSource; sel: KeywordSelection }> {
  if (!settings.blogId) throw new Error("발행 대상 블로그 아이디가 설정되지 않았습니다.");
  const src = await loadLearnSource(settings);
  if (src.posts.length === 0) {
    throw new Error(
      `학습 블로그(${src.learnFrom})에서 참고글을 가져오지 못했습니다. 앱의 상세 설정에서 블로그를 학습해 주세요.`,
    );
  }
  const sel = await selectKeywords(settings, src);
  if (keyword !== undefined) {
    // 임시저장·초안으로 남긴 글의 키워드는 '쓴 것'으로 잡혀 있다(자동 선정이 또 고르지 않게).
    // 그런데 그 글을 확인하고 발행하려는 것까지 막으면 naverDraft → publish 흐름이 끊긴다.
    // 실제로 발행한 기록이 재사용 간격 안에 없다면, 같은 키워드의 초안 예약은 걸림돌로 치지 않는다.
    const reuseDays = Math.max(0, settings.keywordReuseDays ?? 10);
    const cutoff = reuseDays > 0 ? Date.now() - reuseDays * 86400_000 : 0;
    const publishedRecently = recentPublishedFor(settings.blogId, 500).some(
      (p) => p.mainKeyword === keyword && new Date(p.publishedAt).getTime() >= cutoff,
    );
    const onlyDrafted =
      !publishedRecently && reservedDraftKeywords(settings.blogId).some((d) => d.keyword === keyword);
    const used = onlyDrafted ? sel.used.filter((k) => k !== keyword) : sel.used;
    const gate = assertKeywordAllowed(keyword, sel.pool, used, sel.publishedTitles);
    if (!gate.ok) throw new Error(`이 키워드는 쓸 수 없습니다 — ${gate.error}`);
  }
  return { src, sel };
}

/** 글쓰기 입력 — 지침을 만들 때와 검사할 때 같은 값을 쓴다 */
function writingInput(settings: Settings, src: LearnSource, keyword: string) {
  return {
    mainKeyword: keyword,
    ...writingContext(settings, keyword),
    references: toReferences(src.posts),
    filters: settings.filters ?? [],
    lineWidth: settings.lineWidth,
    postType: settings.postType,
    instructions: src.instructions,
  };
}

interface Checked {
  result: GenerateResult;
  /** 발행을 막는 문제 */
  blockers: string[];
  /** 고치면 좋은 것 */
  warnings: string[];
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

/** 클로드가 쓴 글을 앱이 만든 글과 같은 기준으로 마무리·검사한다 */
function checkPost(settings: Settings, src: LearnSource, a: Args): Checked {
  const keyword = str(a.keyword);
  const title = str(a.title);
  const content = typeof a.content === "string" ? a.content.trim() : "";
  const headings = Array.isArray(a.headings) ? a.headings.map(str).filter(Boolean) : [];
  if (!title || !content) throw new Error("제목과 본문이 필요합니다.");

  const input = writingInput(settings, src, keyword);
  const { usedRefs } = buildWritingGuide(input);
  const result = finalizeDraft(
    { title, summary: str(a.summary), content, headings },
    { ...input, usedRefs },
  );

  const blockers: string[] = [];
  const warnings: string[] = [];

  if (result.charCount < LIMITS.HARD_MIN || result.charCount > LIMITS.HARD_MAX) {
    blockers.push(
      `본문이 공백 제외 ${result.charCount}자입니다. ${LIMITS.TARGET_MIN}~${LIMITS.TARGET_MAX}자로 ${result.charCount < LIMITS.HARD_MIN ? "늘려" : "줄여"} 주세요.`,
    );
  }
  if (result.overlap && !result.overlapOk) {
    const pct = Math.round(result.overlap.ratio * 100);
    blockers.push(
      `참고글과 겹치는 문장이 ${pct}%입니다(허용 ${Math.round(LIMITS.OVERLAP_LIMIT * 100)}%). overlapHits 의 문장을 단어만 바꾸지 말고 어순·서술 각도를 바꿔 새로 쓰세요.`,
    );
  }
  if (result.remainingFilterWords.length > 0) {
    blockers.push(`필터 단어가 남아 있습니다: ${result.remainingFilterWords.join(", ")}`);
  }

  const lines = result.rawContent.split("\n").map((l) => l.trim());
  // 발행할 때 본문은 빈 줄로 나눈 '문단' 단위로 들어간다. 소제목 아래에 빈 줄 없이 본문을 이어 쓰면
  // 소제목이 문단의 첫 줄이 되어 버려 서식(소제목·인용구)이 입혀지지 않는다.
  const paragraphs = result.rawContent.split(/\n\s*\n/).map((p) => p.trim());
  const missing = (result.headings ?? []).filter((h) => !paragraphs.includes(h));
  if (missing.length > 0) {
    blockers.push(
      `headings 의 소제목이 본문에 '혼자 있는 줄'로 없습니다(글자 그대로 일치하고, 위아래를 빈 줄로 띄워야 함): ${missing.join(" / ")}`,
    );
  }
  if ((result.headings ?? []).length < 3) {
    warnings.push("소제목이 3개 미만입니다. 글을 3~6개 섹션으로 나누고 섹션마다 소제목 한 줄을 두세요.");
  }
  const listLines = lines.filter((l) => /^(?:\d+[.)]|[-•*])\s+/.test(l));
  if (listLines.length > 0) {
    blockers.push(
      `번호·기호로 시작하는 줄이 있습니다(네이버 에디터가 목록으로 바꿉니다). 문장으로 풀어 쓰세요: "${listLines[0]!.slice(0, 30)}"`,
    );
  }
  if (/^#{1,6}\s|\*\*/m.test(result.rawContent)) blockers.push("마크다운 문법(#, **)이 남아 있습니다.");

  const inTitle = countOccurrences(title, keyword);
  const inBody = countOccurrences(result.rawContent, keyword);
  if (inTitle < 1) blockers.push(`제목에 메인키워드 "${keyword}" 가 글자 그대로 들어가야 합니다.`);
  if (inBody < 4 || inBody > 6) {
    warnings.push(`본문에 메인키워드가 ${inBody}회 나옵니다. 4~6회가 적당합니다.`);
  }
  if (!/^Q\./m.test(result.rawContent)) {
    warnings.push('자주 묻는 질문 섹션이 없습니다. "Q. 질문?" / "A. 답변" 3쌍을 마지막에서 두 번째 섹션에 넣으세요.');
  }
  const summaryLen = (result.summary ?? "").length;
  if (settings.aiSummary !== false && (summaryLen < 100 || summaryLen > 240)) {
    warnings.push(`요약이 ${summaryLen}자입니다. 3문장 120~220자로 맞추세요.`);
  }
  if (result.charCount < LIMITS.TARGET_MIN || result.charCount > LIMITS.TARGET_MAX) {
    if (blockers.every((b) => !b.startsWith("본문이"))) {
      warnings.push(`본문 ${result.charCount}자 — 목표는 ${LIMITS.TARGET_MIN}~${LIMITS.TARGET_MAX}자입니다.`);
    }
  }
  return { result, blockers, warnings };
}

function checkView(c: Checked) {
  const { result } = c;
  const axes = (s: GenerateResult["score"]) =>
    (s?.axes ?? [])
      .filter((x) => x.suggestion)
      .map((x) => `${x.label} ${x.score}/${x.max} — ${x.suggestion}`);
  return {
    okToPublish: c.blockers.length === 0,
    blockers: c.blockers,
    warnings: c.warnings,
    charCount: result.charCount,
    overlapPercent: result.overlap ? Math.round(result.overlap.ratio * 100) : 0,
    overlapHits: (result.overlap?.hits ?? []).slice(0, 12).map((h) => ({
      mine: h.sentence,
      reference: h.source,
    })),
    senbiScore: result.score?.total,
    geoScore: result.geoScore?.total,
    suggestions: [...axes(result.score), ...axes(result.geoScore)],
  };
}

/** 사진을 클로드가 볼 수 있게 줄여서 넘긴다 */
async function preview(url: string): Promise<Content | null> {
  try {
    const jpg = await sharp(await downloadImage(url), { failOn: "none" })
      .resize(640, 640, { fit: "inside" })
      .jpeg({ quality: 78 })
      .toBuffer();
    return { type: "image", data: jpg.toString("base64"), mimeType: "image/jpeg" };
  } catch {
    return null;
  }
}

/** 사진 여러 장을 번호 붙인 한 장으로 묶는다 (한 장씩 보내는 것보다 훨씬 가볍다) */
async function contactSheet(urls: string[], startNo: number): Promise<Content | null> {
  const COLS = 4;
  const TILE = 240;
  const GAP = 6;
  const rows = Math.ceil(urls.length / COLS);
  const layers: sharp.OverlayOptions[] = [];
  for (let i = 0; i < urls.length; i++) {
    const left = GAP + (i % COLS) * (TILE + GAP);
    const top = GAP + Math.floor(i / COLS) * (TILE + GAP);
    try {
      const tile = await sharp(await downloadImage(urls[i]!), { failOn: "none" })
        .resize(TILE, TILE, { fit: "contain", background: "#ffffff" })
        .jpeg({ quality: 80 })
        .toBuffer();
      layers.push({ input: tile, left, top });
    } catch {
      /* 못 읽는 사진은 빈 칸으로 */
    }
    const badge = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="30"><rect width="44" height="30" rx="4" fill="#111"/><text x="22" y="22" font-size="19" font-family="Helvetica,Arial,sans-serif" font-weight="700" fill="#fff" text-anchor="middle">${startNo + i}</text></svg>`,
    );
    layers.push({ input: badge, left, top });
  }
  try {
    const jpg = await sharp({
      create: {
        width: GAP + COLS * (TILE + GAP),
        height: GAP + rows * (TILE + GAP),
        channels: 3,
        background: "#d9d9d9",
      },
    })
      .composite(layers)
      .jpeg({ quality: 80 })
      .toBuffer();
    return { type: "image", data: jpg.toString("base64"), mimeType: "image/jpeg" };
  } catch {
    return null;
  }
}

// ---------- 도구 ----------

async function accounts(): Promise<ToolResult> {
  const all = listAccounts();
  if (all.length === 0) {
    const s = getSettings();
    return json({
      accounts: [],
      note: s.blogId
        ? `등록된 계정이 없어 전역 설정(블로그 ${s.blogId})으로 동작합니다.`
        : "등록된 계정이 없습니다. senbiPOST 앱의 상세 설정 → 블로그 계정에서 계정을 추가하고 로그인해 주세요.",
      loggedIn: hasSavedSession(),
    });
  }
  return json({
    accounts: all.map((a) => ({
      id: a.id,
      name: a.name,
      blogId: a.blogId,
      loggedIn: hasSavedSession(a.id),
      visibility: a.postVisibility,
      category: a.postCategory || "(블로그 기본값)",
      usesProxy: Boolean(a.proxy?.trim()),
      recent: recentPublishedFor(a.blogId, 5).map((p) => ({
        title: p.title,
        keyword: p.mainKeyword ?? "",
        publishedAt: p.publishedAt,
        url: p.url,
      })),
    })),
    note: "loggedIn 은 저장된 로그인 쿠키가 있다는 뜻일 뿐, 오래되면 만료돼 있을 수 있습니다. 로그인이 필요하면 senbi_login 으로 창을 띄워 사용자가 직접 로그인하게 합니다.",
  });
}

async function keywords(a: Args): Promise<ToolResult> {
  const { acc, settings } = resolveTarget(a.accountId);
  const { src, sel } = await plan(settings);
  const rec = sel.candidates.find((c) => c.keyword === sel.recommended);
  return json({
    account: acc?.name,
    blogId: settings.blogId,
    learnedFrom: src.learnFrom,
    learnedPosts: src.posts.length,
    reuseAfterDays: settings.keywordReuseDays ?? 10,
    recommended: sel.recommended,
    recommendReason: rec ? recommendReason(rec) : "",
    candidates: sel.candidates.slice(0, 40).map((c) => ({
      keyword: c.keyword,
      hasImage: c.hasImage,
      lastUsedDays: c.lastUsedDays,
      sourceTitle: c.sourceTitle,
    })),
    blocked: sel.blocked.slice(0, 30),
    recent: recentPublishedFor(settings.blogId, 12).map((p) => ({
      keyword: p.mainKeyword ?? "",
      title: p.title,
      publishedAt: p.publishedAt,
    })),
    error: sel.error,
    note: "후보는 발행 우선순위 순(올린 적 없는 제품 → 가장 오래전에 올린 제품)입니다. hasImage 가 false 면 사진 없는 글이 됩니다.",
  });
}

async function brief(a: Args): Promise<ToolResult> {
  const keyword = str(a.keyword);
  const { acc, settings } = resolveTarget(a.accountId);
  const { src } = await plan(settings, keyword);
  const input = writingInput(settings, src, keyword);
  const { system } = buildWritingGuide(input);

  const out: Content[] = [
    text(
      `# 글쓰기 자료 — "${keyword}" → ${acc?.name ?? settings.blogId} (${settings.blogId})\n\n` +
        `아래 지침은 앱이 글을 만들 때 쓰는 것과 같다. 여기서 '너'는 이 글을 쓰는 너다.\n` +
        `- 메인키워드: ${keyword}\n- 서브키워드: ${input.subKeywords.join(", ") || "(없음)"}\n` +
        `- 줄바꿈은 도구가 모바일 폭(${settings.lineWidth}자)에 맞춘다. 문장 중간에 줄을 바꾸지 말고 문단만 빈 줄로 나눈다.\n` +
        `- 다 쓰면 senbi_check 로 검사하고, blockers 가 없어질 때까지 고친 뒤 senbi_publish 로 올린다.\n` +
        (hasSavedSession(acc?.id)
          ? ""
          : `- ⚠️ 이 계정은 네이버 로그인이 안 돼 있다. 발행 전에 senbi_login 으로 로그인 창을 띄워 사용자가 로그인하게 한다.\n`) +
        `\n---\n\n${system}`,
    ),
  ];

  // 사진 판별 — 앱은 API 비전으로 하던 일. 여기선 네가 직접 보고 senbi_publish 에 알려 준다.
  const cand = await assetJudgeCandidates(src.posts, keyword);
  if (!cand.first) {
    out.push(text("\n---\n이 키워드는 학습 블로그에 맞는 사진이 없다. 내 이미지 폴더 사진만 쓰이거나 사진 없이 올라간다."));
    return { content: out };
  }
  const first = await preview(cand.first);
  if (first) {
    out.push(
      text(
        `\n---\n# 사진 판별 (출처 글: "${cand.sourceTitle}")\n\n[첫 사진] 아래 사진이 썸네일(큰 제목 글자·로고가 얹힌 표지 카드)이면 senbi_publish 에 firstImageIsThumbnail: true, 제품·현장을 그대로 찍은 사진이면 false(그러면 본문 첫 사진으로 쓰인다). 배너·로고처럼 아예 쓰면 안 되는 사진이면 excludeImageUrls 에 이 URL 을 넣는다: ${cand.first}`,
      ),
      first,
    );
  }
  for (const url of cand.specCandidates) {
    const img = await preview(url);
    if (!img) continue;
    out.push(
      text(
        `[사양표 후보] 아래 사진이 제품사양 표(규격·치수·전력 등이 적힌 표)이면 senbi_publish 에 specImageUrl: "${url}" 로 넘긴다. 아니면 넘기지 않는다.`,
      ),
      img,
    );
  }

  // 본문 사진 — 배너·연락처 카드·로고가 글 한가운데 들어가지 않게 네가 직접 보고 거른다
  if (cand.body.length > 0) {
    out.push(
      text(
        `[본문 사진 후보 ${cand.body.length}장] 아래 번호가 붙은 사진들 중에서 본문 사진을 고른다(안 쓴 사진부터 최대 ${settings.imagesPerPost}장). ` +
          `제품·현장을 찍은 사진만 남긴다. 배너, 상호·전화번호 카드, 로고, 글자만 있는 안내 이미지, 이 제품과 상관없는 사진이 있으면 ` +
          `그 번호의 URL 을 senbi_publish 의 excludeImageUrls 에 넣는다. 하나하나 다 보고 판단한다.\n` +
          cand.body.map((u, i) => `${i + 1}: ${u}`).join("\n"),
      ),
    );
    for (let i = 0; i < cand.body.length; i += 12) {
      const sheet = await contactSheet(cand.body.slice(i, i + 12), i + 1);
      if (sheet) out.push(sheet);
    }
  }
  return { content: out };
}

async function check(a: Args): Promise<ToolResult> {
  const keyword = str(a.keyword);
  const { settings } = resolveTarget(a.accountId);
  const { src } = await plan(settings, keyword);
  return json(checkView(checkPost(settings, src, a)));
}


async function publish(a: Args): Promise<ToolResult> {
  const keyword = str(a.keyword);
  const mode = str(a.mode) as PublishMode;
  if (!["publish", "naverDraft", "local"].includes(mode)) {
    return error('mode 는 "publish" | "naverDraft" | "local" 중 하나여야 합니다.');
  }
  const target = resolveTarget(a.accountId);
  const acc = target.acc;
  const settings: Settings = isVisibility(a.visibility)
    ? { ...target.settings, postVisibility: a.visibility }
    : target.settings;

  if (mode !== "local" && !hasSavedSession(acc?.id)) {
    return error(
      "네이버 로그인 세션이 없습니다. senbi_login 으로 로그인 창을 띄워 사용자가 로그인한 뒤 다시 시도해 주세요.",
    );
  }
  let scheduleAt: Date | undefined;
  if (a.scheduledAt !== undefined && a.scheduledAt !== null && a.scheduledAt !== "") {
    // 값이 있는데 못 읽으면 반드시 멈춘다 — 조용히 무시하면 예약하려던 글이 지금 올라간다
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:00)?$/.test(str(a.scheduledAt))) {
      return error('scheduledAt 을 읽지 못했습니다. 이 PC의 현지 시각으로 "2026-11-21T09:30" 꼴로 주세요.');
    }
    if (mode !== "publish") return error("scheduledAt 은 mode 가 publish 일 때만 쓸 수 있습니다.");
    scheduleAt = new Date(str(a.scheduledAt));
    const ms = scheduleAt.getTime();
    if (Number.isNaN(ms)) return error('scheduledAt 을 읽지 못했습니다. "2026-11-21T09:30" 꼴로 주세요.');
    if (scheduleAt.getMinutes() % 10 !== 0 || scheduleAt.getSeconds() !== 0) {
      return error("예약 시각의 분은 10분 단위여야 합니다(00·10·20·30·40·50).");
    }
    // 글을 에디터에 입력하는 데만 몇 분이 걸린다 — 여유가 없으면 확정할 때 이미 시각이 지나 있다
    if (ms < Date.now() + 30 * 60_000) return error("예약 시각은 지금부터 30분 뒤 이후여야 합니다.");
    if (ms > Date.now() + 31 * 86400_000) return error("예약 시각은 한 달 안이어야 합니다.");
  }
  if (lock.busy) return error("다른 글을 올리는 중입니다. 끝난 뒤 다시 시도해 주세요.");

  lock.busy = true;
  try {
    const { src } = await plan(settings, keyword);
    const checked = checkPost(settings, src, a);
    if (checked.blockers.length > 0) {
      return {
        isError: true,
        content: [
          text(
            "검사를 통과하지 못해 올리지 않았습니다. 고친 뒤 다시 시도하세요.\n" +
              JSON.stringify(checkView(checked), null, 2),
          ),
        ],
      };
    }

    // 사진 판별은 클로드가 한 것을 쓴다. 안 알려 줬으면 API 키가 있을 때만 앱처럼 비전으로 판별한다.
    const apiKey = resolveApiKey(settings);
    const specUrl = str(a.specImageUrl);
    const judge: AssetJudge = {};
    // 판별은 senbi_brief 가 보여 준 바로 그 사진에만 적용한다 (다른 사진이 첫 자리에 오면 썸네일로 치지 않는다)
    const shown = await assetJudgeCandidates(src.posts, keyword);
    if (typeof a.firstImageIsThumbnail === "boolean" || !apiKey) {
      judge.isThumbnail = (_buf, url) => a.firstImageIsThumbnail === true && url === shown.first;
    }
    if (specUrl || !apiKey) judge.isSpecTable = (_buf, url) => url === specUrl;
    const excluded = new Set(
      Array.isArray(a.excludeImageUrls) ? a.excludeImageUrls.map(str).filter(Boolean) : [],
    );
    // 보여 준 적 없는 사진은 쓰지 않는다 — 클로드가 보지 않은 사진이 판별 없이 들어가는 일을 막는다
    const seen = new Set([...(shown.first ? [shown.first] : []), ...shown.specCandidates, ...shown.body]);
    judge.exclude = (url) => excluded.has(url) || (seen.size > 0 && !seen.has(url));

    const r = await finishPost({
      settings,
      src,
      keyword,
      result: checked.result,
      apiKey,
      accountId: acc?.id,
      headless: a.showBrowser !== true,
      mode,
      scheduleAt,
      judge,
    });

    const base = {
      title: checked.result.title,
      blogId: settings.blogId,
      account: acc?.name,
      images: r.draft?.images.length ?? 0,
      draftId: r.draft?.id,
    };
    if (!r.ok) return error(`올리지 못했습니다 — ${r.error ?? "알 수 없는 오류"}`);
    // 예전 초안을 다시 올린 것이면 그 초안은 더 이상 '올릴 글'이 아니다
    const oldDraft = str(a.draftId);
    if ((r.published || r.scheduledAt) && oldDraft && oldDraft !== r.draft?.id && getDraft(oldDraft)) {
      markDraftPublished(oldDraft, r.url);
    }
    if (r.published) return json({ status: "published", url: r.url, visibility: settings.postVisibility, ...base });
    if (r.scheduledAt) {
      return json({
        status: "scheduled",
        scheduledAt: new Date(r.scheduledAt).toLocaleString("ko-KR"),
        visibility: settings.postVisibility,
        note: "네이버에 예약 발행으로 등록했습니다. 그 시각에 네이버가 올립니다. 취소·변경은 블로그 글쓰기 화면의 예약 글 목록에서 합니다.",
        ...base,
      });
    }
    if (r.naverDraft) {
      return json({
        status: "savedToNaverDrafts",
        note: "네이버 임시저장함에 저장했습니다. 블로그 글쓰기 화면의 '저장' 목록에서 확인하고 발행할 수 있습니다.",
        ...base,
      });
    }
    if (mode === "local") {
      return json({ status: "savedLocally", note: "이 PC에 초안으로만 저장했습니다(앱의 초안 목록).", ...base });
    }
    return {
      isError: true,
      content: [
        text(
          `발행하지 못했습니다 — ${r.error ?? "알 수 없는 이유"}\n글은 이 PC에 초안으로 남아 있습니다(${r.draft?.id ?? ""}).` +
            (/세션|로그인/.test(r.error ?? "")
              ? "\n앱을 열 필요는 없습니다 — senbi_login 으로 로그인 창을 띄워 사용자가 로그인한 뒤 같은 글로 다시 senbi_publish 하세요."
              : ""),
        ),
      ],
    };
  } finally {
    lock.busy = false;
  }
}

const LOGIN_GAP_MS = 6 * 60 * 60 * 1000;

async function login(a: Args): Promise<ToolResult> {
  const { acc } = resolveTarget(a.accountId);
  if (!acc) {
    return error("등록된 계정이 없습니다. 계정을 먼저 등록해야 로그인할 수 있습니다.");
  }
  if (isLoginInProgress(acc.id)) return error("이 계정의 로그인 창이 이미 열려 있습니다.");

  // 같은 PC에서 여러 아이디를 잇달아 로그인하면 한꺼번에 보호조치에 걸릴 수 있다 (2026-09-30 실측)
  const recent = recentOtherLogin(acc.id, LOGIN_GAP_MS);
  if (recent && a.confirmedRecentLogin !== true) {
    const other = getAccount(recent.accountId)?.name ?? recent.accountId;
    const minutes = Math.max(1, Math.round((Date.now() - Date.parse(recent.at)) / 60000));
    return error(
      `${minutes}분 전에 "${other}" 계정이 이 PC에서 로그인했습니다. 같은 PC에서 여러 아이디를 잇달아 로그인하면 ` +
        `네이버가 그 아이디들을 한꺼번에 보호조치할 수 있습니다(2026-09-30 실제 발생). 6시간 이상 간격을 두는 것이 안전합니다. ` +
        `사용자에게 이 내용을 알리고, 그래도 지금 하겠다고 하면 confirmedRecentLogin: true 로 다시 부르세요.`,
    );
  }

  // 로그인 창이 떠 있는 동안 발행·이웃 관리가 같은 브라우저 프로필을 열면 둘 다 깨진다
  return exclusive(async () => {
    await startLogin(acc.id, acc.blogId); // 창이 닫힐 때까지 기다린다 (성공·시간 초과·보호조치)
    const st = loginStatus(acc.id);
    const view = { account: acc.name, blogId: acc.blogId, status: st.status, message: st.message };
    return st.status === "success"
      ? json(view)
      : { isError: true, content: [text(JSON.stringify(view, null, 2))] };
  });
}

const HANDLERS: Record<string, (a: Args) => Promise<ToolResult>> = {
  senbi_accounts: accounts,
  senbi_keywords: keywords,
  senbi_brief: brief,
  senbi_check: check,
  senbi_publish: publish,
  senbi_login: login,
  ...SOCIAL_HANDLERS,
};

export async function callTool(name: string, args: Args): Promise<ToolResult> {
  const fn = HANDLERS[name];
  if (!fn) return error(`없는 도구: ${name}`);
  try {
    return await fn(args);
  } catch (err) {
    return error(err instanceof Error ? err.message : String(err));
  }
}
