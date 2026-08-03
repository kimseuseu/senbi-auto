import type { BrowserContext, Frame, Locator, Page } from "playwright";
import type { ImageAsset, PreparedSignature, QuoteStyle, BlockStyle, TextRun } from "../core/types";
import type { BodyBlock } from "../generate/structure";
import { humanDelay } from "./session";
import { shouldStop } from "../core/cancel";
import { createLogger } from "../core/logger";

const STOPPED: PublishResult = { ok: false, mode: "failed", error: "작업 중지됨" };

const log = createLogger("publish");

/**
 * 네이버 SmartEditor ONE 실제 DOM에 맞춰 튜닝된 셀렉터 (2026-07 검증).
 * 대부분 안정적인 구조/‌id 기반이라 클래스 해시 변경에 강하다.
 */
const SEL = {
  frame: "#mainFrame",
  recoveryCancel: ".se-popup-button-cancel", // "작성 중인 글" 복구 팝업 → 취소
  title: ".se-documentTitle .se-text-paragraph",
  body: ".se-section:not(.se-section-documentTitle) .se-text-paragraph",
  imageButton: ".se-image-toolbar-button", // 상단 "사진" → 파일선택창
  imageCollage: ".se-image-type-option-collage", // 2장+ 업로드 시 "사진 첨부 방식" → 콜라주(그리드)
  imageAlignCenter: ".se-align-center-toolbar-button", // 선택된 이미지 가운데 정렬
  // 서식 (19pt · 가운데 정렬)
  fontSizeButton: ".se-font-size-code-toolbar-button",
  fontSize19: ".se-toolbar-option-font-size-code-fs19-button",
  fontFamilyButton: ".se-font-family-toolbar-button",
  boldButton: ".se-bold-toolbar-button",
  fontColorButton: ".se-font-color-toolbar-button",
  italicButton: ".se-italic-toolbar-button",
  alignButton: ".se-toolbar-item-align button",
  alignCenter: ".se-toolbar-option-icon-button[data-value='center']",
  // 문단 서식 (본문▾ → 본문/소제목/인용구) — 2026-07 실측
  textFormatButton: ".se-text-format-toolbar-button",
  formatText: ".se-toolbar-option-text-format-text-button",
  formatSectionTitle: ".se-toolbar-option-text-format-sectionTitle-button",
  formatQuotation: ".se-toolbar-option-text-format-quotation-button",
  publishOpen: '[class*="publish_btn__"]', // 상단 발행(패널 열기)
  saveDraft: '[class*="save_btn__"]', // 저장(임시저장) — 저장목록(save_count_btn)과 구분
  tagInput: "#tag-input",
  // 발행 패널의 카테고리 선택 (2026-08 실측)
  //  <button class="selectbox_button__…" aria-label="카테고리 목록 버튼">대문</button>
  //  <div role="menu"><li><input id="59_냉방기기"><label for="59_냉방기기">…</label></li>…
  // 클래스는 해시가 붙어 바뀌므로 aria-label·role 같은 의미 속성을 먼저 쓴다.
  categoryOpen: [
    'button[aria-label*="카테고리"]',
    '[class*="option_category"] [class*="selectbox_button"]',
    '[class*="selectbox_button"]',
  ],
  categoryMenu: '[role="menu"]',
  confirmPublish: "[class*=confirm_btn]", // 패널 내 확정 발행
  visibility: {
    all: "#open_public",
    neighbor: "#open_neighbor",
    both: "#open_both_neighbor",
    private: "#open_private",
  },
} as const;

export type Visibility = "all" | "neighbor" | "both" | "private";

export interface PublishInput {
  blogId: string;
  /** content(줄바꿈 적용본)가 있으면 그걸로 잦은 줄바꿈 재현, 없으면 rawContent */
  post: { title: string; content?: string; rawContent: string };
  /** 문단·소제목·인용구 순서 (있으면 이걸로 타이핑; 없으면 content를 문단 분할) */
  structuredBody?: BodyBlock[];
  /** 인사말(첫 문단)의 원문 서식 — 색·굵기 재현용 */
  introStyle?: { color?: string; bold?: boolean };
  /** 학습한 글자 서식 (서체·크기·소제목 굵게/기울임) */
  textStyle?: {
    bodyFont?: string;
    bodySize?: string;
    bodyColor?: string;
    headingBold?: boolean;
    headingItalic?: boolean;
    headingSize?: string;
  };
  /** 본문 안에서 특정 문구만 색을 다르게 쓰는 규칙 (상호명 등) */
  inlineColors?: { text: string; style: BlockStyle }[];
  images: ImageAsset[]; // 본문 이미지 (1장씩 단독·가운데)
  thumbnail?: ImageAsset; // 맨 위 단독·가운데
  /** 제품사양 표 — 자주 묻는 질문 앞에 단독으로 넣는다 */
  specImage?: ImageAsset;
  signature?: PreparedSignature; // 맨 아래 서명 (글·이미지 순서대로)
  tags?: string[];
  /** 발행할 카테고리 이름 (비우면 블로그 기본 카테고리) */
  category?: string;
  visibility?: Visibility;
  /** true면 발행하지 않고 임시저장까지만 (안전 테스트용) */
  dryRun?: boolean;
  /** 종료 직전 스크린샷 저장 경로 (디버그·검증용) */
  debugScreenshot?: string;
}

export interface PublishResult {
  ok: boolean;
  url?: string;
  mode: "published" | "draft" | "failed";
  error?: string;
  /** 네이버 세션 만료로 실패(글쓰기 페이지가 로그인으로 리다이렉트) */
  sessionExpired?: boolean;
}

/** "1. " "- " 같은 목록 표기 제거 — 에디터 자동 목록 변환을 막는다 (타이핑·매칭에 동일 적용) */
function stripListMarker(s: string): string {
  return s.replace(/^\s*(?:\d+[.)]|[-•*])\s+/, "");
}

async function getFrame(page: Page): Promise<Frame> {
  const el = await page.waitForSelector(SEL.frame, { timeout: 30000 });
  const frame = await el.contentFrame();
  if (!frame) throw new Error("에디터 iframe(#mainFrame)을 찾지 못했습니다.");
  return frame;
}

