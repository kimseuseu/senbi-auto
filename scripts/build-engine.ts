import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 엔진(src/index.ts)을 dist/engine.cjs 한 파일로 번들.
// 네이티브/브라우저 의존성은 external로 두고 electron-builder가 node_modules에 포함한다.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function main() {
  const outfile = path.join(root, "dist", "engine.cjs");
  await esbuild.build({
    entryPoints: [path.join(root, "src", "index.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
    external: ["sharp", "playwright", "playwright-core", "fsevents"],
    // CJS 번들에서 import.meta.url 이 undefined 가 되는 문제 → 번들 파일 URL로 shim
    banner: { js: "const __IMPORT_META_URL__ = require('url').pathToFileURL(__filename).href;" },
    define: { "import.meta.url": "__IMPORT_META_URL__" },
    logLevel: "info",
  });

  // 대시보드 정적 파일을 번들 옆(dist/public)으로 복사
  const srcPublic = path.join(root, "src", "server", "public");
  const dstPublic = path.join(root, "dist", "public");
  fs.rmSync(dstPublic, { recursive: true, force: true });
  fs.cpSync(srcPublic, dstPublic, { recursive: true });

  console.log("엔진 번들 완료:", outfile);
}

main().catch((e) => {
  console.error("엔진 번들 실패:", e);
  process.exit(1);
});
