import { getSettings, type Settings } from "./config/settings";
import { runPostJob, type PostJobResult } from "./run/postJob";
import { runNeighborJob, type NeighborJobResult } from "./run/neighborJob";
import { listAccounts, resolveAccountSettings, type Account } from "./core/accounts";
import { resetStop, requestStop, shouldStop } from "./core/cancel";
import { alertJobFailure } from "./core/alerts";
import { checkWriteSession } from "./naver/sessionCheck";
import { getSessionState } from "./naver/sessionState";
import { createLogger } from "./core/logger";

export { requestStop, shouldStop };

const log = createLogger("jobs");

// 동시 실행 방지 (브라우저 세션은 하나만)
let running = false;

async function withLock(name: string, fn: () => Promise<void>): Promise<void> {
  if (running) {
    log.warn(`${name}: 다른 작업 실행 중 — 이번 요청은 건너뜀`);
    return;
  }
  running = true;
  try {
    await fn();
  } catch (err) {
    // 여기서 잡지 않으면 예외가 조용히 사라진다 → 반드시 알림으로 남긴다
    log.error(`${name}: 예기치 못한 오류로 중지`, err);
    alertJobFailure(name.startsWith("neighbor") ? "neighbor" : "post", err);
  } finally {
    running = false;
  }
}

/** 글 발행 결과에서 문제를 찾아 알림으로 남긴다 (실패 + 발행까지 못 간 경우 모두) */
function notePostResult(r: PostJobResult, target?: string): void {
  if (!r.ok) alertJobFailure("post", r.error ?? "알 수 없는 오류", { target });
  else if (r.error) alertJobFailure("post", r.error, { target, stopped: false });
}

function noteNeighborResult(r: NeighborJobResult, target?: string): void {
  if (!r.ok) alertJobFailure("neighbor", r.error ?? "알 수 없는 오류", { target });
}

export function isRunning(): boolean {
  return running;
}

/**
 * 작업에 쓸 기본 계정 — 등록된 첫 계정.
 * ⚠️ 계정 세션(로그인됨) 대신 레거시 세션을 쓰면 네이버가 비로그인으로 취급해
 *    댓글 입력이 무시된다(실측). 그래서 모든 잡은 계정 세션을 쓴다.
 */
function primaryAccount(): Account | null {
  return listAccounts()[0] ?? null;
}

export async function runPostNow(headless = true): Promise<string> {
  let out = "";
  await withLock("postJob(manual)", async () => {
    resetStop(); // 이전 중지 플래그 초기화 (안 하면 즉시 멈춤)
    const acc = primaryAccount();
    const settings = acc ? resolveAccountSettings(acc) : getSettings();
    const blocked = await sessionBlocker(settings, acc?.id, headless);
    if (blocked) {
      alertJobFailure("post", blocked, { target: acc?.name });
      out = `실패: ${blocked}`;
      return;
    }
    const r = await runPostJob(
      acc ? { headless, settings, accountId: acc.id } : { headless, settings },
    );
    notePostResult(r);
    out = r.ok
      ? r.published
        ? `발행 완료: ${r.url ?? "(URL 미확인)"}`
        : `초안 저장 완료: ${r.draft?.title ?? ""}`
      : `실패: ${r.error}`;
  });
  return out || "다른 작업 실행 중이라 건너뜀";
}

/**
 * 글을 만들기 전에 발행할 수 있는 상태인지 확인한다. 자동발행이 꺼져 있으면(초안만) 확인하지 않는다.
 * @returns 막힌 이유 (문제없으면 null)
 */
async function sessionBlocker(
  settings: Settings,
  accountId: string | undefined,
  headless: boolean,
): Promise<string | null> {
  if (!settings.autoPublish) return null;
  if (!settings.blogId) return null; // 아래 작업이 '블로그 아이디 없음'으로 알려 준다
  const check = await checkWriteSession({ blogId: settings.blogId, accountId, headless });
  return check.ok ? null : (check.reason ?? "네이버 로그인 상태를 확인하지 못했습니다.");
}