/** 학습한 서체를 지정 (예: nanumbarungothic). best-effort */
async function applyFontFamily(frame: Frame, font?: string): Promise<void> {
  if (!font) return;
  try {
    await frame.locator(SEL.fontFamilyButton).first().click({ timeout: 4000 });
    await frame.waitForTimeout(400);
    await frame.locator(`.se-toolbar-option-font-family-${font}-button`).first().click({ timeout: 3500 });
    await frame.waitForTimeout(300);
  } catch (err) {
    log.warn(`서체(${font}) 지정 실패(무시)`, err);
  }
}

/**
 * 현재 커서 위치에 글자크기(학습값·기본 19pt) + 가운데 정렬 적용.
 *
 * ⚠️ 이미지가 선택돼 있으면 글자 툴바가 이미지 툴바로 바뀌어 이 버튼들이 사라진다.
 *    그때 기본 타임아웃(30초)으로 기다리면 발행이 몇 분씩 늘어지므로 짧게 끊는다.
 */
const TOOLBAR_TIMEOUT = 3000;

/** 글자크기만 지정 (정렬은 건드리지 않는다 — 조각 단위 서식에 쓴다) */
async function applySize(frame: Frame, sizeCode: string): Promise<void> {
  try {
    await frame.locator(SEL.fontSizeButton).first().click({ timeout: TOOLBAR_TIMEOUT });
    await frame.waitForTimeout(350);
    await frame
      .locator(`.se-toolbar-option-font-size-code-${sizeCode}-button`)
      .first()
      .click({ timeout: TOOLBAR_TIMEOUT });
    await frame.waitForTimeout(250);
  } catch (err) {
    log.warn(`글자크기(${sizeCode}) 설정 실패(무시)`, err);
  }
}

/** 굵게 토글 */
async function toggleBold(frame: Frame): Promise<void> {
  try {
    await frame.locator(SEL.boldButton).first().click({ timeout: TOOLBAR_TIMEOUT });
    await frame.waitForTimeout(220);
  } catch (err) {
    log.warn("굵게 토글 실패(무시)", err);
  }
}

async function applyFormat(frame: Frame, sizeCode = "fs19"): Promise<void> {
  await applySize(frame, sizeCode);
  try {
    await frame.locator(SEL.alignButton).first().click({ timeout: TOOLBAR_TIMEOUT });
    await frame.waitForTimeout(350);
    await frame.locator(SEL.alignCenter).first().click({ timeout: TOOLBAR_TIMEOUT });
    await frame.waitForTimeout(250);
  } catch (err) {
    log.warn("가운데 정렬 설정 실패(무시)", err);
  }
}

/**
 * 견고한 클릭 — 요소가 가려지거나 애니메이션 중이라 기본 클릭이 멈추는 것을 방지.
 * 스크롤로 보이게 → 짧은 타임아웃 일반 클릭 시도 → 마지막엔 force 클릭 폴백.
 */
async function robustClick(target: Locator, label: string): Promise<void> {
  await target.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (attempt < 3) {
        await target.click({ timeout: 8000 });
      } else {
        // 마지막 시도: 액션가능 검사 우회(가려짐/애니메이션 무시)
        await target.click({ force: true, timeout: 5000 });
      }
      return;
    } catch (err) {
      if (attempt === 3) throw err;
      log.warn(`${label} 클릭 재시도 ${attempt}/3`, err);
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
}

/**
 * 이미지 업로드가 끝날 때까지 대기 — 업로드 중엔 발행 버튼이 오버레이/비활성이라
 * 클릭이 멈춘다. 네트워크 유휴 + 업로드 진행 표시가 사라질 때까지(best-effort).
 */
async function waitForUploadsSettle(page: Page, frame: Frame): Promise<void> {
  // 1) 이미지 업로드 XHR이 끝날 때까지 (네트워크 유휴가 가장 신뢰도 높은 신호)
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  // 2) 보이는 업로드 진행 표시가 사라질 때까지 (최대 15초 — 숨은 템플릿에 걸리지 않게 :visible)
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const uploading = await frame
      .locator('[class*="uploading"]:visible, [class*="progress_bar"]:visible')
      .count()
      .catch(() => 0);
    if (uploading === 0) break;
    await frame.waitForTimeout(1000);
  }
  await frame.waitForTimeout(1500); // 마지막 안정화
}

/**
 * 글자색 지정 — 팔레트에서 정확히 같은 색을 찾고, 없으면 가장 가까운 색을 고른다.
 * (네이버 팔레트는 71색 고정이라 원문 색이 그대로 없을 수 있다. 예: #062ed2)
 */
async function applyColor(frame: Frame, hex: string): Promise<boolean> {
  const target = hex.trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(target)) return false;
  try {
    await frame.locator(SEL.fontColorButton).first().click({ timeout: 4000 });
    await frame.waitForTimeout(500);
    // 팔레트 버튼들의 hex를 읽어 가장 가까운 색의 인덱스를 고른다
    const pickJs = `(() => {
      const btns = Array.from(document.querySelectorAll(".se-color-palette"));
      const t = "${target}";
      const rgb = (h) => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
      const [tr,tg,tb] = rgb(t);
      let bestIdx = -1, bestD = Infinity, exact = -1;
      btns.forEach((b, i) => {
        const s = (b.textContent || "").trim().toLowerCase();
        if (!/^#[0-9a-f]{6}$/.test(s)) return;
        if (s === t) exact = i;
        const [r,g,bl] = rgb(s);
        const d = (r-tr)**2 + (g-tg)**2 + (bl-tb)**2;
        if (d < bestD) { bestD = d; bestIdx = i; }
      });
      return JSON.stringify({ idx: exact >= 0 ? exact : bestIdx, exact: exact >= 0 });
    })()`;
    const res = JSON.parse(String(await frame.evaluate(pickJs))) as { idx: number; exact: boolean };
    if (res.idx < 0) return false;
    await frame.locator(".se-color-palette").nth(res.idx).click({ timeout: 4000 });
    await frame.waitForTimeout(350);
    if (!res.exact) log.info(`색 ${target}는 팔레트에 없어 가장 가까운 색으로 적용`);
    return true;
  } catch (err) {
    log.warn(`글자색(${target}) 적용 실패(무시)`, err);
    return false;
  }
}

