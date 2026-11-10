import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getSettings,
  saveSettings,
  sanitizeSettingsPatch,
  resolveApiKey,
  type Settings,
} from "../config/settings";
import { runPostNow, runNeighborNow, runAllNow, isRunning, requestStop, shouldStop } from "../jobs";
import { listDrafts, getDraft } from "../core/drafts";
import { listAlerts, unreadAlerts, markAlertsRead, clearAlerts } from "../core/alerts";
import {
  listTemplateSummaries,
  learnBlog,
  addLearning,
  setInstructions,
  deleteTemplate,
} from "../core/templates";
import {
  listAccounts,
  getAccount,
  addAccount,
  updateAccount,
  deleteAccount,
  ensureMigrated,
  fixAccountBlogIds,
  resolveAccountSettings,
  sanitizeAccountPatch,
  type Account,
} from "../core/accounts";
import { loadLearnSource, selectKeywords, recommendReason } from "../run/keywordPlan";
import { startLogin, loginStatus, isLoginInProgress, recentOtherLogin } from "../naver/login";
import { hasSavedSession } from "../naver/session";
import { browserStatus } from "../naver/browserSetup";
import { getSessionState } from "../naver/sessionState";
import {
  todayCount,
  recentPublished,
  recentPublishedFor,
  publishedCount,
} from "../core/activity";
import { normalizeBlogId, isValidBlogId, canonicalBlogId } from "../crawl/rss";
import { createLogger, getLogsSince } from "../core/logger";

const log = createLogger("dashboard");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 브라우저로 보낼 때 API 키는 마스킹 */
function publicSettings(s: Settings) {
  const key = resolveApiKey(s);
  return {
    ...s,
    anthropicApiKey: "",
    _hasApiKey: Boolean(key),
    _apiKeyFromEnv: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
  };
}

/** 이 PC 자신을 가리키는 호스트 이름만 허용한다 */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function hostnameOf(hostHeader: string): string {
  // "127.0.0.1:3060" → "127.0.0.1", "[::1]:3060" → "[::1]"
  return hostHeader.trim().toLowerCase().replace(/:\d+$/, "");
}

/**
 * 대시보드는 이 PC 에서만 쓰는 화면이라 로그인이 없다. 그래서 요청이 정말
 * 대시보드 화면(또는 이 PC 의 앱)에서 온 것인지 헤더로 확인한다.
 *  - Host 가 localhost 가 아니면 거부 → 남의 도메인을 이 PC 로 돌려 붙이는 수법 차단
 *  - 다른 사이트에서 보낸 요청이면 거부 → 웹페이지가 몰래 발행을 시작시키는 것 차단
 * @returns 거부 사유 (통과면 null)
 */
function rejectForeignRequest(headers: Record<string, unknown>, isApi: boolean): string | null {
  const host = typeof headers.host === "string" ? headers.host : "";
  if (!LOCAL_HOSTS.has(hostnameOf(host))) return "허용되지 않은 주소로 접속했습니다.";
  if (!isApi) return null; // 화면 파일 자체는 어디서 링크를 타고 와도 열려야 한다

  const origin = typeof headers.origin === "string" ? headers.origin : "";
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return "요청 출처를 확인할 수 없습니다.";
    }
    if (originHost !== host.trim().toLowerCase()) return "다른 사이트에서 보낸 요청입니다.";
  }
  // 브라우저가 붙여 주는 값 — 페이지가 위조할 수 없다. 없는 경우(앱·스크립트)는 통과.
  const site = headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") {
    return "다른 사이트에서 보낸 요청입니다.";
  }
  return null;
}

