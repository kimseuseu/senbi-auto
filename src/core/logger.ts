import fs from "node:fs";
import path from "node:path";
import { LOG_DIR, ensureDir } from "../config/paths";

type Level = "info" | "warn" | "error" | "debug";

const COLORS: Record<Level, string> = {
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
  debug: "\x1b[90m",
};
const RESET = "\x1b[0m";

function line(level: Level, scope: string, msg: string): string {
  const ts = new Date().toISOString();
  return `${ts} [${level.toUpperCase()}] (${scope}) ${msg}`;
}

// ---------- 실시간 로그 링버퍼 (대시보드 노출용) ----------
export interface LogEntry {
  seq: number;
  ts: string; // ISO
  level: Level;
  scope: string;
  msg: string;
}

const RING_MAX = 500;
const ring: LogEntry[] = [];
let seqCounter = 0;

function pushRing(level: Level, scope: string, msg: string): void {
  ring.push({ seq: ++seqCounter, ts: new Date().toISOString(), level, scope, msg });
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
}

/** sinceSeq 이후의 새 로그만 반환(실시간 폴링용). since=0이면 최근 것 일부. */
export function getLogsSince(sinceSeq = 0, initial = 150): { entries: LogEntry[]; lastSeq: number } {
  const entries = sinceSeq > 0 ? ring.filter((e) => e.seq > sinceSeq) : ring.slice(-initial);
  return { entries, lastSeq: seqCounter };
}

/** 콘솔 + 일자별 로그 파일(jsonl 아님, 사람이 읽는 텍스트) 동시 기록 */
export function createLogger(scope: string) {
  const write = (level: Level, msg: string, extra?: unknown) => {
    const full = extra !== undefined ? `${msg} ${safe(extra)}` : msg;
    const text = line(level, scope, full);
    const color = COLORS[level];
    pushRing(level, scope, full); // 실시간 로그 버퍼에 적재
    // eslint-disable-next-line no-console
    console.log(`${color}${text}${RESET}`);
    try {
      ensureDir(LOG_DIR);
      const day = new Date().toISOString().slice(0, 10);
      fs.appendFileSync(path.join(LOG_DIR, `${day}.log`), text + "\n");
    } catch {
      /* 로그 파일 실패는 무시 */
    }
  };
  return {
    info: (m: string, e?: unknown) => write("info", m, e),
    warn: (m: string, e?: unknown) => write("warn", m, e),
    error: (m: string, e?: unknown) => write("error", m, e),
    debug: (m: string, e?: unknown) => {
      if (process.env.SENBI_DEBUG) write("debug", m, e);
    },
  };
}

function safe(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack ?? v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export type Logger = ReturnType<typeof createLogger>;
