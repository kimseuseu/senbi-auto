import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 8갈래 별표(✳) 막대 — 중심에서 0/45/90/135° 회전한 둥근 막대 4개 */
function asteriskBars(len: number, thick: number): string {
  const rx = (thick / 2).toFixed(1);
  const bar = `<rect x="${(-thick / 2).toFixed(1)}" y="${(-len / 2).toFixed(1)}" width="${thick.toFixed(1)}" height="${len.toFixed(1)}" rx="${rx}"/>`;
  return [0, 45, 90, 135].map((a) => `<g transform="rotate(${a})">${bar}</g>`).join("");
}

/** 앱 아이콘 — 순수 블랙 스퀘어클 + 은은한 광채 + 글로시 메탈 별표 */
function appIconSvg(size: number): string {
  const s = size;
  const margin = s * 0.094; // 맥 아이콘 여백
  const box = s - margin * 2;
  const radius = box * 0.225; // 스퀘어클 근사
  const c = s / 2;
  const len = box * 0.62;
  const thick = box * 0.156;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <defs>
    <linearGradient id="metal" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="0.42" stop-color="#d2d2d9"/>
      <stop offset="0.7" stop-color="#83838d"/>
      <stop offset="1" stop-color="#3f3f49"/>
    </linearGradient>
    <radialGradient id="bg" cx="50%" cy="34%" r="72%">
      <stop offset="0" stop-color="#1b1b20"/>
      <stop offset="0.55" stop-color="#0c0c0e"/>
      <stop offset="1" stop-color="#060607"/>
    </radialGradient>
    <radialGradient id="glow" cx="50%" cy="40%" r="46%">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.20"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="spec" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.9"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <filter id="drop" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="${(s * 0.02).toFixed(1)}" stdDeviation="${(s * 0.028).toFixed(1)}" flood-color="#000000" flood-opacity="0.6"/>
    </filter>
  </defs>
  <rect x="${margin.toFixed(1)}" y="${margin.toFixed(1)}" width="${box.toFixed(1)}" height="${box.toFixed(1)}" rx="${radius.toFixed(1)}" fill="url(#bg)"/>
  <rect x="${margin.toFixed(1)}" y="${margin.toFixed(1)}" width="${box.toFixed(1)}" height="${box.toFixed(1)}" rx="${radius.toFixed(1)}" fill="url(#glow)"/>
  <g transform="translate(${c},${c})" filter="url(#drop)">
    <g fill="url(#metal)">${asteriskBars(len, thick)}</g>
    <g fill="url(#spec)" opacity="0.55">${asteriskBars(len * 0.8, thick * 0.32)}</g>
  </g>
</svg>`;
}

/** 트레이/메뉴바 — 템플릿(단색 검정 실루엣, 투명 배경). 작아도 또렷하게 굵은 별표 */
function traySvg(size: number): string {
  const c = size / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <g transform="translate(${c},${c})" fill="#000000">${asteriskBars(size * 0.92, size * 0.28)}</g>
</svg>`;
}

async function main() {
  fs.mkdirSync(path.join(root, "build"), { recursive: true });
  fs.mkdirSync(path.join(root, "electron"), { recursive: true });

  // 앱 아이콘 1024 (electron-builder가 icns/ico로 자동 변환)
  await sharp(Buffer.from(appIconSvg(1024))).png().toFile(path.join(root, "build", "icon.png"));

  // 트레이 템플릿 (@1x 22 · @2x 44)
  await sharp(Buffer.from(traySvg(22))).png().toFile(path.join(root, "electron", "tray.png"));
  await sharp(Buffer.from(traySvg(44))).png().toFile(path.join(root, "electron", "tray@2x.png"));

  console.log("아이콘 생성 완료: build/icon.png, electron/tray.png(@2x)");
}

main().catch((e) => {
  console.error("아이콘 생성 실패:", e);
  process.exit(1);
});
