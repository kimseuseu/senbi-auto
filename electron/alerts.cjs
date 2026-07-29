// 작업 오류 데스크톱 알림
//
// 엔진(자식 프로세스)이 /api/alerts 에 쌓아 둔 오류를 주기적으로 읽어
// 맥 알림센터 / 윈도우 알림으로 띄운다. 클릭하면 대시보드 창이 열린다.

const { Notification } = require("electron");
const http = require("node:http");

const POLL_MS = 15_000;

let timer = null;
let seen = new Set();
let primed = false; // 첫 조회는 '이미 쌓여 있던 것' → 알림 폭탄 방지

function fetchUnread(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/api/alerts?unread=1", timeout: 4000 },
      (res) => {
        let raw = "";
        res.on("data", (d) => (raw += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw).alerts ?? []);
          } catch {
            resolve([]);
          }
        });
      },
    );
    req.on("error", () => resolve([]));
    req.on("timeout", () => {
      req.destroy();
      resolve([]);
    });
  });
}

function notify(alert, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: alert.message,
    body: alert.detail || "대시보드에서 자세한 내용을 확인하세요.",
    urgency: "critical",
  });
  n.on("click", onClick);
  n.show();
}

/**
 * @param {() => number} getPort 엔진 포트 (충돌 시 바뀔 수 있어 매번 읽는다)
 * @param {() => void} onClick 알림 클릭 시 (대시보드 열기)
 */
function start(getPort, onClick) {
  const tick = async () => {
    const alerts = await fetchUnread(getPort());
    const ids = new Set(alerts.map((a) => a.id));
    if (!primed) {
      // 앱을 켠 시점에 이미 있던 알림은 배너로만 보여 주고 팝업은 띄우지 않는다
      seen = ids;
      primed = true;
      return;
    }
    for (const a of alerts) {
      if (seen.has(a.id)) continue;
      notify(a, onClick);
    }
    seen = ids;
  };
  timer = setInterval(() => void tick(), POLL_MS);
  timer.unref?.();
  void tick();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop };
