import {
  logActivity,
  todayCount,
  actedRecently,
  actedOnPost,
  lastActivityAt,
  recentPublishedFor,
} from "../core/activity";
import { listDrafts, getDraft } from "../core/drafts";
import { fetchPostContent } from "../crawl/post";
import { fetchBlogRss } from "../crawl/rss";
import {
  fetchNeighborFeed,
  engageOne,
  searchBlogsByTopic,
  sendBuddyRequest,
} from "../naver/neighbor";
import { launchContext, isLoggedIn, closeContext, hasSavedSession } from "../naver/session";
import { markSessionInvalid, markSessionValid } from "../naver/sessionState";
import { listNaverTempDrafts, deletePost } from "../naver/manage";
import type { BrowserContext } from "playwright";
import type { Account } from "../core/accounts";
import {
  ACCOUNT_PROP,
  exclusive,
  json,
  error,
  str,
  resolveTarget,
  type Args,
  type ToolResult,
} from "./common";

/**
 * 이웃 관리 · 글 관리 도구.
 *
 * 앱의 이웃 관리는 '한 번 누르면 한도까지 알아서 도는' 방식이다. 여기서는 클로드가 목록을 보여 주고
 * 사용자가 고른 글에만, **한 건씩** 한다. 댓글·신청 문구는 클로드가 그 글을 읽고 직접 쓴다.
 * 일일 한도·중복 방지·활동 사이 간격은 앱과 같은 기록(activity.json)으로 코드가 강제한다.
 */

