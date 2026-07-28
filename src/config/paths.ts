import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * 데이터 저장 루트. 기본은 사용자 홈의 ~/.senbi-auto (맥/윈도우 공용).
 * SENBI_AUTO_DATA_DIR 로 재정의 가능.
 */
export const DATA_DIR =
  process.env.SENBI_AUTO_DATA_DIR?.trim() ||
  path.join(os.homedir(), ".senbi-auto");

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function dataPath(...segments: string[]): string {
  return path.join(DATA_DIR, ...segments);
}

/** Playwright 영속 세션(네이버 로그인 쿠키 등)이 저장되는 곳 */
export const SESSION_DIR = dataPath("session");
/** 크롤링/필터 처리한 이미지 임시 저장 */
export const IMAGE_CACHE_DIR = dataPath("images");
/** 사용자가 직접 넣어두는 자기 이미지 풀 */
export const MY_IMAGES_DIR = dataPath("my-images");
/** 실행 로그 */
export const LOG_DIR = dataPath("logs");

/** 앱 시작 시 필수 폴더 보장 */
export function ensureAppDirs(): void {
  [DATA_DIR, SESSION_DIR, IMAGE_CACHE_DIR, MY_IMAGES_DIR, LOG_DIR].forEach(
    ensureDir,
  );
}