/** 중지 요청을 인지하며 분 단위로 대기 (발행 텀). 중지되면 즉시 반환 */
async function sleepMinutesInterruptible(minutes: number): Promise<void> {
  const until = Date.now() + Math.max(0, minutes) * 60_000;
  while (Date.now() < until) {
    if (shouldStop()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * 계정 1개 처리: 글 발행(postsPerRun개, 텀 사이 대기) + (설정 시) 이웃 관리.
 * keywords — 화면에서 고른 키워드를 글 순서대로. 모자란 자리는 자동 선정한다.
 */
async function runAccount(
  acc: Account,
  headless: boolean,
  results: string[],
  keywords: string[] = [],
): Promise<void> {
  const settings = resolveAccountSettings(acc);
  // 저장된 값이 숫자가 아니어도(예전 파일) 글 0편으로 조용히 끝나지 않게 한다
  const runs = Math.max(1, Math.floor(Number(acc.postsPerRun)) || 1);
  log.info(`▶ 계정 "${acc.name}" (${acc.blogId}) 작업 시작 — 글 ${runs}편, 텀 ${acc.postIntervalMin}분`);
  if (keywords.length > 0) {
    log.info(`선택한 키워드: ${keywords.map((k, n) => `글${n + 1} "${k}"`).join(" · ")}`);
  }

  // 발행·이웃 관리 둘 다 로그인이 필요하다 — 글을 만들기 전에 먼저 확인한다
  const needsLogin = settings.autoPublish || acc.neighbor.enabled;
  if (needsLogin) {
    const blocked = await sessionBlocker({ ...settings, autoPublish: true }, acc.id, headless);
    if (blocked) {
      alertJobFailure(settings.autoPublish ? "post" : "neighbor", blocked, { target: acc.name });
      results.push(`${acc.name} 건너뜀(${blocked})`);
      log.info(`■ 계정 "${acc.name}" 작업 건너뜀 — ${blocked}`);
      return;
    }
  }

  for (let i = 0; i < runs; i++) {
    if (shouldStop()) return;
    const keyword = keywords[i]?.trim() || undefined;
    const r = await runPostJob({ headless, settings, accountId: acc.id, keyword });
    notePostResult(r, acc.name);
    results.push(
      `${acc.name} 글${i + 1} ${r.ok ? (r.published ? "발행" : "초안") : `실패(${r.error})`}`,
    );
    if (i === runs - 1) break;

    // 같은 이유로 또 실패할 게 뻔하면 남은 글은 만들지 않는다
    // (키워드 없음·API 키 없음·세션 만료 — 예전엔 글 수만큼 되풀이하고 그 사이 텀까지 기다렸다)
    if (!r.ok || getSessionState(acc.id).needsRelogin) {
      log.warn(`남은 글 ${runs - 1 - i}편은 건너뜁니다 — ${r.error ?? "로그인이 필요합니다"}`);
      break;
    }
    // 발행 텀은 '올라간 글' 사이의 간격이다. 올라간 글이 없으면(초안·발행 실패) 기다릴 이유가 없다.
    if (r.published && !shouldStop()) {
      log.info(`⏳ 다음 글까지 ${acc.postIntervalMin}분 대기 중… (${acc.name})`);
      await sleepMinutesInterruptible(acc.postIntervalMin);
    }
  }
  log.info(`■ 계정 "${acc.name}" 작업 종료`);

  if (acc.neighbor.enabled && !shouldStop() && !getSessionState(acc.id).needsRelogin) {
    const n = await runNeighborJob({ headless, settings, accountId: acc.id });
    noteNeighborResult(n, acc.name);
    results.push(
      n.ok ? `${acc.name} 이웃 공감${n.likes}·댓글${n.comments}` : `${acc.name} 이웃실패(${n.error})`,
    );
  }
}

/**
 * 원버튼 — 오늘 작업 전부.
 * 선택된 계정들을 순차로(브라우저는 한 번에 하나) 처리한다.
 * accountIds 없으면 등록된 모든 계정. 계정이 하나도 없으면 레거시 단일 설정으로 폴백.
 * keywords — 계정 id별로 화면에서 고른 키워드 (글 순서대로). 없으면 자동 선정.
 */
export async function runAllNow(
  arg:
    | boolean
    | { headless?: boolean; accountIds?: string[]; keywords?: Record<string, string[]> } = true,
): Promise<string> {
  const opts = typeof arg === "boolean" ? { headless: arg } : arg;
  const headless = opts.headless ?? true;

  let out = "";
  await withLock("all(manual)", async () => {
    resetStop();
    const results: string[] = [];

    const all = listAccounts();
    if (all.length > 0) {
      const wanted = opts.accountIds?.length
        ? all.filter((a) => opts.accountIds!.includes(a.id))
        : all;
      if (wanted.length === 0) {
        out = "선택된 계정이 없습니다.";
        return;
      }
      for (const acc of wanted) {
        if (shouldStop()) break;
        await runAccount(acc, headless, results, opts.keywords?.[acc.id] ?? []);
      }
    } else {
      // 레거시: 계정 미등록 상태 — 전역 설정으로 실행
      const s = getSettings();
      const runs = Math.max(1, s.postsPerRun);
      const blocked = await sessionBlocker(s, undefined, headless);
      if (blocked) {
        alertJobFailure("post", blocked);
        results.push(`건너뜀(${blocked})`);
      }
      for (let i = 0; i < runs && !blocked; i++) {
        if (shouldStop()) break;
        const r = await runPostJob({ headless });
        notePostResult(r);
        results.push(r.ok ? (r.published ? `발행 ${i + 1}` : `초안 ${i + 1}`) : `실패(${r.error})`);
        if (!r.ok) break; // 같은 이유로 또 실패한다
      }
      if (s.neighbor.enabled && !shouldStop() && !blocked) {
        const n = await runNeighborJob({ headless });
        noteNeighborResult(n);
        results.push(n.ok ? `이웃 공감 ${n.likes}·댓글 ${n.comments}` : `이웃실패(${n.error})`);
      }
    }

    if (shouldStop()) results.push("작업 중지됨");
    out = results.join(" · ");
    log.info(`▣ 오늘 작업 종료 — ${out}`);
  });
  return out || "다른 작업이 실행 중이라 건너뛰었습니다";
}

export async function runNeighborNow(headless = true): Promise<string> {
  // 계정이 있으면 이웃 관리는 계정별로 켠다 — 켜 둔 계정이 하나도 없으면 돌릴 대상이 없다.
  // (오류가 아니라 설정 안내라서 알림은 남기지 않는다)
  const all = listAccounts();
  const target = all.find((a) => a.neighbor?.enabled) ?? null;
  if (all.length > 0 && !target) {
    return "이웃 관리를 켠 계정이 없습니다. 블로그 계정 → 설정에서 ‘이 계정 이웃 관리 사용’을 켜 주세요.";
  }

  let out = "";
  await withLock("neighborJob(manual)", async () => {
    resetStop(); // 이전 중지 플래그 초기화 (안 하면 즉시 멈춤)
    const acc = target;
    const r = await runNeighborJob(
      acc
        ? { headless, settings: resolveAccountSettings(acc), accountId: acc.id }
        : { headless },
    );
    noteNeighborResult(r);
    out = r.ok
      ? `공감 ${r.likes} · 댓글 ${r.comments} · 서로이웃 ${r.buddyRequests}`
      : `실패: ${r.error}`;
  });
  return out || "다른 작업 실행 중이라 건너뜀";
}