/**
 * 본문에 이미 찍힌 글에서 **특정 문구만** 골라 색을 입힌다.
 *
 * 원문은 "각종 집기 렌탈 전문 MBC렌탈입니다." 처럼 줄 안에서 상호명만 색이 다르다.
 * 우리가 쓴 본문은 문장이 매번 달라 타이핑 중에 조각을 나눌 수 없으니,
 * 다 찍은 뒤 그 문구가 있는 문단을 찾아 그 글자만 선택해 칠한다.
 * (Home → →키로 앞까지 이동 → Shift+→ 로 문구 길이만큼 선택)
 */
async function applyInlineColors(
  frame: Frame,
  page: Page,
  rules: { text: string; style: BlockStyle }[],
): Promise<void> {
  const list = rules.filter((r) => r.text.trim().length >= 2 && r.style.color);
  if (list.length === 0) return;

  let ok = 0;
  let tried = 0;
  for (const rule of list) {
    const needle = rule.text.trim();
    // 문단마다 이 문구가 몇 번째 글자에서 시작하는지 찾는다 (앞에서부터 최대 3곳)
    const spotsJs = `(() => {
      const ps = Array.from(document.querySelectorAll(".se-text-paragraph"));
      const needle = ${JSON.stringify(needle)};
      const out = [];
      for (let i = 0; i < ps.length && out.length < 3; i++) {
        const t = (ps[i].innerText || "").replace(/\\u200b/g, "");
        const at = t.indexOf(needle);
        if (at >= 0) out.push({ idx: i, at });
      }
      return JSON.stringify(out);
    })()`;
    let spots: { idx: number; at: number }[] = [];
    try {
      spots = JSON.parse(String(await frame.evaluate(spotsJs)));
    } catch {
      spots = [];
    }
    for (const spot of spots) {
      tried++;
      try {
        const para = frame.locator(".se-text-paragraph").nth(spot.idx);
        await para.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
        await para.click({ timeout: 2500 });
        await frame.waitForTimeout(200);
        await page.keyboard.press("Home");
        for (let i = 0; i < spot.at; i++) await page.keyboard.press("ArrowRight");
        for (let i = 0; i < needle.length; i++) await page.keyboard.press("Shift+ArrowRight");
        await frame.waitForTimeout(200);
        if (rule.style.bold) await toggleBold(frame);
        const done = await applyColor(frame, rule.style.color!);
        if (rule.style.bold) await toggleBold(frame);
        await page.keyboard.press("End"); // 선택 해제
        if (done) ok++;
      } catch (err) {
        log.warn(`문구 색(${needle}) 적용 실패`, err);
      }
    }
  }
  if (tried > 0) log.info(`문구 색 적용 ${ok}/${tried} (규칙 ${list.length}개)`);
}

/**
 * 원문의 글자 조각(run) 서식을 그대로 살려 타이핑한다.
 *
 * 원문은 한 줄 안에서 상호명만 색을 바꾸거나("각종 집기 렌탈 전문 MBC렌탈입니다."),
 * 서명 줄을 손글씨체·파란색·24pt로 쓴다. 줄 전체를 칠하는 방식으로는 이걸 못 따라간다.
 * 조각마다 서식을 먼저 맞춰 두고 타이핑하면 선택 없이 그대로 재현된다.
 */
async function typeStyledRuns(
  page: Page,
  frame: Frame,
  runs: TextRun[],
  base: { font?: string; size?: string; color?: string },
): Promise<void> {
  let curFont = base.font;
  let curSize = base.size;
  let curColor = base.color;
  let curBold = false;

  for (const r of runs) {
    if (r.text === "\n") {
      await page.keyboard.press("Shift+Enter");
      continue;
    }
    const s = r.style ?? {};
    const font = s.font ?? base.font;
    const size = s.size ?? base.size;
    const color = s.color ?? base.color;
    const bold = Boolean(s.bold);

    if (font && font !== curFont) {
      await applyFontFamily(frame, font);
      curFont = font;
    }
    if (size && size !== curSize) {
      await applySize(frame, size);
      curSize = size;
    }
    if (color && color !== curColor) {
      await applyColor(frame, color);
      curColor = color;
    }
    if (bold !== curBold) {
      await toggleBold(frame);
      curBold = bold;
    }
    await page.keyboard.type(r.text, { delay: 6 });
  }
  // 다음 줄에 굵게가 새어 나가지 않게 되돌린다
  if (curBold) await toggleBold(frame);
}

/**
 * 링크 카드(se-oglink) 삽입 — 네이버 에디터는 URL을 입력하면 미리보기 카드를 자동으로 만든다.
 * 카드가 생긴 뒤 URL 텍스트 줄을 지우면 카드만 남는다(사장님이 손으로 하던 방식 그대로).
 */
async function insertOgLink(page: Page, frame: Frame, url: string): Promise<boolean> {
  try {
    const before = await frame.locator(".se-component.se-oglink").count().catch(() => 0);
    await page.keyboard.type(url, { delay: 12 });
    await page.keyboard.press("Enter"); // 입력 확정 → 카드 생성 트리거
    // 카드가 실제로 생길 때까지 대기 (미리보기 로딩)
    let made = false;
    for (let i = 0; i < 12; i++) {
      await frame.waitForTimeout(700);
      const now = await frame.locator(".se-component.se-oglink").count().catch(() => 0);
      if (now > before) {
        made = true;
        break;
      }
    }
    if (!made) {
      log.warn(`링크 카드가 만들어지지 않음 — URL 텍스트로 남김: ${url}`);
      await page.keyboard.press("Enter");
      return false;
    }
    // URL 텍스트가 그대로 남아 있으면 그 줄만 삭제 (카드는 별도 컴포넌트라 안 지워짐)
    const removeJs = `(() => {
      const ps = Array.from(document.querySelectorAll(".se-text-paragraph"));
      const t = ${JSON.stringify(url)};
      const hit = ps.find((p) => (p.innerText || "").trim() === t);
      return hit ? ps.indexOf(hit) : -1;
    })()`;
    const idx = Number(await frame.evaluate(removeJs).catch(() => -1));
    if (idx >= 0) {
      await frame.locator(".se-text-paragraph").nth(idx).click({ timeout: 4000 });
      await page.keyboard.press("Home");
      await page.keyboard.press("Shift+End");
      await page.keyboard.press("Backspace"); // 선택한 URL 글자 삭제
      await page.keyboard.press("Backspace"); // 빈 줄도 정리
      await frame.waitForTimeout(400);
    }
    log.info(`링크 카드 삽입: ${url}`);
    return true;
  } catch (err) {
    log.warn(`링크 카드 삽입 실패(무시): ${url}`, err);
    return false;
  }
}