/** @returns 실제로 바인딩된 포트 (요청 포트가 사용 중이면 다음 포트) */
export async function startDashboard(port: number): Promise<number> {
  ensureMigrated(); // 최초 1회: 기존 단일 설정을 '계정'으로 이관
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

  app.addHook("onRequest", async (req, reply) => {
    const why = rejectForeignRequest(req.headers, req.url.startsWith("/api/"));
    if (!why) return;
    log.warn(`요청 거부: ${req.method} ${req.url.slice(0, 80)} — ${why}`);
    return reply.code(403).send({ error: why });
  });

  await app.register(fastifyStatic, {
    root: path.join(__dirname, "public"),
    prefix: "/",
  });

  app.get("/api/settings", async () => publicSettings(getSettings()));

  app.post("/api/settings", async (req, reply) => {
    const clean = sanitizeSettingsPatch(req.body);
    if (!clean.ok) return reply.code(400).send({ error: clean.error });
    const saved = saveSettings(clean.patch);
    log.info("설정 저장");
    return publicSettings(saved);
  });

  app.get("/api/status", async () => {
    const s = getSettings();
    // 계정이 있으면 이웃 관리를 켜고 끄는 건 계정별 설정이다 (전역 값은 한도·간격의 기본값일 뿐)
    const accounts = listAccounts();
    const neighborOn = accounts.filter((a) => a.neighbor?.enabled).map((a) => a.name);
    return {
      running: isRunning(),
      stopRequested: shouldStop(),
      hasApiKey: Boolean(resolveApiKey(s)),
      apiKeyFromEnv: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
      autoPublish: s.autoPublish,
      neighborEnabled: accounts.length > 0 ? neighborOn.length > 0 : s.neighbor.enabled,
      neighborAccounts: neighborOn,
      accountCount: accounts.length,
      publishedTotal: publishedCount(),
      today: {
        likes: todayCount("like"),
        comments: todayCount("comment"),
        buddyRequests: todayCount("buddy-request"),
      },
      limits: {
        likes: s.neighbor.dailyLikeLimit,
        comments: s.neighbor.dailyCommentLimit,
        buddyRequests: s.neighbor.dailyBuddyRequestLimit,
      },
      published: recentPublished(10),
      alerts: unreadAlerts().slice(0, 5),
      browser: browserStatus(),
    };
  });

  // ---------- 오류 알림 ----------
  app.get<{ Querystring: { unread?: string } }>("/api/alerts", async (req) => {
    const only = req.query?.unread === "1";
    return { alerts: only ? unreadAlerts() : listAlerts(50) };
  });

  app.post<{ Body: { id?: string } }>("/api/alerts/read", async (req) => {
    const n = markAlertsRead(req.body?.id);
    return { read: n };
  });

  app.post("/api/alerts/clear", async () => {
    clearAlerts();
    return { ok: true };
  });

  // ---------- 템플릿(학습한 블로그) ----------
  app.get("/api/templates", async () => listTemplateSummaries());

  app.post<{ Body: { blogId?: string; name?: string; count?: number } }>(
    "/api/templates/learn",
    async (req, reply) => {
      const blogId = req.body?.blogId?.trim();
      if (!blogId) return reply.code(400).send({ error: "블로그 아이디를 입력하세요." });
      if (!isValidBlogId(normalizeBlogId(blogId))) {
        return reply
          .code(400)
          .send({ error: "블로그 아이디 형식이 올바르지 않습니다(영문·숫자·-·_ 만 가능)." });
      }
      try {
        const tpl = await learnBlog(blogId, req.body?.name ?? "", req.body?.count ?? 20);
        return { id: tpl.id, name: tpl.name, postCount: tpl.postCount, imageCount: tpl.imageCount, keywords: tpl.keywords };
      } catch (err) {
        return reply.code(500).send({ error: err instanceof Error ? err.message : "학습 실패" });
      }
    },
  );

  app.post<{ Params: { id: string } }>("/api/templates/:id/learn-more", async (req, reply) => {
    try {
      const tpl = await addLearning(req.params.id);
      if (!tpl) return reply.code(404).send({ ok: false, error: "템플릿 없음" });
      return { ok: true, postCount: tpl.postCount, imageCount: tpl.imageCount };
    } catch (err) {
      return reply
        .code(500)
        .send({ ok: false, error: err instanceof Error ? err.message : "추가 학습 실패" });
    }
  });

  app.post<{ Params: { id: string }; Body: { instructions?: string } }>(
    "/api/templates/:id/instructions",
    async (req) => {
      setInstructions(req.params.id, req.body?.instructions ?? "");
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/templates/:id", async (req, reply) => {
    if (!deleteTemplate(req.params.id)) return reply.code(404).send({ error: "템플릿 없음" });
    return { ok: true };
  });

  // ---------- 계정(블로그) ----------
  /** 로그인 세션 상태를 붙여 계정 목록 반환 */
  function accountView(a: Account) {
    const ss = getSessionState(a.id);
    return {
      ...a,
      loggedIn: hasSavedSession(a.id),
      loginBusy: isLoginInProgress(a.id),
      needsRelogin: ss.needsRelogin, // 쿠키는 있어도 서버 세션이 만료된 경우
      sessionReason: ss.reason,
    };
  }

  app.get("/api/accounts", async () => listAccounts().map(accountView));

  app.post<{ Body: Partial<Account> & { name?: string; blogId?: string } }>(
    "/api/accounts",
    async (req, reply) => {
      if (!req.body?.blogId?.trim()) {
        return reply.code(400).send({ error: "블로그 아이디를 입력하세요." });
      }
      const clean = sanitizeAccountPatch(req.body);
      if (!clean.ok) return reply.code(400).send({ error: clean.error });
      // 로그인 아이디를 적었더라도 블로그의 실제 주소로 저장한다
      const blogId = await canonicalBlogId(clean.patch.blogId!);
      const acc = addAccount({ ...clean.patch, name: clean.patch.name || blogId, blogId });
      return accountView(acc);
    },
  );

  app.post<{ Params: { id: string }; Body: Partial<Account> }>(
    "/api/accounts/:id",
    async (req, reply) => {
      if (!getAccount(req.params.id)) return reply.code(404).send({ error: "계정 없음" });
      const clean = sanitizeAccountPatch(req.body ?? {});
      if (!clean.ok) return reply.code(400).send({ error: clean.error });
      if (clean.patch.blogId) clean.patch.blogId = await canonicalBlogId(clean.patch.blogId);
      const acc = updateAccount(req.params.id, clean.patch);
      if (!acc) return reply.code(404).send({ error: "계정 없음" });
      return accountView(acc);
    },
  );

  app.delete<{ Params: { id: string } }>("/api/accounts/:id", async (req) => {
    deleteAccount(req.params.id);
    return { ok: true };
  });

  // 발행 전 '어느 키워드로 쓸지' 고르는 화면에 필요한 것 전부:
  // 학습 블로그에서 수집한 후보 · 이 블로그가 최근에 쓴 메인키워드(최신순) · 추천 키워드
  app.get<{ Params: { id: string } }>("/api/accounts/:id/keyword-plan", async (req, reply) => {
    const acc = getAccount(req.params.id);
    if (!acc) return reply.code(404).send({ error: "계정 없음" });
    const settings = resolveAccountSettings(acc);
    const recent = recentPublishedFor(settings.blogId, 12).map((p) => ({
      title: p.title,
      mainKeyword: p.mainKeyword ?? "",
      publishedAt: p.publishedAt,
      url: p.url,
    }));
    try {
      const src = await loadLearnSource(settings);
      if (src.posts.length === 0) {
        return {
          accountId: acc.id,
          blogId: settings.blogId,
          learnFrom: src.learnFrom,
          postsPerRun: Math.max(1, acc.postsPerRun),
          candidates: [],
          blocked: [],
          recent,
          recommended: null,
          error: `학습 블로그(${src.learnFrom})에서 참고글을 가져오지 못했습니다. 상세 설정에서 블로그를 학습해 주세요.`,
        };
      }
      const sel = await selectKeywords(settings, src);
      const rec = sel.candidates.find((c) => c.keyword === sel.recommended);
      return {
        accountId: acc.id,
        blogId: settings.blogId,
        learnFrom: src.learnFrom,
        templateName: src.template?.name ?? "",
        learnedPosts: src.posts.length,
        postsPerRun: Math.max(1, acc.postsPerRun),
        candidates: sel.candidates.slice(0, 40),
        blocked: sel.blocked.slice(0, 30),
        recent,
        recommended: sel.recommended,
        recommendReason: rec ? recommendReason(rec) : "",
        error: sel.error,
      };
    } catch (err) {
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : "키워드를 불러오지 못했습니다." });
    }
  });

  // 계정별 로그인 창 띄우기 (비동기 진행 — 상태는 폴링)
  const LOGIN_GAP_MS = 6 * 60 * 60 * 1000;
  app.post<{ Params: { id: string }; Querystring: { force?: string } }>(
    "/api/accounts/:id/login",
    async (req, reply) => {
    const acc = getAccount(req.params.id);
    if (!acc) return reply.code(404).send({ error: "계정 없음" });
    if (isLoginInProgress(acc.id)) return { ok: true, message: "이미 로그인 진행 중입니다." };
    // 같은 PC에서 여러 아이디를 잇달아 로그인하면 전부 보호조치에 걸릴 수 있다 (2026-09-30 실측)
    const recent = recentOtherLogin(acc.id, LOGIN_GAP_MS);
    if (recent && req.query?.force !== "1") {
      const other = getAccount(recent.accountId)?.name ?? recent.accountId;
      const minutes = Math.max(1, Math.round((Date.now() - Date.parse(recent.at)) / 60000));
      return reply.code(409).send({
        error:
          `${minutes}분 전에 "${other}" 계정이 이 PC에서 로그인했습니다. ` +
          "같은 PC에서 여러 아이디를 잇달아 로그인하면 네이버가 그 아이디들을 한꺼번에 보호조치할 수 있습니다 " +
          "(2026-09-30 실제 발생). 6시간 이상 간격을 두는 것이 안전합니다. 그래도 지금 로그인할까요?",
        needsConfirm: true,
      });
    }
    void startLogin(acc.id, acc.blogId); // await 안 함 — 백그라운드로 창 유지
    return { ok: true, message: "로그인 창을 열었습니다. 창에서 직접 로그인해 주세요." };
    },
  );

  app.get<{ Params: { id: string } }>("/api/accounts/:id/login-status", async (req, reply) => {
    const id = req.params.id;
    if (!getAccount(id)) return reply.code(404).send({ error: "계정 없음" });
    return { ...loginStatus(id), loggedIn: hasSavedSession(id), busy: isLoginInProgress(id) };
  });

  // 실시간 로그 (since 이후 새 로그만 — 폴링용)
  app.get<{ Querystring: { since?: string } }>("/api/logs", async (req) => {
    const since = Number(req.query?.since ?? 0) || 0;
    return getLogsSince(since);
  });

  app.get("/api/drafts", async () => listDrafts(30));
  app.get<{ Params: { id: string } }>("/api/drafts/:id", async (req, reply) => {
    const d = getDraft(req.params.id);
    if (!d) return reply.code(404).send({ error: "없음" });
    return d;
  });

  app.post<{
    Body: { headless?: boolean; accountIds?: string[]; keywords?: Record<string, string[]> };
  }>("/api/run/all", async (req) => {
    const headless = req.body?.headless ?? true;
    const accountIds = req.body?.accountIds;
    const keywords = req.body?.keywords;
    const msg = await runAllNow({ headless, accountIds, keywords });
    return { message: msg };
  });

  app.post("/api/run/stop", async () => {
    requestStop();
    return { message: "작업을 안전하게 중지하는 중입니다" };
  });

  app.post<{ Body: { headless?: boolean } }>("/api/run/post", async (req) => {
    const headless = req.body?.headless ?? true;
    const msg = await runPostNow(headless);
    return { message: msg };
  });

  app.post<{ Body: { headless?: boolean } }>("/api/run/neighbor", async (req) => {
    const headless = req.body?.headless ?? true;
    const msg = await runNeighborNow(headless);
    return { message: msg };
  });

  // 포트가 이미 쓰이는 중이면(윈도우에서 흔하다) 다음 포트로 옮겨 뜬다.
  // 실제로 잡은 포트는 stdout 마커로 알려 준다 — Electron 이 이 값으로 창을 연다.
  let bound = port;
  for (let i = 0; i < 20; i++) {
    try {
      await app.listen({ port: bound, host: "127.0.0.1" });
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EADDRINUSE" && code !== "EACCES") throw err;
      log.warn(`${bound} 포트 사용 중 — ${bound + 1} 로 재시도`);
      bound += 1;
      if (i === 19) throw err;
    }
  }
  process.stdout.write(`SENBI_PORT=${bound}\n`);
  // 이미 등록된 계정 중 로그인 아이디로 적힌 것을 블로그 실제 주소로 바로잡는다 (실패해도 기동은 계속)
  void fixAccountBlogIds().catch((err) => log.warn("계정 블로그 주소 확인 실패(무시)", err));
  log.info(`대시보드: http://localhost:${bound}`);
  return bound;
}
