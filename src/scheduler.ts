import cron, { type ScheduledTask } from "node-cron";
import { getSettings } from "./config/settings";
import { runPostJob, type PostJobResult } from "./run/postJob";
import { runNeighborJob, type NeighborJobResult } from "./run/neighborJob";
import { listAccounts, resolveAccountSettings, type Account } from "./core/accounts";
import { resetStop, requestStop, shouldStop } from "./core/cancel";
import { alertJobFailure } from "./core/alerts";
import { createLogger } from "./core/logger";

export { requestStop, shouldStop };

const log = createLogger("scheduler");

let postTask: ScheduledTask | null = null;
let neighborTask: ScheduledTask | null = null;

// 동시 실행 방지 (브라우저 세션은 하나만)
let running = false;

async function withLock(name: string, fn: () => Promise<void>): Promise<void> {
  if (running) {
    log.warn(`${name}: 다른 작업 실행 중 — 이번 회차 건너뜀`);
    return;
  }
  running = true;
  try {
    await fn();
  } catch (err) {
    // 예약 실행 중 터진 예외는 여기서 잡지 않으면 조용히 사라진다 → 반드시 알림으로 남긴다
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

export function rescheduleAll(): void {
  const s = getSettings();

  postTask?.stop();
  neighborTask?.stop();
  postTask = null;
  neighborTask = null;

  // 글 발행 스케줄
  if (s.postSchedule && cron.validate(s.postSchedule)) {
    postTask = cron.schedule(
      s.postSchedule,
      () =>
        withLock("postJob", async () => {
          log.info("예약 실행: 글 생성/발행");
          // 계정별로 각자의 세션·설정으로 실행 (계정 없으면 레거시 단일 설정)
          const accounts = listAccounts();
          if (accounts.length === 0) {
            const runs = Math.max(1, s.postsPerRun);
            for (let i = 0; i < runs; i++) {
              const r = await runPostJob();
              notePostResult(r);
              log.info(`글 #${i + 1}: ${r.ok ? (r.published ? `발행 ${r.url ?? ""}` : "초안 저장") : `실패 ${r.error}`}`);
            }
          } else {
            for (const acc of accounts) {
              if (shouldStop()) break;
              await runAccount(acc, true, []);
            }
          }
        }),
      { timezone: "Asia/Seoul" },
    );
    log.info(`글 스케줄 등록: ${s.postSchedule}`);
  } else if (s.postSchedule) {
    log.warn(`잘못된 글 cron 식: ${s.postSchedule}`);
  }

  // 이웃 관리 스케줄
  if (s.neighbor.enabled && s.neighbor.schedule && cron.validate(s.neighbor.schedule)) {
    neighborTask = cron.schedule(
      s.neighbor.schedule,
      () =>
        withLock("neighborJob", async () => {
          log.info("예약 실행: 이웃 관리");
          const accounts = listAccounts().filter((a) => a.neighbor.enabled);
          if (accounts.length === 0) {
            const r = await runNeighborJob();
            noteNeighborResult(r);
            log.info(`이웃: ${r.ok ? `공감 ${r.likes} 댓글 ${r.comments} 서로이웃 ${r.buddyRequests}` : `실패 ${r.error}`}`);
          } else {
            for (const acc of accounts) {
              if (shouldStop()) break;
              const r = await runNeighborJob({
                settings: resolveAccountSettings(acc),
                accountId: acc.id,
              });
              noteNeighborResult(r, acc.name);
              log.info(
                `이웃(${acc.name}): ${r.ok ? `공감 ${r.likes} 댓글 ${r.comments} 서로이웃 ${r.buddyRequests}` : `실패 ${r.error}`}`,
              );
            }
          }
        }),
      { timezone: "Asia/Seoul" },
    );
    log.info(`이웃 스케줄 등록: ${s.neighbor.schedule}`);
  }
}

export function stopScheduler(): void {
  postTask?.stop();
  neighborTask?.stop();
}

export function isRunning(): boolean {
  return running;
}

/** 대시보드에서 수동 실행할 때도 락을 공유 */
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
    const r = await runPostJob(
      acc
        ? { headless, settings: resolveAccountSettings(acc), accountId: acc.id }
        : { headless },
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

/** 중지 요청을 인지하며 분 단위로 대기 (발행 텀). 중지되면 즉시 반환 */
async function sleepMinutesInterruptible(minutes: number): Promise<void> {
  const until = Date.now() + Math.max(0, minutes) * 60_000;
  while (Date.now() < until) {
    if (shouldStop()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** 계정 1개 처리: 글 발행(postsPerRun개, 텀 사이 대기) + (설정 시) 이웃 관리 */
async function runAccount(acc: Account, headless: boolean, results: string[]): Promise<void> {
  const settings = resolveAccountSettings(acc);
  const runs = Math.max(1, acc.postsPerRun);
  log.info(`▶ 계정 "${acc.name}" (${acc.blogId}) 작업 시작 — 글 ${runs}편, 텀 ${acc.postIntervalMin}분`);

  for (let i = 0; i < runs; i++) {
    if (shouldStop()) return;
    const r = await runPostJob({ headless, settings, accountId: acc.id });
    notePostResult(r, acc.name);
    results.push(
      `${acc.name} 글${i + 1} ${r.ok ? (r.published ? "발행" : "초안") : `실패(${r.error})`}`,
    );
    // 다음 글까지 발행 텀 대기 (마지막 글 뒤엔 대기 안 함)
    if (i < runs - 1 && !shouldStop()) {
      log.info(`⏳ 다음 글까지 ${acc.postIntervalMin}분 대기 중… (${acc.name})`);
      await sleepMinutesInterruptible(acc.postIntervalMin);
    }
  }
  log.info(`■ 계정 "${acc.name}" 작업 종료`);

  if (acc.neighbor.enabled && !shouldStop()) {
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
 */
export async function runAllNow(
  arg: boolean | { headless?: boolean; accountIds?: string[] } = true,
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
        await runAccount(acc, headless, results);
      }
    } else {
      // 레거시: 계정 미등록 상태 — 전역 설정으로 실행
      const s = getSettings();
      const runs = Math.max(1, s.postsPerRun);
      for (let i = 0; i < runs; i++) {
        if (shouldStop()) break;
        const r = await runPostJob({ headless });
        notePostResult(r);
        results.push(r.ok ? (r.published ? `발행 ${i + 1}` : `초안 ${i + 1}`) : `실패(${r.error})`);
      }
      if (s.neighbor.enabled && !shouldStop()) {
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
  let out = "";
  await withLock("neighborJob(manual)", async () => {
    resetStop(); // 이전 중지 플래그 초기화 (안 하면 즉시 멈춤)
    const acc = primaryAccount();
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
