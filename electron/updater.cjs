// 자동 업데이트 (electron-updater + GitHub Releases)
//
// 윈도우: 백그라운드 다운로드 → "지금 재시작" 클릭 시 설치 후 재실행 (완전 자동)
// 맥    : 코드 서명이 없으면 electron-updater가 설치를 거부하므로,
//         새 버전만 알려주고 릴리스 페이지를 열어 dmg를 직접 받게 한다.
//         (Apple Developer 서명을 붙이면 윈도우와 동일한 완전 자동으로 바뀐다)

const { app, dialog, shell, Notification } = require("electron");
const { autoUpdater } = require("electron-updater");
const log = require("electron-log");

const RELEASES_URL = "https://github.com/kimseuseu/senbi-auto/releases/latest";
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6시간마다 재확인

// ▼ Apple Developer ID 서명 + 공증을 붙이는 날 이 값을 true 로 바꾸면
//   맥도 윈도우와 동일하게 완전 자동 업데이트로 동작한다.
//   (미서명·애드혹 서명 상태에서 true 로 두면 설치 단계에서 서명 검증에 실패한다)
const MAC_CODE_SIGNED = false;

// 맥에서 서명이 없으면 자동 설치 불가 → 안내 방식으로 대체
const MAC_MANUAL = process.platform === "darwin" && !MAC_CODE_SIGNED;

let manualCheck = false; // 트레이 메뉴로 직접 확인했는지
let notified = false; // 같은 버전 중복 알림 방지
let timer = null;

function setup() {
  log.transports.file.level = "info";
  autoUpdater.logger = log;
  autoUpdater.autoDownload = !MAC_MANUAL; // 맥(미서명)은 받아도 설치 못 하므로 다운로드 안 함
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("error", (err) => {
    log.error("[updater] 오류:", err);
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
    if (!MAC_MANUAL) {
      // 윈도우: 조용히 내려받고 완료되면 알림
      if (manualCheck) {
        manualCheck = false;
        new Notification({
          title: "senbiPOST 업데이트",
          body: `새 버전 v${info.version} 을 내려받는 중입니다.`,
        }).show();
      }
      return;
    }
    // 맥(미서명): 안내 후 릴리스 페이지로
    manualCheck = false;
    if (notified) return;
    notified = true;
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

  autoUpdater.on("update-downloaded", (info) => {
    log.info("[updater] 다운로드 완료:", info.version);
    dialog
      .showMessageBox({
        type: "info",
        title: "업데이트 준비 완료",
        message: `senbiPOST v${info.version} 설치 준비가 끝났습니다.`,
        detail: "지금 재시작하면 새 버전으로 바로 실행됩니다. 나중을 선택하면 다음 종료 시 자동 설치됩니다.",
        buttons: ["지금 재시작", "나중에"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          // 엔진 프로세스 정리 후 설치
          app.emit("senbi-before-update-install");
          setImmediate(() => autoUpdater.quitAndInstall());
        }
      });
  });
}

/** 앱 시작 시 1회 호출. 개발 모드에서는 아무것도 하지 않는다. */
function start() {
  if (!app.isPackaged) {
    log.info("[updater] 개발 모드 — 업데이트 확인 생략");
    return;
  }
  setup();
  // 시작 직후는 네트워크·엔진 기동과 겹치므로 조금 늦춘다
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 10_000);
  timer = setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), CHECK_INTERVAL_MS);
  timer.unref?.();
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
  manualCheck = true;
  autoUpdater.checkForUpdates().catch(() => {});
}

module.exports = { start, checkNow, RELEASES_URL };