/** 특정 문구가 있는 줄을 찾아 색·굵기를 입힌다 (서명·인사말 재현용) */
async function applyEmphasis(
  frame: Frame,
  page: Page,
  targets: { text: string; color?: string; bold?: boolean; where?: "head" | "tail" }[],
): Promise<void> {
  const list = targets.filter((t) => t.text.trim() && (t.color || t.bold));
  if (list.length === 0) return;
  let ok = 0;
  for (const t of list) {
    const line = stripListMarker(t.text.split("\n")[0]!.trim()); // 첫 줄 기준으로 찾는다
    if (line.length < 3) continue;
    try {
      // ⚠️ 본문에 우연히 같은 문장이 있으면 엉뚱한 곳에 색이 칠해진다.
      //    인사말은 문서 앞쪽에서만, 서명은 뒤쪽에서만 찾는다.
      const scope = t.where ?? "tail";
      const idxJs = `(() => {
        const ps = Array.from(document.querySelectorAll(".se-text-paragraph"));
        const norm = (s) => (s || "").replace(/[\\s\\u200b]/g, "");
        const t = norm(${JSON.stringify(line)});
        const from = ${JSON.stringify(scope)} === "head" ? 0 : Math.max(0, ps.length - 14);
        const to = ${JSON.stringify(scope)} === "head" ? Math.min(ps.length, 6) : ps.length;
        for (let i = from; i < to; i++) if (norm(ps[i].innerText) === t) return i;
        return -1;
      })()`;
      const idx = Number(await frame.evaluate(idxJs).catch(() => -1));
      if (idx < 0) {
        log.warn(`강조 대상 줄을 찾지 못함: "${line.slice(0, 16)}"`);
        continue;
      }
      const para = frame.locator(".se-text-paragraph").nth(idx);
      if (!(await para.isVisible({ timeout: 3000 }).catch(() => false))) continue;
      // 인덱스가 어긋나 엉뚱한 문단에 색이 칠해지는 사고를 막는다 — 클릭 전에 내용 재확인
      const actual = (await para.innerText().catch(() => "")).replace(/[\s​]/g, "");
      if (actual !== line.replace(/[\s​]/g, "")) {
        log.warn(`강조 대상 불일치 — 건너뜀: 기대 "${line.slice(0, 14)}" / 실제 "${actual.slice(0, 14)}"`);
        continue;
      }
      await para.click({ timeout: 4000 });
      await frame.waitForTimeout(250);
      await page.keyboard.press("Home");
      await page.keyboard.press("Shift+End"); // 그 줄만 선택
      await frame.waitForTimeout(250);
      if (t.bold) {
        await frame.locator(SEL.boldButton).first().click({ timeout: 3000 });
        await frame.waitForTimeout(250);
      }
      if (t.color) await applyColor(frame, t.color);
      await page.keyboard.press("End"); // 선택 해제
      ok++;
    } catch (err) {
      log.warn(`강조 서식 실패: "${line.slice(0, 14)}"`, err);
    }
  }
  log.info(`강조 서식(색·굵기) 적용 ${ok}/${list.length}`);
}

/**
 * 인용구 스타일 → **이미 만든 인용구 블록의 모양을 바꾸는** 속성 툴바 버튼 (2026-08 실측).
 *
 * ⚠️ 상단 툴바의 "인용구 선택" 드롭다운(se-toolbar-option-insert-quotation-*)은
 *    기존 블록을 바꾸는 게 아니라 **그 스타일로 새 인용구를 하나 더 삽입**한다.
 *    (실측: 인용구 개수 1 → 2) 그래서 소제목마다 빈 인용구가 늘어났었다.
 *    커서를 인용구 안에 두면 뜨는 아래 토글 버튼이 올바른 경로다.
 */
const QUOTE_STYLE_TOGGLE: Record<QuoteStyle, string> = {
  default: ".se-quotation-group-toggle-toolbar-button.se-quotation-default-toolbar-button",
  line: '.se-quotation-group-toggle-toolbar-button[data-value="quotation_line"]',
  bubble: '.se-quotation-group-toggle-toolbar-button[data-value="quotation_bubble"]',
  underline: '.se-quotation-group-toggle-toolbar-button[data-value="quotation_underline"]',
  postit: '.se-quotation-group-toggle-toolbar-button[data-value="quotation_postit"]',
  corner: '.se-quotation-group-toggle-toolbar-button[data-value="quotation_corner"]',
};

/**
 * 소제목·인용구 서식을 **본문·이미지·서명을 모두 넣은 뒤 마지막에** 입힌다.
 *
 * ⚠️ 실측(2026-07): 타이핑 도중 서식을 바꾸면
 *   - 인용구는 커서가 블록 안에 갇혀(Enter를 눌러도 못 빠져나옴) 이후 본문이 인용구 안으로 들어가고,
 *   - 되돌리려고 '본문' 서식을 누르면 인용구 전체가 본문으로 되돌아간다.
 * 그래서 평범한 문단으로 전부 입력한 뒤, 해당 줄을 찾아 클릭해서 서식만 바꾼다(줄끼리 영향 없음).
 */
