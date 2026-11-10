// 자동 업데이트 (electron-updater + GitHub Releases)
//
// 맥에서 고쳐 태그를 밀면(npm run ship) → GitHub Actions 가 윈도우 설치본을 릴리스에 올리고
// → 윈도우 PC 의 앱이 10분 안에 알아채 백그라운드로 받아 → 스스로 재시작해 적용한다.
//
// 윈도우: 사람 손 없이 끝까지 자동.
//   - 받은 뒤 1분 카운트다운 후 재시작 (대시보드 배너에서 "지금 재시작" / "30분 미루기")
//   - 발행·이웃 작업이 도는 중이면 절대 재시작하지 않고, 끝날 때까지 기다렸다가 적용
// 맥    : 코드 서명이 없으면 electron-updater 가 설치를 거부하므로,
//         새 버전만 알려주고 릴리스 페이지를 열어 dmg 를 직접 받게 한다.
//         (Apple Developer 서명을 붙이면 윈도우와 동일한 완전 자동으로 바뀐다)

const { app, dialog, shell, Notification, ipcMain, BrowserWindow } = require("electron");
const { autoUpdater } = require("electron-updater");
const log = require("electron-log");

const RELEASES_URL = "https://github.com/kimseuseu/senbi-auto/releases/latest";
const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10분마다 새 버전 확인
const COUNTDOWN_MS = 60 * 1000; // 받은 뒤 재시작까지 여유 (화면에서 미룰 수 있게)
const BUSY_RETRY_MS = 30 * 1000; // 작업 중이면 이 간격으로 다시 본다
const POSTPONE_MS = 30 * 60 * 1000; // "30분 미루기"

// ▼ Apple Developer ID 서명 + 공증을 붙이는 날 이 값을 true 로 바꾸면
//   맥도 윈도우와 동일하게 완전 자동 업데이트로 동작한다.
//   (미서명·애드혹 서명 상태에서 true 로 두면 설치 단계에서 서명 검증에 실패한다)
const MAC_CODE_SIGNED = false;

// 맥에서 서명이 없으면 자동 설치 불가 → 안내 방식으로 대체
const MAC_MANUAL = process.platform === "darwin" && !MAC_CODE_SIGNED;

/**
 * 화면에 보여 줄 상태. 대시보드는 preload 로 이 값을 받는다.
 * phase: idle | checking | downloading | waiting-job | countdown | postponed | installing | available(맥) | dev
 */
let state = { phase: "idle", current: app.getVersion() };

let hooks = {
  /** 발행·이웃 작업이 도는 중인지 */
  isBusy: async () => false,
  /** 설치 직전 정리 (엔진 종료를 기다린다) */
  beforeInstall: async () => {},
};

let manualCheck = false; // 트레이·화면에서 직접 확인했는지
let macNotified = ""; // 같은 버전 중복 알림 방지 (맥)
let applyTimer = null;
let checkTimer = null;
let postponedUntil = 0;

function setState(patch) {
  state = { ...state, ...patch, current: app.getVersion() };
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("update:state", state);
  }
}

function clearApplyTimer() {
  if (applyTimer) clearTimeout(applyTimer);
  applyTimer = null;
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  new Notification({ title, body }).show();
}

// ---------- 적용 (윈도우) ----------

/** 받아 둔 새 버전을 언제 적용할지 정한다. 작업 중이면 끝날 때까지 미룬다. */
async function scheduleApply() {
  clearApplyTimer();
  if (!state.ready) return;

  const now = Date.now();
  if (postponedUntil > now) {
    setState({ phase: "postponed", applyAt: postponedUntil });
    applyTimer = setTimeout(scheduleApply, postponedUntil - now);
    return;
  }
  if (await hooks.isBusy()) {
    setState({ phase: "waiting-job", applyAt: null });
    applyTimer = setTimeout(scheduleApply, BUSY_RETRY_MS);
    return;
  }
  const applyAt = now + COUNTDOWN_MS;
  setState({ phase: "countdown", applyAt });
  applyTimer = setTimeout(() => void install(), COUNTDOWN_MS);
}

/** 실제 설치. 마지막 순간에도 작업 중이면 다시 기다린다 (카운트다운 사이에 작업을 눌렀을 수 있다). */
async function install({ force = false } = {}) {
  clearApplyTimer();
  if (!state.ready) return { ok: false, reason: "아직 받은 새 버전이 없습니다." };
  if (!force && (await hooks.isBusy())) {
    setState({ phase: "waiting-job", applyAt: null });
    applyTimer = setTimeout(scheduleApply, BUSY_RETRY_MS);
    return { ok: false, reason: "작업이 끝나면 바로 적용합니다." };
  }
  setState({ phase: "installing", applyAt: null });
  log.info(`[updater] v${state.version} 설치 — 재시작`);
  try {
    await hooks.beforeInstall();
  } catch (e) {
    log.warn("[updater] 설치 전 정리 실패(계속 진행):", e);
  }
  // isSilent=true: 설치 마법사 없이 같은 폴더에 덮어쓴다 / isForceRunAfter=true: 끝나면 앱을 다시 띄운다
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
  return { ok: true };
}

// ---------- electron-updater 이벤트 ----------

