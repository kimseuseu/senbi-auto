import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import { createLogger } from "../core/logger";
import { addAlert } from "../core/alerts";

const log = createLogger("browserSetup");

/**
 * 설치본에는 Playwright용 Chromium 바이너리가 들어 있지 않다(용량 문제).
 * 그래서 처음 브라우저가 필요한 순간에 자동으로 내려받는다.
 * 사용자가 터미널에서 `npx playwright install` 을 칠 일이 없도록 하는 게 목적.
 */
export type BrowserState = "ready" | "installing" | "missing" | "failed";

let state: BrowserState = "missing";
let progress = "";
let lastError = "";
let inflight: Promise<boolean> | null = null;

export function browserStatus(): { state: BrowserState; progress: string; error: string } {
  if (state === "missing" && isInstalled()) state = "ready";
  return { state, progress, error: lastError };
}

/** Chromium 바이너리가 실제로 있는지 */
export function isInstalled(): boolean {
  try {
    const exe = chromium.executablePath();
    return Boolean(exe) && fs.existsSync(exe);
  } catch {
    return false;
  }
}

/**
 * playwright CLI 경로 — 패키지 안에서도 resources/app/node_modules 를 찾는다.
 * cli.js 는 exports 에 없어 직접 resolve 가 막히므로 package.json 위치에서 bin 을 조합한다.
 */
function cliPath(): string | null {
  const require = createRequire(import.meta.url);
  for (const pkg of ["playwright", "playwright-core"]) {
    try {
      const manifest = require.resolve(`${pkg}/package.json`);
      const bin = JSON.parse(fs.readFileSync(manifest, "utf8")).bin?.[pkg] ?? "cli.js";
      const cli = path.join(path.dirname(manifest), bin);
      if (fs.existsSync(cli)) return cli;
    } catch {
      /* 다음 후보 */
    }
  }
  return null;
}

function runInstall(): Promise<boolean> {
  return new Promise((resolve) => {
    const cli = cliPath();
    if (!cli) {
      lastError = "playwright 설치 도구를 찾지 못했습니다.";
      state = "failed";
      resolve(false);
      return;
    }

    state = "installing";
    progress = "브라우저 내려받는 중… (최초 1회, 1~3분)";
    lastError = "";
    log.info("Chromium 자동 설치 시작 — 최초 1회만 받습니다");

    // 엔진은 ELECTRON_RUN_AS_NODE=1 로 도니 execPath 를 그대로 node 처럼 쓸 수 있다
    const child = spawn(process.execPath, [cli, "install", "chromium"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
    });

    const onOut = (d: Buffer) => {
      const line = d.toString().trim();
      if (!line) return;
      // "|████ | 42% of 150 MiB" 같은 진행 표시를 그대로 보여 준다
      const pct = line.match(/(\d{1,3})%/)?.[1];
      progress = pct ? `브라우저 내려받는 중… ${pct}%` : progress;
      log.info(`[playwright] ${line.split("\n").pop()}`);
    };
    child.stdout?.on("data", onOut);
    child.stderr?.on("data", onOut);

    child.on("error", (err) => {
      lastError = err.message;
      state = "failed";
      resolve(false);
    });

    child.on("exit", (code) => {
      if (code === 0 && isInstalled()) {
        state = "ready";
        progress = "";
        log.info("Chromium 설치 완료");
        resolve(true);
        return;
      }
      state = "failed";
      lastError =
        lastError ||
        `설치 프로그램이 코드 ${code} 로 종료했습니다. 인터넷 연결이나 회사 방화벽을 확인해 주세요.`;
      resolve(false);
    });
  });
}

/**
 * 브라우저가 준비될 때까지 보장한다. 이미 있으면 즉시 반환.
 * 동시에 여러 작업이 불러도 실제 설치는 한 번만 돈다.
 */
export async function ensureChromium(): Promise<void> {
  if (isInstalled()) {
    state = "ready";
    return;
  }
  if (!inflight) inflight = runInstall().finally(() => (inflight = null));
  const ok = await inflight;
  if (ok) return;

  addAlert({
    kind: "post",
    message: "자동화용 브라우저를 준비하지 못해 작업을 시작할 수 없습니다",
    detail: `${lastError} — 인터넷에 연결한 뒤 앱을 다시 시작하면 자동으로 다시 받습니다.`,
  });
  throw new Error(`자동화용 브라우저(Chromium)를 준비하지 못했습니다. ${lastError}`);
}

/** 엔진 시작 시 백그라운드로 미리 받아 둔다 (실패해도 데몬은 계속 뜬다) */
export function prefetchChromium(): void {
  if (isInstalled()) {
    state = "ready";
    return;
  }
  log.info("자동화용 브라우저가 없어 미리 내려받습니다");
  void ensureChromium().catch((err) => log.warn("브라우저 사전 준비 실패", err));
}