async function applyStructuredFormats(
  frame: Frame,
  page: Page,
  blocks: BodyBlock[],
  textStyle?: { headingBold?: boolean; headingItalic?: boolean; headingSize?: string },
): Promise<void> {
  const targets = blocks.filter((b) => b.kind !== "text" && b.text.trim());
  if (targets.length === 0) return;

  let ok = 0;
  let styled = 0;
  const wantStyled = targets.filter(
    (b) => b.kind === "quote" && b.quoteStyle && b.quoteStyle !== "default",
  ).length;
  for (const b of targets) {
    const text = stripListMarker(b.text.replace(/\n/g, " ").trim());
    try {
      // 마무리 인용구는 제목을 되풀이하므로 본문 CTA 문단과 글자가 겹친다.
      // 문서 맨 뒤에 있는 쪽을 잡아야 엉뚱한 줄을 건드리지 않는다.
      const matches = frame.locator(".se-text-paragraph", { hasText: text });
      const para = b.closing ? matches.last() : matches.first();
      if (!(await para.isVisible({ timeout: 4000 }).catch(() => false))) {
        log.warn(`서식 대상 줄을 찾지 못함: "${text.slice(0, 18)}"`);
        continue;
      }
      await para.click({ timeout: 5000 });
      await frame.waitForTimeout(400);
      await frame.locator(SEL.textFormatButton).first().click({ timeout: 5000 });
      await frame.waitForTimeout(350);
      await frame
        .locator(b.kind === "heading" ? SEL.formatSectionTitle : SEL.formatQuotation)
        .first()
        .click({ timeout: 5000 });
      await frame.waitForTimeout(500);

      // 인용구 스타일(버티컬라인 등) — 문단서식으로 변환하면 항상 '인용구 1'(따옴표)이 되므로
      // 변환된 블록 안에 커서를 두고, 그때 뜨는 속성 툴바에서 모양을 바꾼다.
      if (b.kind === "quote" && b.quoteStyle && b.quoteStyle !== "default") {
        const label = `${b.quoteStyle} · "${text.slice(0, 14)}"`;
        // ① 인용구 안에 커서 두기 — 떠 있는 속성 툴바에 가려 일반 클릭이 막히는 자리가 있어
        //    한 번 실패하면 화면에 끌어온 뒤 force로 다시 누른다.
        const quoted = frame.locator(".se-quotation .se-text-paragraph", { hasText: text });
        const target = b.closing ? quoted.last() : quoted.first();
        let placed = false;
        try {
          await target.scrollIntoViewIfNeeded({ timeout: 2500 });
          await target.click({ timeout: 2500 });
          placed = true;
        } catch {
          try {
            await target.click({ timeout: 2500, force: true });
            placed = true;
          } catch (err) {
            log.warn(`인용구 스타일 — 블록에 커서를 못 놓음: ${label}`, err);
          }
        }
        // ② 속성 툴바에서 모양 토글 (같은 클래스가 숨은 채로도 있어 보이는 것만 고른다)
        if (placed) {
          await frame.waitForTimeout(350);
          try {
            const btns = frame.locator(QUOTE_STYLE_TOGGLE[b.quoteStyle]);
            const n = await btns.count();
            let clicked = false;
            for (let i = 0; i < n; i++) {
              const one = btns.nth(i);
              if (await one.isVisible().catch(() => false)) {
                await one.click({ timeout: 2500 });
                clicked = true;
                break;
              }
            }
            if (clicked) {
              await frame.waitForTimeout(400);
              styled++;
            } else {
              log.warn(`인용구 스타일 — 속성 툴바에 버튼이 안 뜸(${n}개 중 보이는 것 없음): ${label}`);
            }
          } catch (err) {
            log.warn(`인용구 스타일 — 토글 클릭 실패: ${label}`, err);
          }
        }
      }

      // 학습한 글자 서식(굵게·기울임·크기)을 그 줄에 적용 — 줄 전체 선택 후 토글
      if (textStyle && (textStyle.headingBold || textStyle.headingItalic || textStyle.headingSize)) {
        try {
          await para.click({ timeout: 4000 }); // 변환 후 새 요소일 수 있으니 다시 클릭
          await frame.waitForTimeout(250);
          await page.keyboard.press("Home");
          await page.keyboard.press("Shift+End"); // 그 줄만 선택
          await frame.waitForTimeout(250);
          if (textStyle.headingSize) await applyFormat(frame, textStyle.headingSize);
          if (textStyle.headingBold) {
            await frame.locator(SEL.boldButton).first().click({ timeout: 3000 });
            await frame.waitForTimeout(250);
          }
          if (textStyle.headingItalic) {
            await frame.locator(SEL.italicButton).first().click({ timeout: 3000 });
            await frame.waitForTimeout(250);
          }
        } catch (err) {
          log.warn(`글자 서식(굵게/기울임) 적용 실패: "${text.slice(0, 14)}"`, err);
        }
      }
      ok++;
    } catch (err) {
      log.warn(`문단서식 적용 실패: "${text.slice(0, 18)}"`, err);
    }
  }
  const heads = targets.filter((t) => t.kind === "heading").length;
  log.info(
    `문단 서식 적용 ${ok}/${targets.length} (소제목 ${heads} · 인용구 ${targets.length - heads})` +
      (wantStyled > 0 ? ` · 인용구 스타일 ${styled}/${wantStyled}` : ""),
  );
}

/**
 * 발행 패널에서 카테고리를 고른다.
 *
 * 카테고리를 지정하지 않으면 블로그 기본값('대문')으로 들어가 주제 분류가 안 되고
 * 검색 노출에도 불리하다.
 *
 * 각 항목의 label[for]가 "{카테고리번호}_{이름}" 형태라 이름으로 정확히 집을 수 있다.
 * 하위 카테고리는 화면 텍스트 앞에 "하위 카테고리"라는 스크린리더용 문구가 붙어서
 * 텍스트 매칭은 어긋난다 — 그래서 for 속성을 우선 쓴다.
 * 실패해도 발행 자체는 막지 않는다(경고만 남긴다).
 */
