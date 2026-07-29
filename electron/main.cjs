const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const { execFile } = require("node:child_process");
const updater = require("./updater.cjs");
const alerts = require("./alerts.cjs");

const APP_ROOT = path.dirname(__dirname); // senbi-auto/
const APP_NAME = "senbiPOST";
const APP_ID = "com.senbi.auto";
const FIRST_PORT = Number(process.env.SENBI_AUTO_PORT || 3060);

// 실제로 쓸 포트 — 3060이 막혀 있으면 다음 빈 포트를 찾아 쓴다 (윈도우는 포트 충돌이 흔하다)
let PORT = FIRST_PORT;
const urlOf = (p = PORT) => `http://127.0.0.1:${p}`;

// 독·메뉴바 표시 이름 (개발 모드에서도 적용). ready·싱글턴락 이전에 호출해야 함.
app.setName(APP_NAME);
// 윈도우 알림(토스트)은 AppUserModelID 가 있어야 표시된다. NSIS 바로가기의 ID와 같아야 한다.
if (process.platform === "win32") app.setAppUserModelId(APP_ID);

/** 127.0.0.1 에서 실제로 바인딩 가능한 포트를 찾는다 */
function findFreePort(start, tries = 20) {
  return new Promise((resolve) => {
    let port = start;
    const attempt = () => {
      if (port >= start + tries) return resolve(start); // 다 막혔으면 원래 포트로 시도
      const srv = net.createServer();
      srv.once("error", () => {
        port++;
        attempt();
      });
      srv.once("listening", () => srv.close(() => resolve(port)));
      srv.listen(port, "127.0.0.1");
    };
    attempt();
  });
}

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
      windowsHide: true,
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
      windowsHide: true,
    });
  }

  engine.stdout?.on("data", (d) => {
    const text = String(d);
    // 엔진이 다른 포트로 떴으면(충돌 회피) 그 포트를 따라간다
    const m = text.match(/SENBI_PORT=(\d+)/);
    if (m) {
      const actual = Number(m[1]);
      if (actual !== PORT) {
        console.log(`[main] 엔진이 ${actual} 포트로 떴습니다 — 대시보드 주소 갱신`);
        PORT = actual;
      }
    }
    process.stdout.write(`[engine] ${text}`);
  });
  // 비정상 종료 원인을 보여 주려고 마지막 출력 몇 줄을 들고 있는다
  const tail = [];
  const remember = (text) => {
    for (const l of String(text).split(/\r?\n/)) if (l.trim()) tail.push(l.trim());
    if (tail.length > 12) tail.splice(0, tail.length - 12);
  };
  engine.stderr?.on("data", (d) => {
    remember(d);
    process.stderr.write(`[engine] ${d}`);
  });
  engine.on("error", (err) => {
    remember(err.message);
    console.error("[engine] 실행 실패", err);
  });
  engine.on("exit", (code) => {
    console.log(`[engine] 종료 (code ${code})`);
    if (quitting) return;
    // 원인 없이 끝난 게 아니라면 마지막 오류 줄을 그대로 보여 준다 (백신·런타임 누락 등)
    dialog.showErrorBox(
      APP_NAME,
      `엔진이 예기치 않게 종료되었습니다 (code ${code}).\n\n` +
        (tail.length ? `마지막 오류:\n${tail.slice(-6).join("\n")}\n\n` : "") +
        "앱을 다시 실행해 보고, 계속 같으면 이 내용을 그대로 알려 주세요.",
    );
  });
}

/**
 * 엔진 종료. 윈도우에서 kill() 은 자식(크로미움 등)을 남기고 죽어
 * 다음 실행 때 포트·프로필이 잠긴다 → taskkill 로 트리째 정리한다.
 */
function stopEngine() {
  if (!engine || engine.killed) return;
  if (process.platform === "win32" && engine.pid) {
    try {
      execFile("taskkill", ["/pid", String(engine.pid), "/T", "/F"], () => {});
      return;
    } catch {
      /* 실패하면 아래 기본 kill */
    }
  }
  engine.kill();
}

// ---------- 서버가 뜰 때까지 대기 ----------
function waitForServer(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(urlOf(), (res) => {
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

  win.loadURL(urlOf());
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
  // 맥은 템플릿(단색) 아이콘, 윈도우는 컬러 아이콘 — 단색을 쓰면 작업표시줄에서 안 보인다
  const isWin = process.platform === "win32";
  const img = nativeImage.createFromPath(
    path.join(__dirname, isWin ? "tray-win.png" : "tray.png"),
  );
  if (!isWin) img.setTemplateImage(true); // 맥 다크/라이트 자동 대응
  tray = new Tray(img);
  tray.setToolTip("senbiPOST — 네이버 블로그 자동화");
  const menu = Menu.buildFromTemplate([
    { label: "대시보드 열기", click: showWindow },
    { label: "브라우저로 열기", click: () => shell.openExternal(urlOf()) },
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
    PORT = await findFreePort(FIRST_PORT);
    if (PORT !== FIRST_PORT) console.log(`[main] ${FIRST_PORT} 포트가 사용 중 → ${PORT} 사용`);
    startEngine();
    createTray();
    updater.start();
    try {
      await waitForServer();
      createWindow();
      // 엔진이 뜬 뒤부터 작업 오류 알림을 감시
      alerts.start(() => PORT, showWindow);
    } catch (err) {
      dialog.showErrorBox(
        APP_NAME,
        "엔진을 시작하지 못했습니다.\n\n" +
          String(err) +
          "\n\n백신이 차단했거나 포트가 막혀 있을 수 있습니다. " +
          "앱을 완전히 종료(작업 관리자에서 senbiPOST)한 뒤 다시 실행해 주세요.",
      );
    }
  });

  app.on("activate", showWindow);

  app.on("before-quit", () => {
    quitting = true;
    alerts.stop();
    stopEngine();
  });

  // 업데이트 설치 직전: 엔진을 먼저 정리해 파일 잠금·오류 대화상자를 막는다
  app.on("senbi-before-update-install", () => {
    quitting = true;
    stopEngine();
  });

  // 모든 창이 닫혀도 (트레이 상주) 앱을 끝내지 않는다
  app.on("window-all-closed", () => {});
}