function setup() {
  log.transports.file.level = "info";
  autoUpdater.logger = log;
  autoUpdater.autoDownload = !MAC_MANUAL; // 맥(미서명)은 받아도 설치 못 하므로 다운로드 안 함
  autoUpdater.autoInstallOnAppQuit = true; // 카운트다운 전에 앱을 꺼도 그때 설치된다

  autoUpdater.on("checking-for-update", () => {
    if (!state.ready && state.phase !== "downloading") setState({ phase: "checking" });
  });

  autoUpdater.on("error", (err) => {
    log.error("[updater] 오류:", err);
    // 받는 도중 끊겼으면 다음 확인 때 다시 받는다. 받아 둔 게 있으면 그 상태를 유지한다.
    if (!state.ready) setState({ phase: "idle", percent: null });
    if (manualCheck) {
      manualCheck = false;
      dialog.showMessageBox({
        type: "error",
        title: "업데이트 확인 실패",
        message: "업데이트 서버에 연결하지 못했습니다.",
        detail: String(err?.message || err),
        buttons: ["확인"],
      });
    }
  });

  autoUpdater.on("update-not-available", () => {
    log.info("[updater] 최신 버전입니다.");
    if (!state.ready) setState({ phase: "idle", checkedAt: Date.now() });
    if (manualCheck) {
      manualCheck = false;
      dialog.showMessageBox({
        type: "info",
        title: "업데이트 확인",
        message: `이미 최신 버전입니다. (v${app.getVersion()})`,
        buttons: ["확인"],
      });
    }
  });

  autoUpdater.on("update-available", (info) => {
    log.info("[updater] 새 버전:", info.version);
    manualCheck = false;
    if (!MAC_MANUAL) {
      // 이미 같은 버전을 받아 뒀으면 상태를 되돌리지 않는다 (10분마다 확인하므로)
      if (state.ready && state.version === info.version) return;
      setState({ phase: "downloading", version: info.version, percent: 0, ready: false });
      return;
    }
    // 맥(미서명): 화면 배너 + 1회 안내 후 릴리스 페이지로
    setState({ phase: "available", version: info.version });
    if (macNotified === info.version) return;
    macNotified = info.version;
    dialog
      .showMessageBox({
        type: "info",
        title: "새 버전이 있습니다",
        message: `senbiPOST v${info.version} 이 나왔습니다. (현재 v${app.getVersion()})`,
        detail: "다운로드 페이지에서 새 dmg를 받아 응용 프로그램 폴더에 덮어써 주세요.",
        buttons: ["다운로드 페이지 열기", "나중에"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) shell.openExternal(RELEASES_URL);
      });
  });

  autoUpdater.on("download-progress", (p) => {
    setState({ phase: "downloading", percent: Math.round(p.percent || 0) });
  });

  autoUpdater.on("update-downloaded", (info) => {
    log.info("[updater] 다운로드 완료:", info.version);
    const fresh = state.version !== info.version || !state.ready;
    setState({ version: info.version, ready: true, percent: 100 });
    if (fresh) {
      postponedUntil = 0;
      notify(
        "senbiPOST 업데이트",
        `v${info.version} 을 받았습니다. 진행 중인 작업이 없으면 1분 뒤 재시작해 적용합니다.`,
      );
    }
    void scheduleApply();
  });
}

function check() {
  // 받아 둔 새 버전이 있으면 적용(재시작)이 먼저다. 그보다 새 버전은 재시작 후에 받는다.
  if (state.ready || state.phase === "installing") return;
  autoUpdater.checkForUpdates().catch(() => {});
}

// ---------- 화면(preload)과 연결 ----------

/** 앱 자체 화면(127.0.0.1)에서 온 요청만 받는다 */
function fromOwnPage(e) {
  try {
    const host = new URL(e.senderFrame?.url || "").hostname;
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
}

function registerIpc() {
  ipcMain.handle("update:get", (e) => (fromOwnPage(e) ? state : null));
  ipcMain.handle("update:install", (e) => {
    if (!fromOwnPage(e)) return { ok: false };
    postponedUntil = 0;
    return install();
  });
  ipcMain.handle("update:postpone", (e) => {
    if (!fromOwnPage(e) || !state.ready) return { ok: false };
    postponedUntil = Date.now() + POSTPONE_MS;
    void scheduleApply();
    return { ok: true };
  });
  ipcMain.handle("update:check", (e) => {
    if (!fromOwnPage(e)) return { ok: false };
    checkNow();
    return { ok: true };
  });
  ipcMain.handle("update:open-download", (e) => {
    if (fromOwnPage(e)) shell.openExternal(RELEASES_URL);
  });
}

// ---------- 공개 API ----------

/**
 * 앱 시작 시 1회 호출. 개발 모드에서는 확인하지 않는다.
 * @param {{ isBusy?: () => Promise<boolean>, beforeInstall?: () => Promise<void> }} h
 */
function start(h = {}) {
  hooks = { ...hooks, ...h };
  registerIpc();
  if (!app.isPackaged) {
    log.info("[updater] 개발 모드 — 업데이트 확인 생략");
    state = { phase: "dev", current: app.getVersion() };
    return;
  }
  setup();
  // 시작 직후는 네트워크·엔진 기동과 겹치므로 조금 늦춘다
  setTimeout(check, 10_000);
  checkTimer = setInterval(check, CHECK_INTERVAL_MS);
  checkTimer.unref?.();
}

/** 트레이 메뉴 "업데이트 확인" 용 */
function checkNow() {
  if (!app.isPackaged) {
    dialog.showMessageBox({
      type: "info",
      title: "업데이트 확인",
      message: "개발 모드에서는 업데이트를 확인하지 않습니다.",
      buttons: ["확인"],
    });
    return;
  }
  if (state.ready) {
    // 이미 받아 둔 게 있으면 다시 받지 않고 적용 쪽으로 보낸다
    void scheduleApply();
    return;
  }
  manualCheck = true;
  check();
}

module.exports = { start, checkNow, RELEASES_URL };
