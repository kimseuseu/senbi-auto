import "dotenv/config";
import { launchContext, closeContext } from "../naver/session";

const logNo = process.argv[2] ?? "224360176005";
const DUMP = `(() => {
  const rows = [];
  document.querySelectorAll(".se-component").forEach((c) => {
    const cls = String(c.className || "");
    const kind = /se-quotation/.test(cls) ? "인용구" : /sectionTitle/.test(cls) ? "소제목"
      : /se-oglink/.test(cls) ? "링크카드" : /se-text/.test(cls) ? "본문" : /se-image/.test(cls) ? "이미지" : null;
    if (!kind || kind === "이미지") return;
    let color = "-";
    for (const sp of c.querySelectorAll("span[style*='color']")) {
      const m = (sp.getAttribute("style")||"").match(/(?:^|[;\\s])color:\\s*(#[0-9a-fA-F]{6})/);
      const t = (sp.textContent||"").replace(/[\\s\\u200b]/g,"");
      if (m && t) { color = m[1].toLowerCase(); break; }
    }
    const bold = !!c.querySelector("b, strong");
    const t = (c.innerText || "").trim().replace(/\\s+/g, " ").slice(0, 24);
    rows.push(kind + " | " + color + (bold ? " 굵게" : "") + " :: " + t);
  });
  return JSON.stringify(rows.slice(0, 40), null, 1);
})()`;

async function main() {
  const ctx = await launchContext({ headless: true, accountId: "acc-ojs5404" });
  try {
    const page = await ctx.newPage();
    await page.goto(`https://m.blog.naver.com/ojs5404/${logNo}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    console.log("제목:", await page.title());
    console.log(await page.evaluate(DUMP).catch((e) => "덤프오류:" + String(e).slice(0, 60)));
  } finally { await closeContext(ctx); }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
