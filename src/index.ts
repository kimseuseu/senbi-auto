import "dotenv/config";
import { ensureAppDirs } from "./config/paths";
import { rescheduleAll, stopScheduler } from "./scheduler";
import { startDashboard } from "./server/dashboard";
import { createLogger } from "./core/logger";

const log = createLogger("main");

async function main() {
  ensureAppDirs();
  const port = Number(process.env.SENBI_AUTO_PORT ?? 3060);

  log.info("senbi-auto 데몬 시작");
  rescheduleAll(); // 저장된 설정으로 스케줄 등록
  await startDashboard(port);

  log.info(`준비 완료 — 브라우저에서 http://localhost:${port} 열기`);
}

function shutdown() {
  log.info("종료 중...");
  stopScheduler();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((e) => {
  log.error("데몬 시작 실패", e);
  process.exit(1);
});