async function selectCategory(frame: Frame, name?: string): Promise<void> {
  const wanted = name?.trim();
  if (!wanted) return;
  try {
    let opened = false;
    for (const sel of SEL.categoryOpen) {
      const btn = frame.locator(sel).first();
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await btn.click();
        opened = true;
        break;
      }
    }
    if (!opened) {
      log.warn(`카테고리 "${wanted}" — 선택 버튼을 찾지 못해 기본 카테고리로 발행합니다.`);
      return;
    }
    await frame.waitForTimeout(800);

    const menu = frame.locator(SEL.categoryMenu).first();
    // 1순위: for="번호_이름" 정확 매칭 (같은 이름이 여러 개면 첫 번째)
    const byFor = menu.locator(`label[for$="_${cssEscape(wanted)}"]`).first();
    if (await byFor.isVisible({ timeout: 1500 }).catch(() => false)) {
      await byFor.click();
      await frame.waitForTimeout(500);
      log.info(`카테고리 지정: ${wanted}`);
      return;
    }
    // 2순위: 보이는 글자로 매칭 ("하위 카테고리" 안내문은 무시)
    const byText = menu.locator("label").filter({ hasText: wanted }).first();
    if (await byText.isVisible({ timeout: 1500 }).catch(() => false)) {
      await byText.click();
      await frame.waitForTimeout(500);
      log.info(`카테고리 지정: ${wanted} (이름 매칭)`);
      return;
    }

    const available = await menu
      .locator("label")
      .allInnerTexts()
      .catch(() => [] as string[]);
    log.warn(
      `카테고리 "${wanted}"를 목록에서 찾지 못했습니다 — 기본 카테고리로 발행합니다. 블로그에 있는 이름: ${available
        .map((t) => t.replace("하위 카테고리", "").trim())
        .filter(Boolean)
        .slice(0, 15)
        .join(" · ")}`,
    );
  } catch (err) {
    log.warn(`카테고리 "${wanted}" 지정 실패(무시)`, err);
  }
}

/** 속성 셀렉터 값에 들어갈 따옴표·역슬래시 이스케이프 */
function cssEscape(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}

/**
 * 이미지 삽입 — 사진 버튼 클릭 시 뜨는 파일선택창에 파일 주입.
 * 본문 사진은 1장씩 단독으로 넣는다(모바일에서 크게 보이도록).
 * 2장 이상을 한 번에 넘기면 SmartEditor가 콜라주로 배치하는 경로도 남겨 둔다.
 */
async function insertImageGroup(
  page: Page,
  frame: Frame,
  paths: string[],
  opts: { center?: boolean } = {},
): Promise<void> {
  if (paths.length === 0) return;
  try {
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 12000 }),
      frame.locator(SEL.imageButton).first().click(),
    ]);
    await chooser.setFiles(paths);
    await frame.waitForTimeout(1500);
    // 2장 이상이면 "사진 첨부 방식" 팝업 → 콜라주(그리드) 선택
    if (paths.length >= 2) {
      try {
        const collage = frame.locator(SEL.imageCollage).first();
        if (await collage.isVisible({ timeout: 4000 })) {
          await collage.click();
        }
      } catch (err) {
        log.warn("콜라주 선택 실패(무시)", err);
      }
    }
    await frame.waitForTimeout(4000 + paths.length * 700); // 업로드 대기

    // 단일 이미지 가운데 정렬 (썸네일·서명 등)
    if (opts.center && paths.length === 1) {
      try {
        await frame
          .locator("img.se-image-resource, .se-module-image img")
          .last()
          .click();
        await frame.waitForTimeout(500);
        await frame.locator(SEL.imageAlignCenter).first().click({ timeout: 3000 });
        await frame.waitForTimeout(400);
      } catch (err) {
        log.warn("이미지 가운데 정렬 실패(무시)", err);
      }
      // ⚠️ 정렬하려고 이미지를 클릭하면 '이미지 선택' 상태가 남아 글자 툴바가 사라진다.
      //    그대로 두면 뒤따르는 글자크기·정렬 설정이 전부 3초씩 타임아웃된다.
      //    실측(2026-08): Escape는 안 먹고 ArrowDown이 선택을 풀어 글자 툴바를 되살린다.
      try {
        await page.keyboard.press("ArrowDown");
        await frame.waitForTimeout(300);
      } catch {
        /* 무시 */
      }
    }
    log.debug(`이미지 그룹 삽입: ${paths.length}장`);
  } catch (err) {
    log.warn("이미지 그룹 삽입 실패(무시)", err);
  }
}

/**
 * 생성된 글을 SmartEditor에 채워 발행(또는 임시저장)한다.
 * 흐름: 글쓰기 진입 → 복구 팝업 취소 → 제목 → 본문(문단 사이 이미지) →
 *       (dryRun이면 임시저장) 발행 패널 → 공개설정·태그 → 확정 발행 → URL.
 */
