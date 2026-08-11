import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSettings, saveSettings, resolveApiKey, type Settings } from "../config/settings";
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
  resolveAccountSettings,
  type Account,
} from "../core/accounts";
import { loadLearnSource, selectKeywords, recommendReason } from "../run/keywordPlan";
import { startLogin, loginStatus, isLoginInProgress } from "../naver/login";
import { hasSavedSession } from "../naver/session";
import { browserStatus } from "../naver/browserSetup";
import { getSessionState } from "../naver/sessionState";
import { todayCount, recentPublished, recentPublishedFor } from "../core/activity";
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

/** @returns 실제로 바인딩된 포트 (요청 포트가 사용 중이면 다음 포트) */
export async function startDashboard(port: number): Promise<number> {
  ensureMigrated(); // 최초 1회: 기존 단일 설정을 '계정'으로 이관
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

  await app.register(fastifyStatic, {
    root: path.join(__dirname, "public"),
    prefix: "/",
  });

  app.get("/api/settings", async () => publicSettings(getSettings()));

  app.post("/api/settings", async (req) => {
    const patch = req.body as Partial<Settings>;
    // 빈 API 키 문자열이면 기존 값 유지
    if (patch.anthropicApiKey === "") delete patch.anthropicApiKey;
    const saved = saveSettings(patch);
    log.info("설정 저장");
    return publicSettings(saved);
  });

  app.get("/api/status", async () => {
    const s = getSettings();
    return {
      running: isRunning(),
      stopRequested: shouldStop(),
      hasApiKey: Boolean(resolveApiKey(s)),
      apiKeyFromEnv: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
      autoPublish: s.autoPublish,
      neighborEnabled: s.neighbor.enabled,
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
      try {
        const tpl = await learnBlog(blogId, req.body?.name ?? "", req.body?.count ?? 20);
        return { id: tpl.id, name: tpl.name, postCount: tpl.postCount, imageCount: tpl.imageCount, keywords: tpl.keywords };
      } catch (err) {
        return reply.code(500).send({ error: err instanceof Error ? err.message : "학습 실패" });
      }
    },
  );

  app.post<{ Params: { id: string } }>("/api/templates/:id/learn-more", async (req) => {
    const tpl = await addLearning(req.params.id);
    return tpl ? { ok: true, postCount: tpl.postCount, imageCount: tpl.imageCount } : { ok: false, error: "템플릿 없음" };
  });

  app.post<{ Params: { id: string }; Body: { instructions?: string } }>(
    "/api/templates/:id/instructions",
    async (req) => {
      setInstructions(req.params.id, req.body?.instructions ?? "");
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/templates/:id", async (req) => {
    deleteTemplate(req.params.id);
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
      const name = req.body?.name?.trim();
      const blogId = req.body?.blogId?.trim();
      if (!blogId) return reply.code(400).send({ error: "블로그 아이디를 입력하세요." });
      const acc = addAccount({ ...req.body, name: name || blogId, blogId });
      return accountView(acc);
    },
  );

  app.post<{ Params: { id: string }; Body: Partial<Account> }>(
    "/api/accounts/:id",
    async (req, reply) => {
      const acc = updateAccount(req.params.id, req.body ?? {});
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
  app.post<{ Params: { id: string } }>("/api/accounts/:id/login", async (req, reply) => {
    const acc = getAccount(req.params.id);
    if (!acc) return reply.code(404).send({ error: "계정 없음" });
    if (isLoginInProgress(acc.id)) return { ok: true, message: "이미 로그인 진행 중입니다." };
    void startLogin(acc.id); // await 안 함 — 백그라운드로 창 유지
    return { ok: true, message: "로그인 창을 열었습니다. 창에서 직접 로그인해 주세요." };
  });

  app.get<{ Params: { id: string } }>("/api/accounts/:id/login-status", async (req) => {
    const id = req.params.id;
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
  log.info(`대시보드: http://localhost:${bound}`);
  return bound;
}
