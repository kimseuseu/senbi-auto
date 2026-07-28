const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");
const updater = require("./updater.cjs");

const PORT = Number(process.env.SENBI_AUTO_PORT || 3060);
const APP_ROOT = path.dirname(__dirname); // senbi-auto/
const URL = `http://127.0.0.1:${PORT}`;
const APP_NAME = "senbiPOST";

// 독·메뉴바 표시 이름 (개발 모드에서도 적용). ready·싱글턴락 이전에 호출해야 함.
app.setName(APP_NAME);

let engine = null; // 엔진 자식 프로세스
let win = null;
let tray = null;
let quitting = false;

// ---------- 엔진(데몬) 실행 ----------
function startEngine() {
  const env = { ...process.env, SENBI_AUTO_PORT: String(PORT) };

  if (app.isPackaged) {
    // 패키지(asar:false): 앱 리소스의 dist/engine.cjs 를 내장 Node로 실행
    const enginePath = path.join(APP_ROOT, "dist", "engine.cjs");
    engine = spawn(process.execPath, [enginePath], {
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      cwd: APP_ROOT,
    });
  } else {
    // 개발: tsx로 소스 직접 실행
    const tsxBin = path.join(
      APP_ROOT,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsx.cmd" : "tsx",
    );
    engine = spawn(tsxBin, ["src/index.ts"], {
      cwd: APP_ROOT,
      env,
      shell: process.platform === "win32",
    });
  }

  engine.stdout?.on("data", (d) => process.stdout.write(`[engine] ${d}`));
  engine.stderr?.on("data", (d) => process.stderr.write(`[engine] ${d}`));
  engine.on("exit", (code) => {
    console.log(`[engine] 종료 (code ${code})`);
    if (!quitting) {
      dialog.showErrorBox("senbi-auto", `엔진이 예기치 않게 종료되었습니다 (code ${code}).`);
    }
  });
}

// ---------- 서버가 뜰 때까지 대기 ----------
function waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(URL, (res) => {
        res.destroy();
        resolve(true);
      });
      req.on("error", () => {
        if (Date.now() > deadline) reject(new Error("서버 시작 시간 초과"));
        else setTimeout(tryOnce, 400);
      });
    };
    tryOnce();
  });
}

// ---------- 메인 창 ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 760,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: "#F7F6F2",
    icon: path.join(APP_ROOT, "build", "icon.png"),
    show: false,
    webPreferences: { contextIsolation: true },
  });

  win.loadURL(URL);
  win.once("ready-to-show", () => win.show());

  // 창을 닫아도 종료하지 않고 트레이로 숨김 (백그라운드 상주)
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
      if (process.platform === "darwin") app.dock?.hide();
    }
  });
}

function showWindow() {
  if (!win) createWindow();
  else {
    win.show();
    win.focus();
  }
  if (process.platform === "darwin") app.dock?.show();
}

// ---------- 트레이 ----------
function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, "tray.png"));
  img.setTemplateImage(true); // 맥 다크/라이트 자동 대응
  tray = new Tray(img);
  tray.setToolTip("senbiPOST — 네이버 블로그 자동화");
  const menu = Menu.buildFromTemplate([
    { label: "대시보드 열기", click: showWindow },
    { label: "브라우저로 열기", click: () => shell.openExternal(URL) },
    { type: "separator" },
    { label: `버전 ${app.getVersion()}`, enabled: false },
    { label: "업데이트 확인…", click: () => updater.checkNow() },
    { type: "separator" },
    { label: "백그라운드 실행 중 (창을 닫아도 유지)", enabled: false },
    { type: "separator" },
    {
      label: "종료",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", showWindow);
}

// ---------- 앱 라이프사이클 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", showWindow);

  app.whenReady().then(async () => {
    // 개발 모드에서만 독 아이콘 지정(패키지는 icon.icns가 자동 적용, build/icon.png 미포함).
    // 실패해도 엔진 시작을 막지 않도록 try/catch.
    try {
      if (!app.isPackaged && process.platform === "darwin" && app.dock) {
        app.dock.setIcon(path.join(APP_ROOT, "build", "icon.png"));
      }
    } catch (e) {
      console.warn("독 아이콘 지정 실패(무시):", e);
    }
    // 메뉴바 앱 이름 = senbiPOST
    app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: app.getVersion() });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: APP_NAME,
          submenu: [
            { role: "about", label: `${APP_NAME} 정보` },
            { type: "separator" },
            { role: "hide", label: `${APP_NAME} 가리기` },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit", label: `${APP_NAME} 종료` },
          ],
        },
        { role: "editMenu" },
        { role: "windowMenu" },
      ]),
    );
    startEngine();
    createTray();
    updater.start();
    try {
      await waitForServer();
      createWindow();
    } catch (err) {
      dialog.showErrorBox("senbi-auto", "엔진 서버를 시작하지 못했습니다.\n" + String(err));
    }
  });

  app.on("activate", showWindow);

  app.on("before-quit", () => {
    quitting = true;
    if (engine && !engine.killed) engine.kill();
  });

  // 업데이트 설치 직전: 엔진을 먼저 정리해 파일 잠금·오류 대화상자를 막는다
  app.on("senbi-before-update-install", () => {
    quitting = true;
    if (engine && !engine.killed) engine.kill();
  });

  // 모든 창이 닫혀도 (트레이 상주) 앱을 끝내지 않는다
  app.on("window-all-closed", () => {});
}
