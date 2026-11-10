// 대시보드 화면 ↔ 앱(메인 프로세스) 다리.
// 화면은 브라우저로도 열 수 있으므로, window.senbiApp 이 없으면 업데이트 배너를 그냥 안 띄운다.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("senbiApp", {
  update: {
    get: () => ipcRenderer.invoke("update:get"),
    onChange: (cb) => {
      const h = (_e, s) => cb(s);
      ipcRenderer.on("update:state", h);
      return () => ipcRenderer.removeListener("update:state", h);
    },
    installNow: () => ipcRenderer.invoke("update:install"),
    postpone: () => ipcRenderer.invoke("update:postpone"),
    check: () => ipcRenderer.invoke("update:check"),
    openDownload: () => ipcRenderer.invoke("update:open-download"),
  },
});
