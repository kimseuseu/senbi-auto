// MCP는 표준출력으로 JSON 메시지만 주고받는다. 엔진의 로그(console.log)가 섞이면
// 클라이언트가 메시지를 해석하지 못하므로, 다른 모듈이 로드되기 전에 로그를 표준에러로 돌린다.
// ⚠️ server.ts 의 첫 import 여야 한다.
// eslint-disable-next-line no-console
console.log = (...args: unknown[]) => console.error(...args);
// eslint-disable-next-line no-console
console.info = (...args: unknown[]) => console.error(...args);
