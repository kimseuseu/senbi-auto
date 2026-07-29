import { createLogger } from "./logger";
import { addAlert } from "./alerts";

const log = createLogger("preflight");

/**
 * 시작 시 환경 점검.
 * 이미지 처리(sharp)는 OS별 네이티브 모듈이라 윈도우에서 백신 격리·런타임 누락으로
 * 실패하는 경우가 있다. 글을 쓰다 중간에 터지는 대신 시작할 때 미리 알린다.
 */
export async function preflight(): Promise<void> {
  log.info(`실행 환경: ${process.platform} ${process.arch} · Node ${process.versions.node}`);
  await checkSharp();
}

async function checkSharp(): Promise<void> {
  try {
    const sharp = (await import("sharp")).default;
    // 실제로 픽셀을 한 번 처리해 봐야 libvips 까지 정상인지 알 수 있다
    const png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    if (!png.length) throw new Error("빈 결과");
    log.info("이미지 처리 모듈 정상");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error("이미지 처리 모듈(sharp) 사용 불가", err);
    addAlert({
      kind: "post",
      message: "이미지 처리 모듈을 불러오지 못했습니다 — 사진 없이 발행됩니다",
      detail: `${detail} — 백신이 파일을 격리했을 수 있습니다. 앱을 지우고 다시 설치하면 대부분 해결됩니다.`,
    });
  }
}
