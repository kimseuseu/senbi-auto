import "dotenv/config";
import { ensureAppDirs } from "./config/paths";
import { startDashboard } from "./server/dashboard";
import { prefetchChromium } from "./naver/browserSetup";
import { preflight } from "./core/preflight";
import { pruneImageCache } from "./media/images";
import { createLogger } from "./core/logger";

const log = createLogger("main");

async function main() {
  ensureAppDirs();
  const port = Number(process.env.SENBI_AUTO_PORT ?? 3060);

  log.info("senbi-auto 데몬 시작");
  await preflight(); // 실행 환경 점검 (이미지 모듈 등)
  const bound = await startDashboard(port);

  log.info(`준비 완료 — 브라우저에서 http://localhost:${bound} 열기`);
  prefetchChromium(); // 자동화용 브라우저가 없으면 백그라운드로 미리 받아 둔다
  pruneImageCache(); // 발행에 쓰고 남은 오래된 가공 이미지 정리
}

function shutdown() {
  log.info("종료 중...");
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((e) => {
  log.error("데몬 시작 실패", e);
  process.exit(1);
});
