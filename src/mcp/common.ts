import { getSettings, type Settings } from "../config/settings";
import { listAccounts, getAccount, resolveAccountSettings, type Account } from "../core/accounts";

export type Args = Record<string, unknown>;
export type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };
export interface ToolResult {
  content: Content[];
  isError?: boolean;
}

export const ACCOUNT_PROP = {
  type: "string",
  description: "senbi_accounts 가 준 계정 id. 계정이 하나뿐이면 생략해도 된다.",
} as const;

/** 브라우저 세션은 한 번에 하나만 — 작업이 겹치면 프로필 잠금으로 둘 다 실패한다 */
export const lock = { busy: false };

/** 브라우저를 쓰는 작업을 한 번에 하나만 돌린다 */
export async function exclusive(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  if (lock.busy) return error("다른 작업(발행·로그인·이웃 관리)이 진행 중입니다. 끝난 뒤 다시 시도해 주세요.");
  lock.busy = true;
  try {
    return await fn();
  } finally {
    lock.busy = false;
  }
}

export const text = (t: string): Content => ({ type: "text", text: t });
export const json = (v: unknown): ToolResult => ({ content: [text(JSON.stringify(v, null, 2))] });
export const error = (message: string): ToolResult => ({ content: [text(message)], isError: true });

export function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** 작업할 계정과 그 계정의 설정. 계정이 하나뿐이면 id 없이도 된다. */
export function resolveTarget(accountId: unknown): { acc: Account | null; settings: Settings } {
  const all = listAccounts();
  const id = str(accountId);
  if (all.length === 0) return { acc: null, settings: getSettings() }; // 계정 등록 전 — 전역 설정
  const acc = id ? getAccount(id) : all.length === 1 ? all[0]! : null;
  if (!acc) {
    throw new Error(
      id
        ? `계정 "${id}" 를 찾지 못했습니다. senbi_accounts 로 id 를 확인하세요.`
        : `계정이 ${all.length}개입니다. accountId 로 어느 블로그인지 정해 주세요: ${all.map((a) => `${a.name}(${a.id})`).join(", ")}`,
    );
  }
  return { acc, settings: resolveAccountSettings(acc) };
}
