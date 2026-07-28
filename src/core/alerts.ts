import { JsonStore } from "../config/store";
import { createLogger } from "./logger";

const log = createLogger("alerts");

/** 사용자에게 "오류로 중지됨"을 알려야 하는 사건 */
export interface Alert {
  id: string;
  at: string;
  /** 어느 작업에서 났는지 */
  kind: "post" | "neighbor";
  /** 계정 이름 등 어느 대상인지 (없으면 단일 설정) */
  target?: string;
  /** 사람이 읽을 한 줄 */
  message: string;
  /** 원인 상세 */
  detail?: string;
  /** 앱에서 확인 처리했는지 */
  read: boolean;
}

interface AlertDb {
  alerts: Alert[];
}

const store = new JsonStore<AlertDb>("alerts", { alerts: [] });

const KIND_LABEL: Record<Alert["kind"], string> = {
  post: "글 발행",
  neighbor: "이웃 관리",
};

/** 오류 알림 기록 — 대시보드 배너와 데스크톱 알림이 이걸 읽는다 */
export function addAlert(a: Omit<Alert, "id" | "at" | "read">): Alert {
  const rec: Alert = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    read: false,
    ...a,
  };
  store.update((db) => {
    // 같은 작업·같은 사유가 연달아 쌓이면 마지막 것만 남긴다 (알림 폭탄 방지)
    const last = db.alerts[db.alerts.length - 1];
    if (last && !last.read && last.kind === rec.kind && last.message === rec.message) {
      db.alerts[db.alerts.length - 1] = rec;
    } else {
      db.alerts.push(rec);
    }
    if (db.alerts.length > 200) db.alerts = db.alerts.slice(-200);
    return db;
  });
  log.warn(`알림 등록 [${KIND_LABEL[rec.kind]}] ${rec.message}${rec.detail ? ` — ${rec.detail}` : ""}`);
  return rec;
}

/** 작업 실패를 알림으로 남긴다. error 가 없으면 아무것도 하지 않는다. */
export function alertJobFailure(
  kind: Alert["kind"],
  error: unknown,
  opts: { target?: string; stopped?: boolean } = {},
): Alert | null {
  const detail = error instanceof Error ? error.message : String(error ?? "").trim();
  if (!detail) return null;
  const who = opts.target ? `${opts.target} — ` : "";
  return addAlert({
    kind,
    target: opts.target,
    message: `${who}${KIND_LABEL[kind]} 중 오류가 발생해 ${opts.stopped === false ? "일부만 처리했습니다" : "중지했습니다"}`,
    detail,
  });
}

export function listAlerts(limit = 50): Alert[] {
  return store.read().alerts.slice(-limit).reverse();
}

export function unreadAlerts(): Alert[] {
  return store.read().alerts.filter((a) => !a.read).reverse();
}

/** id 를 주면 그것만, 없으면 전부 읽음 처리 */
export function markAlertsRead(id?: string): number {
  let n = 0;
  store.update((db) => {
    for (const a of db.alerts) {
      if (a.read) continue;
      if (id && a.id !== id) continue;
      a.read = true;
      n++;
    }
    return db;
  });
  return n;
}

export function clearAlerts(): void {
  store.write({ alerts: [] });
}
