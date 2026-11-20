import type { BrowserContext, Frame } from "playwright";
import { humanDelay } from "./session";
import { createLogger } from "../core/logger";

const log = createLogger("manage");

/**
 * 글 관리 — 네이버 임시저장 목록 읽기 · 글 삭제 · 예약 시간 설정.
 * 셀렉터는 2026-11-20 실측. 네이버가 화면을 바꾸면 여기를 고친다.
 */
const SEL = {
  recoveryCancel: ".se-popup-button-cancel",
  publishOpen: '[class*="publish_btn__"]',
  // 임시저장: 저장 버튼 옆 숫자 버튼 → "임시저장 글" 팝업
  tempCount: '[class*="save_count_btn"]',
  tempItems: 'ul[aria-label="임시저장된 글"] li',
  // 글 보기(PC): 더보기 → 삭제하기
  overflowOpen: "a._open_overflowmenu",
  // 발행 패널: 현재 / 예약
  reserveLabel: 'label[for="radio_time2"]',
  reserveRadio: "#radio_time2",
  dateInput: 'input[class*="input_date"]',
  hour: 'select[class*="hour_option"]',
  minute: 'select[class*="minute_option"]',
} as const;

export interface NaverTempDraft {
  title: string;
  savedAt: string;
}

/** 네이버 임시저장함의 글 목록 (읽기만 — 아무것도 열거나 지우지 않는다) */
export async function listNaverTempDrafts(
  context: BrowserContext,
  blogId: string,
): Promise<NaverTempDraft[]> {
  const page = await context.newPage();
  try {
    await page.goto(`https://blog.naver.com/${blogId}?Redirect=Write&`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForSelector("#mainFrame", { timeout: 30000 });
    if (/nidlogin|nid\.naver\.com/.test(page.url())) throw new Error("네이버 세션이 만료되었습니다.");
    const frame = await (await page.$("#mainFrame"))?.contentFrame();
    if (!frame) throw new Error("에디터를 열지 못했습니다.");
    await frame.waitForSelector(SEL.publishOpen, { timeout: 30000 });
    await frame.waitForTimeout(1500);
    const cancel = frame.locator(SEL.recoveryCancel).first();
    if (await cancel.isVisible({ timeout: 2000 }).catch(() => false)) await cancel.click();

    const count = frame.locator(SEL.tempCount).first();
    if (!(await count.isVisible({ timeout: 4000 }).catch(() => false))) return [];
    if ((await count.innerText().catch(() => "0")).trim() === "0") return [];
    await count.click({ timeout: 5000 });
    await frame.locator(SEL.tempItems).first().waitFor({ state: "visible", timeout: 6000 }).catch(() => {});
    const items = await frame.$$eval(SEL.tempItems, (lis) =>
      lis.map((li) => ({
        title: (li.querySelector("strong")?.textContent ?? "").trim(),
        savedAt: (li.querySelector('span[class*="date"]')?.textContent ?? "").trim(),
      })),
    );
    log.info(`네이버 임시저장 글 ${items.length}개 확인 (${blogId})`);
    return items;
  } finally {
    await page.close().catch(() => {});
  }
}

export interface DeleteResult {
  ok: boolean;
  /** 지우기 전에 화면에서 읽은 글 제목 */
  title?: string;
  error?: string;
}

/**
 * 글 하나를 지운다 (네이버에서 영구 삭제 — 되돌릴 수 없다).
 * expectTitle 이 화면의 글 제목과 다르면 지우지 않는다 — 번호를 잘못 넘겨 엉뚱한 글을 지우는 사고를 막는다.
 */
export async function deletePost(
  context: BrowserContext,
  blogId: string,
  logNo: string,
  expectTitle: string,
): Promise<DeleteResult> {
  const page = await context.newPage();
  const viewUrl = `https://blog.naver.com/PostView.naver?blogId=${encodeURIComponent(blogId)}&logNo=${logNo}`;
  const norm = (s: string) => s.replace(/[\s​]/g, "");
  try {
    let gone = false;
    page.on("dialog", (d) => {
      const msg = d.message();
      if (/삭제되었거나|존재하지 않는|없는 게시글/.test(msg)) gone = true;
      // 삭제 확인 창만 받아들인다. 그 밖의 창은 닫는다.
      if (/삭제/.test(msg)) void d.accept().catch(() => {});
      else void d.dismiss().catch(() => {});
    });
    await page.goto(viewUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2500);
    if (gone) return { ok: false, error: "이미 지워졌거나 없는 글입니다." };

    const title = (
      await page
        .locator(".se-title-text, .pcol1 .itemSubjectBoldfont, .htitle")
        .first()
        .innerText({ timeout: 5000 })
        .catch(() => "")
    ).trim();
    if (!title) return { ok: false, error: "글 제목을 읽지 못해 지우지 않았습니다(없는 글이거나 화면이 달라졌습니다)." };
    if (norm(title) !== norm(expectTitle)) {
      return { ok: false, title, error: `제목이 다릅니다 — 화면의 글은 "${title}" 입니다. 지우지 않았습니다.` };
    }

    const del = page.locator(`#overflowmenu-${logNo} a._deletePost, a.btn_del._deletePost`).first();
    if (!(await del.isVisible({ timeout: 1500 }).catch(() => false))) {
      await page.locator(SEL.overflowOpen).first().click({ timeout: 6000 });
      await page.waitForTimeout(600);
    }
    if (!(await del.isVisible({ timeout: 4000 }).catch(() => false))) {
      return { ok: false, title, error: "삭제 버튼을 찾지 못했습니다(내 글이 아니거나 로그인이 풀렸습니다)." };
    }
    await del.click({ timeout: 6000 }); // → 삭제 확인 창 (위 dialog 핸들러가 받아들인다)
    await humanDelay(2, 3.5);

    // 실제로 지워졌는지 다시 열어 확인한다
    gone = false;
    await page.goto(viewUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const still = await page.locator(`#overflowmenu-${logNo}`).count().catch(() => 0);
    if (gone || still === 0) {
      log.info(`글 삭제 완료: ${blogId}/${logNo} "${title}"`);
      return { ok: true, title };
    }
    return { ok: false, title, error: "삭제를 눌렀지만 글이 그대로 있습니다." };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * 열려 있는 발행 패널에서 '예약'을 고르고 날짜·시·분을 맞춘다.
 * 값이 실제로 들어갔는지 다시 읽어 확인하고, 하나라도 다르면 사유를 돌려준다(호출한 쪽이 발행을 중단한다).
 * @returns 문제 사유 (잘 맞췄으면 null)
 */
export async function setReserveTime(frame: Frame, at: Date): Promise<string | null> {
  const y = at.getFullYear();
  const mo = at.getMonth() + 1;
  const d = at.getDate();
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  try {
    await frame.locator(SEL.reserveLabel).first().click({ timeout: 5000 });
    await frame.waitForTimeout(700);
    if (!(await frame.locator(SEL.reserveRadio).first().isChecked().catch(() => false))) {
      return "예약 항목이 선택되지 않았습니다.";
    }
    const readDate = async (): Promise<string> => {
      const nums = (await frame.locator(SEL.dateInput).first().inputValue()).match(/\d+/g) ?? [];
      return nums.map(Number).join("-");
    };
    if ((await readDate()) !== `${y}-${mo}-${d}`) {
      await frame.locator(SEL.dateInput).first().click({ timeout: 5000 });
      const cal = frame.locator(".ui-datepicker").first();
      await cal.waitFor({ state: "visible", timeout: 5000 });
      for (let i = 0; i < 12; i++) {
        const cy = Number((await cal.locator(".ui-datepicker-year").innerText()).replace(/\D/g, ""));
        const cm = Number((await cal.locator(".ui-datepicker-month").innerText()).replace(/\D/g, ""));
        if (cy === y && cm === mo) break;
        await cal.locator(".ui-datepicker-next").click({ timeout: 4000 });
        await frame.waitForTimeout(350);
      }
      await cal
        .locator("td:not(.ui-state-disabled) button", { hasText: new RegExp(`^\\s*${d}\\s*$`) })
        .first()
        .click({ timeout: 4000 });
      await frame.waitForTimeout(500);
      const got = await readDate();
      if (got !== `${y}-${mo}-${d}`) return `예약 날짜가 맞지 않습니다(화면 ${got}).`;
    }
    await frame.locator(SEL.hour).first().selectOption(hh);
    await frame.locator(SEL.minute).first().selectOption(mm);
    await frame.waitForTimeout(400);
    const gotH = await frame.locator(SEL.hour).first().inputValue();
    const gotM = await frame.locator(SEL.minute).first().inputValue();
    if (gotH !== hh || gotM !== mm) return `예약 시각이 맞지 않습니다(화면 ${gotH}:${gotM}).`;
    log.info(`예약 발행 시간 설정: ${y}-${mo}-${d} ${hh}:${mm}`);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message.split("\n")[0]! : String(err);
  }
}
