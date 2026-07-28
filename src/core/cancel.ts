// 작업 중지(취소) 플래그 — 여러 잡이 체크포인트마다 확인해 안전하게 멈춘다.
let stopFlag = false;

/** 실행 시작 시 플래그 리셋 */
export function resetStop(): void {
  stopFlag = false;
}

/** 중지 요청 (대시보드 '작업 중지') */
export function requestStop(): void {
  stopFlag = true;
}

/** 체크포인트에서 확인 — true면 안전 지점에서 중단해야 함 */
export function shouldStop(): boolean {
  return stopFlag;
}
