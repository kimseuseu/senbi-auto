import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 설치 파일(dmg·exe)을 만들고 나면, 그 과정에서 풀어 놓은 앱 폴더는 더 쓸 일이 없다.
// 남겨 두면 맥 검색(Spotlight)에 senbiPOST.app 이 여러 개 떠서
// 설치한 앱 대신 이쪽을 열게 된다 — 그러면 다음 빌드 때 실행 중인 앱이 덮어써진다.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const release = path.join(root, "release");

const UNPACKED = ["mac", "mac-arm64", "mac-universal", "win-unpacked", "win-arm64-unpacked", "linux-unpacked"];

for (const name of UNPACKED) {
  const dir = path.join(release, name);
  if (!fs.existsSync(dir)) continue;
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("빌드 중간 결과물 정리:", path.relative(root, dir));
}
