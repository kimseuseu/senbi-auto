// 계정별 "실제 세션 유효성" 런타임 상태.
// 쿠키 존재(hasSavedSession)는 서버측 만료를 못 잡으므로, 발행/로그인 결과로 갱신한다.
// (인메모리 — 재시작 시 초기화되고, 기본값은 '유효'로 가정한다.)

export interface SessionState {
  needsRelogin: boolean;
  reason?: string;
  at?: number; // 마지막 갱신 시각(ms) — 표시는 서버 밖에서 스탬프
}

const states = new Map<string, SessionState>();

/** 세션 만료 감지(예: 글쓰기 페이지가 로그인으로 리다이렉트) */
export function markSessionInvalid(accountId: string | undefined, reason: string): void {
  if (!accountId) return;
  states.set(accountId, { needsRelogin: true, reason });
}

/** 세션 정상 확인(발행 성공·재로그인 성공) */
export function markSessionValid(accountId: string | undefined): void {
  if (!accountId) return;
  states.set(accountId, { needsRelogin: false });
}

export function getSessionState(accountId: string): SessionState {
  return states.get(accountId) ?? { needsRelogin: false };
}