export async function publishPost(
  context: BrowserContext,
  input: PublishInput,
): Promise<PublishResult> {
  const page = await context.newPage();
  try {
    log.info(`글쓰기 진입: ${input.blogId}`);
    let frame: Frame | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      await page.goto(`https://blog.naver.com/${input.blogId}?Redirect=Write&`, {
        waitUntil: "domcontentloaded",
      });
      await humanDelay(3, 5);
      try {
        frame = await getFrame(page);
        break;
      } catch (err) {
        log.warn(`에디터 iframe 로드 실패 — 재시도 ${attempt}/2`, err);
        await page.waitForTimeout(3000);
      }
    }
    if (!frame) {
      if (/nidlogin|nid\.naver\.com/.test(page.url())) {
        const msg = "네이버 세션이 만료되었습니다. 상세 설정 → 계정에서 이 계정으로 다시 로그인해 주세요.";
        log.error(`발행 중단 — ${msg} (${input.blogId})`);
        return { ok: false, mode: "failed", error: msg, sessionExpired: true };
      }
      const msg = "에디터를 열지 못했습니다(글쓰기 화면 로딩 실패). 잠시 후 다시 시도해 주세요.";
      log.error(`발행 중단 — ${msg} (${input.blogId})`);
      return { ok: false, mode: "failed", error: msg };
    }
    await frame.waitForTimeout(1500);

    // 0) 복구 팝업 취소 (새 글로 시작)
    try {
      const cancel = frame.locator(SEL.recoveryCancel).first();
      if (await cancel.isVisible({ timeout: 3000 })) {
        await cancel.click();
        await humanDelay(0.8, 1.4);
        log.info("복구 팝업 → 취소");
      }
    } catch {
      /* 팝업 없음 */
    }

    // 1) 제목
    await frame.locator(SEL.title).first().click();
    await page.keyboard.type(input.post.title, { delay: 20 });
    await humanDelay(0.5, 1);

    // 2) 본문 진입
    await frame.locator(SEL.body).first().click();
    await humanDelay(0.3, 0.6);

    // 2-1) 썸네일: 맨 위에 단독 삽입 (콜라주 없이, 가운데 정렬)
    if (input.thumbnail) {
      await insertImageGroup(page, frame, [input.thumbnail.path], { center: true });
      await page.keyboard.press("Enter"); // 이미지 아래 줄로 이동
      await humanDelay(0.2, 0.4);
      log.info("썸네일 상단 삽입");
    }

    // 2-2) 서식 — 학습한 서체 + 글자크기(기본 19pt) + 가운데 정렬
    await applyFontFamily(frame, input.textStyle?.bodyFont);
    await applyFormat(frame, input.textStyle?.bodySize ?? "fs19");

    // 3) 본문 입력 — 구조화 블록(문단/소제목/인용구) 우선, 없으면 content 문단 분할
    const bodyBlocks: BodyBlock[] =
      input.structuredBody && input.structuredBody.length > 0
        ? input.structuredBody
        : (input.post.content || input.post.rawContent)
            .split(/\n{2,}/)
            .map((b) => b.trim())
            .filter(Boolean)
            .map((text) => ({ kind: "text" as const, text }));

    // 사진은 2장씩 묶어 콜라주(그리드)로 넣는다 — 학습 블로그와 같은 배치.
    // 낱장으로 흩으면 글이 늘어지고 사진끼리 짝이 안 맞는다.
    const groups: string[][] = [];
    for (let i = 0; i < input.images.length; i += 2) {
      groups.push(input.images.slice(i, i + 2).map((a) => a.path));
    }
    // 학습 블로그 구조: [소제목 → 사진 → 본문]. 소제목 뒤에 먼저 한 장씩 넣고,
    // 소제목보다 사진이 많으면 남는 사진을 본문 문단 사이에 고르게 흩는다.
    // (예전엔 남는 사진을 전부 글 끝에 몰아넣어 마지막에 사진 뭉치가 생겼다)
    const slots: number[] = []; // 이 인덱스의 블록 뒤에 사진을 넣는다
    const headingIdx = bodyBlocks
      .map((b, i) => (b.kind !== "text" && !b.closing ? i : -1))
      .filter((i) => i >= 0);
    for (const i of headingIdx) {
      if (slots.length >= groups.length) break;
      slots.push(i);
    }
    if (slots.length < groups.length) {
      // 마무리 인용구 앞까지의 본문 문단 중 아직 안 쓴 자리에 균등 배치
      const lastBody = bodyBlocks.findIndex((b) => b.closing);
      const limit = lastBody >= 0 ? lastBody : bodyBlocks.length;
      const free = bodyBlocks
        .map((b, i) => (b.kind === "text" && i < limit - 1 && !slots.includes(i) ? i : -1))
        .filter((i) => i >= 0);
      const need = groups.length - slots.length;
      const step = free.length > need ? free.length / need : 1;
      for (let k = 0; k < need && free.length > 0; k++) {
        const pick = free[Math.min(free.length - 1, Math.floor(k * step))];
        if (pick !== undefined && !slots.includes(pick)) slots.push(pick);
      }
    }
    const slotSet = new Set(slots);
    const afterHeading = slots.length > 0;
    let gi = 0;

    /** 이 문단 다음에 '자주 묻는 질문'이 시작되는가 — 사양표를 그 앞에 끼운다 */
    const faqStart = bodyBlocks.findIndex(
      (b) => b.kind !== "text" && /질문|궁금|문의|FAQ/i.test(b.text),
    );
    let specDone = !input.specImage;

    for (let bi = 0; bi < bodyBlocks.length; bi++) {
      if (shouldStop()) return STOPPED;
      const blk = bodyBlocks[bi]!;

      // 제품사양 표 — '자주 묻는 질문' 소제목 바로 앞에 단독으로
      if (!specDone && input.specImage && bi === faqStart) {
        await insertImageGroup(page, frame, [input.specImage.path], { center: true });
        await page.keyboard.press("Enter");
        await applyFormat(frame, input.textStyle?.bodySize ?? "fs19");
        specDone = true;
        log.info("제품사양 표 삽입 (자주 묻는 질문 앞)");
      }

      // 소제목·인용구도 일단 평범한 문단으로 입력한다 (서식은 맨 마지막에 일괄 적용)
      const lines = blk.text.split("\n");
      for (let li = 0; li < lines.length; li++) {
        // ⚠️ "1. " "- " 로 시작하면 에디터가 자동으로 '목록' 서식으로 바꿔버린다
        //    (왼쪽에 번호 마커가 붙고 다크모드에서 회색으로 보임) → 표기를 떼고 평문으로 넣는다
        await page.keyboard.type(stripListMarker(lines[li]!), { delay: 6 });
        if (li < lines.length - 1) await page.keyboard.press("Shift+Enter"); // 문단 내 줄바꿈
      }
      // 미리 정한 자리에서만 사진을 넣는다 (원본 구조 재현)
      const putImages = afterHeading && slotSet.has(bi) && gi < groups.length;

      await page.keyboard.press("Enter");
      // 사진이 바로 뒤에 올 땐 빈 줄을 넣지 않는다 (소제목 → 사진 사이 공백 제거)
      if (!putImages) await page.keyboard.press("Enter"); // 문단 구분
      await humanDelay(0.15, 0.35);

      if (putImages) {
        await insertImageGroup(page, frame, groups[gi++]!);
        await applyFormat(frame, input.textStyle?.bodySize ?? "fs19"); // 이미지 삽입 후 서식 회복
      }
    }
    while (gi < groups.length) {
      await insertImageGroup(page, frame, groups[gi++]!);
    }
    // 자주 묻는 질문 소제목을 못 찾았으면 본문 끝에라도 사양표를 넣는다
    if (!specDone && input.specImage) {
      await insertImageGroup(page, frame, [input.specImage.path], { center: true });
      await applyFormat(frame, input.textStyle?.bodySize ?? "fs19");
      log.info("제품사양 표 삽입 (본문 끝)");
    }

    // 4) 서명 (학습 블로그의 반복되는 마지막 블록) — 순서대로 그대로 복사
    if (input.signature && input.signature.length > 0) {
      for (const b of input.signature) {
        if (b.type === "oglink") {
          await insertOgLink(page, frame, b.url);
        } else if (b.type === "text") {
          await applyFormat(frame, input.textStyle?.bodySize ?? "fs19");
          if (b.runs && b.runs.length > 0) {
            // 원문의 색·서체·크기·굵기를 조각 단위로 그대로 재현
            await typeStyledRuns(page, frame, b.runs, {
              font: input.textStyle?.bodyFont,
              size: input.textStyle?.bodySize ?? "fs19",
              color: input.textStyle?.bodyColor,
            });
          } else {
            await page.keyboard.type(b.text, { delay: 6 });
          }
          await page.keyboard.press("Enter");
          await page.keyboard.press("Enter");
          await humanDelay(0.15, 0.3);
        } else {
          await insertImageGroup(page, frame, [b.image.path], { center: true }); // 서명 이미지 단독·가운데
        }
      }
      log.info(`서명 ${input.signature.length}블록 삽입`);
    }

    // 5) 소제목·인용구 서식 — 모든 입력이 끝난 뒤 마지막에 (커서 갇힘 문제 회피)
    await applyStructuredFormats(frame, page, bodyBlocks, input.textStyle);

    // 6) 원문의 색·굵기 재현
    //    서명은 위에서 조각(run) 단위로 이미 그대로 찍었다.
    //    여기서는 우리가 새로 쓴 본문에만 손댄다:
    //      - 인사말 줄 전체 색·굵기
    //      - 본문 곳곳의 상호명처럼 '문구 단위'로 색이 다른 부분
    const emphasis: { text: string; color?: string; bold?: boolean; where?: "head" | "tail" }[] = [];
    if (input.introStyle && bodyBlocks[0]?.kind === "text") {
      // 인사말은 모바일 줄바꿈으로 여러 줄이 된다 — 줄마다 따로 칠해야 첫 줄만 색이 드는 일이 없다
      for (const line of bodyBlocks[0].text.split("\n")) {
        if (line.trim().length < 3) continue;
        emphasis.push({
          text: line,
          color: input.introStyle.color,
          bold: input.introStyle.bold,
          where: "head",
        });
      }
    }
    await applyEmphasis(frame, page, emphasis);
    await applyInlineColors(frame, page, input.inlineColors ?? []);

    // 3) dryRun → 임시저장까지만
    if (input.dryRun) {
      log.info("dryRun — 임시저장");
      await frame.locator(SEL.saveDraft).first().click();
      await humanDelay(1.5, 2.5);
      return { ok: true, mode: "draft" };
    }

    // 이미지 업로드가 끝나야 발행 버튼이 활성화된다 — 완료 대기
    await waitForUploadsSettle(page, frame);

    // 중지 요청 시 발행 확정 전에 안전하게 중단 (아무것도 안 올라감)
    if (shouldStop()) return STOPPED;

    // 4) 발행 패널
    log.info("발행 패널 열기");
    await robustClick(frame.locator(SEL.publishOpen).first(), "발행 패널 열기");
    await humanDelay(1.5, 2.5);

    // 4-0) 카테고리 (지정했을 때만 — 실패해도 발행은 계속한다)
    await selectCategory(frame, input.category);

    // 4-1) 공개 범위 — label을 클릭(라디오 input은 label에 가려 클릭 불가)하고,
    //      input의 checked로 실제 반영을 검증. 실패 시 발행 중단(공개 사고 방지).
    const visKey = input.visibility ?? "all";
    const inputSel = SEL.visibility[visKey];
    const inputId = inputSel.replace("#", "");
    try {
      await frame.locator(`label[for="${inputId}"]`).first().click({ timeout: 4000 });
      await humanDelay(0.3, 0.6);
      const checked = await frame.locator(inputSel).first().isChecked();
      if (!checked) throw new Error("라디오 선택 미반영");
      log.info(`공개범위 설정: ${visKey}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`공개범위(${visKey}) 설정 실패 — 발행 중단`, err);
      return { ok: false, mode: "failed", error: `공개범위 설정 실패로 발행을 중단했습니다: ${msg}` };
    }

    // 4-2) 태그
    if (input.tags?.length) {
      try {
        const tag = frame.locator(SEL.tagInput).first();
        await tag.click();
        for (const t of input.tags) {
          await tag.type(t.replace(/^#/, ""), { delay: 35 });
          await page.keyboard.press("Enter");
          await humanDelay(0.2, 0.4);
        }
      } catch (err) {
        log.warn("태그 입력 실패(무시)", err);
      }
    }

    // 4-3) 확정 발행
    await robustClick(frame.locator(SEL.confirmPublish).first(), "확정 발행");
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await humanDelay(2.5, 4);

    // page.url()이 편집기 리다이렉트(?Redirect=Write 등)를 잡으면 글 주소가 아니므로 블로그 홈으로 정리
    let url = page.url();
    if (!/\/\d{6,}(?:[?#]|$)/.test(url)) url = `https://blog.naver.com/${input.blogId}`;
    log.info(`발행 완료: ${url}`);
    return { ok: true, url, mode: "published" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("발행 실패", err);
    return { ok: false, mode: "failed", error: msg };
  } finally {
    if (input.debugScreenshot) {
      try {
        await page.screenshot({ path: input.debugScreenshot });
      } catch {
        /* 무시 */
      }
    }
    await page.close().catch(() => {});
  }
}