export const SOCIAL_TOOLS = [
  {
    name: "senbi_neighbor_posts",
    description:
      "이 계정의 이웃 새글 목록 — 글 주소, 제목, 본문 앞부분, 이 계정이 이미 공감·댓글을 했는지, 오늘 남은 한도. 아무것도 보내지 않는다. 목록을 사용자에게 보여 주고 고른 글에만 senbi_neighbor_engage 를 쓴다.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: ACCOUNT_PROP,
        limit: { type: "integer", description: "가져올 글 수 (1~20, 기본 10)" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "senbi_neighbor_engage",
    description:
      "이웃 글 하나에 공감을 누르거나 댓글을 단다(둘 다 가능). 댓글은 그 글의 본문을 읽고 네가 직접 쓴다 — 글 내용에 맞는 1~2문장, 광고·링크·상호 홍보 없이. 실제 남의 블로그에 남는 활동이므로 사용자가 고른 글에만, 한 번에 한 건씩 한다. 일일 한도를 넘거나 최근에 같은 블로그에 댓글을 단 경우에는 거부된다. 직전 활동과의 간격을 지키느라 길게는 1~2분 기다릴 수 있다.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: ACCOUNT_PROP,
        blogId: { type: "string", description: "글 주인의 블로그 아이디" },
        logNo: { type: "string", description: "글 번호" },
        like: { type: "boolean", description: "공감을 누를지" },
        comment: { type: "string", description: "달 댓글 (없으면 댓글은 달지 않는다). 300자 이내." },
      },
      required: ["blogId", "logNo", "like"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: "senbi_buddy_candidates",
    description:
      "주제로 네이버 블로그를 검색해 서로이웃 후보를 찾는다 — 블로그 아이디와 그 주제로 쓴 글 제목. 최근 30일 안에 이미 신청한 블로그는 뺀다. 아무것도 보내지 않는다. 목록을 사용자에게 보여 주고 고른 블로그에만 senbi_buddy_request 를 쓴다.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: ACCOUNT_PROP,
        query: { type: "string", description: "찾을 주제 (네이버에서 검색하듯)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "senbi_buddy_request",
    description:
      "블로그 하나에 서로이웃을 신청한다. 신청 문구는 그 블로그의 글을 보고 네가 직접 쓴다(1~2문장, 광고 없이). 상대에게 실제로 신청이 가므로 사용자가 고른 블로그에만, 한 번에 한 건씩 한다. 일일 한도를 넘거나 30일 안에 이미 신청한 블로그면 거부된다.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: ACCOUNT_PROP,
        blogId: { type: "string" },
        message: { type: "string", description: "신청 문구. 150자 이내." },
      },
      required: ["blogId", "message"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: "senbi_posts",
    description:
      "블로그에 올라가 있는 글 목록 — 공개 글은 블로그 RSS에서(제목·주소·날짜), 이 도구로 올린 글은 발행 기록에서(키워드 포함, 비공개 글도 나온다). 로그인이 필요 없다.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: ACCOUNT_PROP,
        limit: { type: "integer", description: "가져올 글 수 (1~50, 기본 20)" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "senbi_drafts",
    description:
      "이 PC에 남아 있는 초안 — 발행하다 실패했거나 local 로 저장한 글. id 를 주면 그 초안의 제목·요약·본문·소제목 전체를 돌려준다. 그대로(또는 고쳐서) senbi_publish 에 넘기면 다시 올릴 수 있다.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: ACCOUNT_PROP,
        id: { type: "string", description: "초안 id. 주면 그 초안 하나의 전체 내용." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "senbi_naver_drafts",
    description:
      "네이버 임시저장함에 있는 글 목록(제목·저장 시각). 글쓰기 화면을 열어 읽기만 한다 — 아무것도 열거나 지우지 않는다. senbi_publish 를 naverDraft 로 올린 글이 여기에 보인다.",
    inputSchema: {
      type: "object",
      properties: { accountId: ACCOUNT_PROP },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "senbi_delete_post",
    description:
      "블로그에 올라간 글 하나를 지운다. 네이버에서 영구 삭제되며 되돌릴 수 없다. 사용자가 그 글을 지우라고 분명히 말했을 때만, 제목과 주소를 보여 주고 확인받은 뒤 쓴다. confirmTitle 이 실제 글 제목과 다르면 지우지 않는다.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: ACCOUNT_PROP,
        logNo: { type: "string", description: "지울 글의 번호 (글 주소 끝의 숫자)" },
        confirmTitle: { type: "string", description: "지울 글의 제목 전체 (글자 그대로)" },
      },
      required: ["logNo", "confirmTitle"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
] as const;

// ---------- 공통 ----------

/** 직전 활동과 최소 이만큼은 띄운다 — 짧은 간격으로 잇달아 하는 활동이 가장 위험하다 */
const MIN_GAP_SEC = 45;

function limitsView(acc: Account | null, n: { dailyLikeLimit: number; dailyCommentLimit: number; dailyBuddyRequestLimit: number }) {
  const id = acc?.id;
  return {
    likes: `${todayCount("like", id)}/${n.dailyLikeLimit}`,
    comments: `${todayCount("comment", id)}/${n.dailyCommentLimit}`,
    buddyRequests: `${todayCount("buddy-request", id)}/${n.dailyBuddyRequestLimit}`,
  };
}

/** 로그인된 브라우저를 열어 한 가지 일을 하고 닫는다 */
async function withSession(
  acc: Account | null,
  fn: (context: BrowserContext) => Promise<ToolResult>,
): Promise<ToolResult> {
  if (!hasSavedSession(acc?.id)) {
    return error("네이버 로그인 세션이 없습니다. senbi_login 으로 로그인 창을 띄워 사용자가 로그인한 뒤 다시 시도해 주세요.");
  }
  return exclusive(async () => {
    const context = await launchContext({ headless: true, accountId: acc?.id });
    try {
      if (!(await isLoggedIn(context))) {
        markSessionInvalid(acc?.id, "로그인 쿠키 없음");
        return error("네이버 로그인이 풀려 있습니다. senbi_login 으로 다시 로그인해 주세요.");
      }
      return await fn(context);
    } finally {
      await closeContext(context);
    }
  });
}

/** 직전 활동과의 간격을 채울 때까지 기다린다 */
async function waitForGap(accountId: string | undefined, minSec: number): Promise<number> {
  const gapMs = Math.max(MIN_GAP_SEC, minSec) * 1000;
  const waitMs = lastActivityAt(accountId) + gapMs - Date.now();
  if (waitMs <= 0) return 0;
  await new Promise((r) => setTimeout(r, waitMs));
  return Math.round(waitMs / 1000);
}

function cleanId(v: unknown): string {
  const s = str(v);
  return /^[A-Za-z0-9_-]{1,40}$/.test(s) ? s : "";
}

// ---------- 이웃 관리 ----------

async function neighborPosts(a: Args): Promise<ToolResult> {
  const { acc, settings } = resolveTarget(a.accountId);
  const limit = Math.min(20, Math.max(1, Math.floor(Number(a.limit)) || 10));
  return withSession(acc, async (context) => {
    const feed = await fetchNeighborFeed(context, limit + 10);
    const mine = settings.blogId;
    const posts = [];
    for (const it of feed) {
      if (posts.length >= limit) break;
      if (it.blogId === mine) continue; // 내 글은 뺀다
      let title = it.title ?? "";
      let excerpt = "";
      try {
        const p = await fetchPostContent(it.blogId, it.logNo, it.title);
        title = p.title;
        excerpt = p.text.replace(/\s+/g, " ").slice(0, 400);
      } catch {
        /* 본문을 못 읽어도 목록에는 남긴다 */
      }
      posts.push({
        blogId: it.blogId,
        logNo: it.logNo,
        url: `https://blog.naver.com/${it.blogId}/${it.logNo}`,
        title,
        excerpt,
        liked: actedOnPost(it.blogId, it.logNo, "like", acc?.id),
        commented: actedOnPost(it.blogId, it.logNo, "comment", acc?.id),
        commentedThisBlogIn7Days: actedRecently(it.blogId, "comment", 7, acc?.id),
      });
    }
    return json({
      account: acc?.name,
      today: limitsView(acc, settings.neighbor),
      posts,
      note:
        posts.length === 0
          ? "이웃 새글을 찾지 못했습니다. 이웃이 없거나 로그인이 풀렸을 수 있습니다."
          : "liked·commented 는 이 도구(와 앱)로 한 것만 압니다. 네이버에서 직접 한 것은 모릅니다. commentedThisBlogIn7Days 가 true 인 블로그에는 댓글을 달 수 없습니다.",
    });
  });
}

async function neighborEngage(a: Args): Promise<ToolResult> {
  const { acc, settings } = resolveTarget(a.accountId);
  const n = settings.neighbor;
  const blogId = cleanId(a.blogId);
  const logNo = str(a.logNo);
  if (!blogId || !/^\d{5,20}$/.test(logNo)) return error("blogId 와 logNo 가 올바르지 않습니다.");
  const comment = str(a.comment);
  let wantLike = a.like === true;
  if (!wantLike && !comment) return error("공감(like: true)이나 댓글(comment) 중 하나는 있어야 합니다.");
  if (comment.length > 300) return error("댓글은 300자 이내로 써 주세요.");
  if (/https?:\/\/|www\./i.test(comment)) return error("댓글에 링크를 넣을 수 없습니다.");

  const notes: string[] = [];
  if (wantLike && actedOnPost(blogId, logNo, "like", acc?.id)) {
    wantLike = false;
    notes.push("이 글에는 이미 공감했습니다.");
  }
  if (wantLike && todayCount("like", acc?.id) >= n.dailyLikeLimit) {
    wantLike = false;
    notes.push(`오늘 공감 한도(${n.dailyLikeLimit})에 도달했습니다.`);
  }
  let wantComment = Boolean(comment);
  if (wantComment && todayCount("comment", acc?.id) >= n.dailyCommentLimit) {
    wantComment = false;
    notes.push(`오늘 댓글 한도(${n.dailyCommentLimit})에 도달했습니다.`);
  }
  if (wantComment && actedRecently(blogId, "comment", 7, acc?.id)) {
    wantComment = false;
    notes.push("이 블로그에는 최근 7일 안에 댓글을 달았습니다(도배 방지).");
  }
  if (!wantLike && !wantComment) return error(`하지 않았습니다 — ${notes.join(" ")}`);

  return withSession(acc, async (context) => {
    const waited = await waitForGap(acc?.id, n.minDelaySec);
    const r = await engageOne(context, blogId, logNo, wantComment ? comment : null, wantLike);
    if (r.liked) {
      logActivity({ accountId: acc?.id, action: "like", targetBlogId: blogId, targetLogNo: logNo, ok: true });
    }
    if (r.commented) {
      logActivity({
        accountId: acc?.id,
        action: "comment",
        targetBlogId: blogId,
        targetLogNo: logNo,
        message: comment,
        ok: true,
      });
    }
    if (r.liked || r.commented) markSessionValid(acc?.id);
    if (wantLike && !r.liked) notes.push("공감이 반영되지 않았습니다(이미 눌렀거나 공감 버튼이 없는 글).");
    if (wantComment && !r.commented) notes.push("댓글이 등록되지 않았습니다(댓글을 막아 둔 글이거나 입력이 안 됨).");
    return json({
      url: `https://blog.naver.com/${blogId}/${logNo}`,
      liked: r.liked,
      commented: r.commented,
      waitedSeconds: waited,
      today: limitsView(acc, n),
      notes,
    });
  });
}

async function buddyCandidates(a: Args): Promise<ToolResult> {
  const { acc, settings } = resolveTarget(a.accountId);
  const query = str(a.query).slice(0, 100);
  if (!query) return error("찾을 주제(query)가 필요합니다.");
  return withSession(acc, async (context) => {
    const found = await searchBlogsByTopic(context, query);
    const candidates = found
      .filter((b) => b.blogId !== settings.blogId)
      .filter((b) => !actedRecently(b.blogId, "buddy-request", 30, acc?.id))
      .slice(0, 20)
      .map((b) => ({ blogId: b.blogId, url: `https://blog.naver.com/${b.blogId}`, posts: b.posts }));
    return json({
      account: acc?.name,
      query,
      today: limitsView(acc, settings.neighbor),
      candidates,
      note: "이미 이웃인 블로그가 섞여 있을 수 있습니다(이웃 목록은 확인하지 않습니다). 최근 30일 안에 이 도구로 신청한 블로그는 뺐습니다.",
    });
  });
}

async function buddyRequest(a: Args): Promise<ToolResult> {
  const { acc, settings } = resolveTarget(a.accountId);
  const n = settings.neighbor;
  const blogId = cleanId(a.blogId);
  const message = str(a.message);
  if (!blogId) return error("blogId 가 올바르지 않습니다.");
  if (!message || message.length > 150) return error("신청 문구는 1~150자로 써 주세요.");
  if (/https?:\/\/|www\./i.test(message)) return error("신청 문구에 링크를 넣을 수 없습니다.");
  if (blogId === settings.blogId) return error("자기 블로그에는 신청할 수 없습니다.");
  if (todayCount("buddy-request", acc?.id) >= n.dailyBuddyRequestLimit) {
    return error(`오늘 서로이웃 신청 한도(${n.dailyBuddyRequestLimit})에 도달했습니다.`);
  }
  if (actedRecently(blogId, "buddy-request", 30, acc?.id)) {
    return error("이 블로그에는 최근 30일 안에 이미 신청했습니다.");
  }
  return withSession(acc, async (context) => {
    const waited = await waitForGap(acc?.id, n.minDelaySec);
    const ok = await sendBuddyRequest(context, blogId, message);
    logActivity({ accountId: acc?.id, action: "buddy-request", targetBlogId: blogId, message, ok });
    if (!ok) {
      return error(
        `${blogId} 에 신청하지 못했습니다 — 서로이웃을 받지 않는 블로그이거나, 이미 이웃이거나, 신청 화면이 달라졌을 수 있습니다.`,
      );
    }
    return json({ blogId, requested: true, waitedSeconds: waited, today: limitsView(acc, n) });
  });
}

// ---------- 글 관리 ----------

async function posts(a: Args): Promise<ToolResult> {
  const { acc, settings } = resolveTarget(a.accountId);
  if (!settings.blogId) return error("블로그 아이디가 설정되지 않았습니다.");
  const limit = Math.min(50, Math.max(1, Math.floor(Number(a.limit)) || 20));
  const records = recentPublishedFor(settings.blogId, 200);
  const keywordOf = new Map(records.map((p) => [p.url ?? "", p.mainKeyword ?? ""]));
  let publicPosts: { title: string; url: string; publishedAt?: string; keyword?: string }[] = [];
  let rssError: string | undefined;
  try {
    const rss = await fetchBlogRss(settings.blogId);
    publicPosts = rss.posts.slice(0, limit).map((p) => {
      const url = `https://blog.naver.com/${settings.blogId}/${p.logNo}`;
      return { title: p.title, url, publishedAt: p.pubDate, keyword: keywordOf.get(url) || undefined };
    });
  } catch (err) {
    rssError = err instanceof Error ? err.message : String(err);
  }
  const publicUrls = new Set(publicPosts.map((p) => p.url));
  return json({
    account: acc?.name,
    blogId: settings.blogId,
    public: publicPosts,
    // RSS에 없는 발행 기록 = 비공개 글이거나, 지웠거나, RSS 범위를 벗어난 오래된 글
    recordedButNotInFeed: records
      .filter((p) => p.url && !publicUrls.has(p.url))
      .slice(0, limit)
      .map((p) => ({ title: p.title, url: p.url, publishedAt: p.publishedAt, keyword: p.mainKeyword })),
    rssError,
    note: "public 은 블로그 RSS에 보이는 공개 글입니다. recordedButNotInFeed 는 이 도구·앱으로 올린 기록은 있는데 RSS에 없는 글(비공개·삭제·오래된 글)입니다.",
  });
}

async function drafts(a: Args): Promise<ToolResult> {
  const { acc, settings } = resolveTarget(a.accountId);
  const id = str(a.id);
  if (id) {
    const d = getDraft(id);
    if (!d) return error(`초안 "${id}" 를 찾지 못했습니다.`);
    return json({
      id: d.id,
      status: d.status,
      blogId: d.blogId,
      keyword: d.mainKeyword,
      title: d.title,
      summary: d.summary,
      content: d.rawContent,
      headings: d.headings ?? [],
      createdAt: d.createdAt,
      publishedUrl: d.publishedUrl,
      note: d.headings?.length
        ? "senbi_publish 에 keyword·title·summary·content·headings 를 그대로 넘기면 다시 올릴 수 있습니다."
        : "예전 초안이라 소제목 목록이 없습니다. 본문에서 소제목 줄을 골라 headings 로 넘기세요.",
    });
  }
  const mine = listDrafts(200).filter(
    (d) => d.status === "draft" && (!d.blogId || !settings.blogId || d.blogId === settings.blogId),
  );
  return json({
    account: acc?.name,
    blogId: settings.blogId,
    drafts: mine.slice(0, 30).map((d) => ({
      id: d.id,
      title: d.title,
      keyword: d.mainKeyword,
      createdAt: d.createdAt,
      images: d.images.length,
      // true = 사람이 올리려고 남겨 둔 글(키워드가 '쓴 것'으로 잡혀 있다) / false = 발행하다 실패한 글
      keywordReserved: d.keywordReserved === true,
    })),
    note: "아직 올라가지 않은 초안만 보입니다. id 를 주면 전체 내용을 볼 수 있습니다.",
  });
}

async function naverDrafts(a: Args): Promise<ToolResult> {
  const { acc, settings } = resolveTarget(a.accountId);
  if (!settings.blogId) return error("블로그 아이디가 설정되지 않았습니다.");
  return withSession(acc, async (context) => {
    const items = await listNaverTempDrafts(context, settings.blogId);
    return json({
      account: acc?.name,
      blogId: settings.blogId,
      drafts: items,
      note: "임시저장 글을 발행하거나 지우는 것은 아직 블로그 글쓰기 화면에서 직접 해야 합니다.",
    });
  });
}

async function removePost(a: Args): Promise<ToolResult> {
  const { acc, settings } = resolveTarget(a.accountId);
  const logNo = str(a.logNo);
  const confirmTitle = str(a.confirmTitle);
  if (!settings.blogId) return error("블로그 아이디가 설정되지 않았습니다.");
  if (!/^\d{5,20}$/.test(logNo)) return error("logNo 가 올바르지 않습니다.");
  if (!confirmTitle) return error("confirmTitle(지울 글의 제목)이 필요합니다.");
  return withSession(acc, async (context) => {
    const r = await deletePost(context, settings.blogId, logNo, confirmTitle);
    if (!r.ok) return error(`지우지 않았습니다 — ${r.error ?? "알 수 없는 이유"}`);
    return json({
      deleted: true,
      title: r.title,
      url: `https://blog.naver.com/${settings.blogId}/${logNo}`,
      note: "네이버에서 지웠습니다. 이 PC의 발행 기록은 그대로라, 이 글의 키워드는 재사용 간격이 지날 때까지 '쓴 것'으로 남습니다.",
    });
  });
}

export const SOCIAL_HANDLERS: Record<string, (a: Args) => Promise<ToolResult>> = {
  senbi_neighbor_posts: neighborPosts,
  senbi_neighbor_engage: neighborEngage,
  senbi_buddy_candidates: buddyCandidates,
  senbi_buddy_request: buddyRequest,
  senbi_posts: posts,
  senbi_drafts: drafts,
  senbi_naver_drafts: naverDrafts,
  senbi_delete_post: removePost,
};
