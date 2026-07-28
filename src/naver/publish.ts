import type { BrowserContext, Frame, Locator, Page } from "playwright";
import type { ImageAsset, PreparedSignature, QuoteStyle } from "../core/types";
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
  quotationStyleOpen: ".se-toolbar-item-insert-quotation .se-document-toolbar-select-option-button",
  publishOpen: '[class*="publish_btn__"]', // 상단 발행(패널 열기)
  saveDraft: '[class*="save_btn__"]', // 저장(임시저장) — 저장목록(save_count_btn)과 구분
  tagInput: "#tag-input",
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
    headingBold?: boolean;
    headingItalic?: boolean;
    headingSize?: string;
  };
  images: ImageAsset[]; // 본문 콜라주용 (2장씩 그리드)
  thumbnail?: ImageAsset; // 맨 위 단독·가운데
  signature?: PreparedSignature; // 맨 아래 서명 (글·이미지 순서대로)
  tags?: string[];
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

/** 현재 커서 위치에 글자크기(학습값·기본 19pt) + 가운데 정렬 적용 */
async function applyFormat(frame: Frame, sizeCode = "fs19"): Promise<void> {
  try {
    await frame.locator(SEL.fontSizeButton).first().click();
    await frame.waitForTimeout(350);
    await frame
      .locator(`.se-toolbar-option-font-size-code-${sizeCode}-button`)
      .first()
      .click({ timeout: 3000 });
    await frame.waitForTimeout(250);
  } catch (err) {
    log.warn(`글자크기(${sizeCode}) 설정 실패(무시)`, err);
  }
  try {
    await frame.locator(SEL.alignButton).first().click();
    await frame.waitForTimeout(350);
    await frame.locator(SEL.alignCenter).first().click({ timeout: 3000 });
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

/** 인용구 스타일 → 툴바 옵션 버튼 (2026-07 실측) */
const QUOTE_STYLE_BUTTON: Record<QuoteStyle, string> = {
  default: ".se-toolbar-option-insert-quotation-default-button",
  line: ".se-toolbar-option-insert-quotation-quotation_line-button",
  bubble: ".se-toolbar-option-insert-quotation-quotation_bubble-button",
  underline: ".se-toolbar-option-insert-quotation-quotation_underline-button",
  postit: ".se-toolbar-option-insert-quotation-quotation_postit-button",
  corner: ".se-toolbar-option-insert-quotation-quotation_corner-button",
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
  for (const b of targets) {
    const text = stripListMarker(b.text.replace(/\n/g, " ").trim());
    try {
      const para = frame.locator(".se-text-paragraph", { hasText: text }).first();
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

      // 인용구 스타일(버티컬라인 등)은 변환 뒤 best-effort로 맞춘다
      if (b.kind === "quote" && b.quoteStyle && b.quoteStyle !== "default") {
        try {
          await frame.locator(SEL.quotationStyleOpen).first().click({ timeout: 3500 });
          await frame.waitForTimeout(350);
          await frame.locator(QUOTE_STYLE_BUTTON[b.quoteStyle]).first().click({ timeout: 3500 });
          await frame.waitForTimeout(400);
        } catch {
          /* 스타일은 못 맞춰도 인용구 자체는 적용됨 */
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
  log.info(`문단 서식 적용 ${ok}/${targets.length} (소제목 ${heads} · 인용구 ${targets.length - heads})`);
}

/**
 * 이미지 그룹 삽입 — 사진 버튼 클릭 시 뜨는 파일선택창에 여러 파일 주입.
 * 2장을 한 번에 넣으면 SmartEditor가 나란히 그리드로 배치한다.
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

    // 이미지를 2장씩 묶어 그리드 그룹으로
    const groups: string[][] = [];
    for (let i = 0; i < input.images.length; i += 2) {
      groups.push(input.images.slice(i, i + 2).map((a) => a.path));
    }
    // 학습 블로그 구조: [소제목 → 사진 2장 → 본문]. 소제목이 있으면 그 바로 뒤에 사진을 넣는다.
    const headingCount = bodyBlocks.filter((b) => b.kind !== "text").length;
    const afterHeading = headingCount > 0 && groups.length > 0;
    const every = !afterHeading && groups.length
      ? Math.max(1, Math.floor(bodyBlocks.length / (groups.length + 1)))
      : 0;
    let gi = 0;

    for (let bi = 0; bi < bodyBlocks.length; bi++) {
      if (shouldStop()) return STOPPED;
      const blk = bodyBlocks[bi]!;

      // 소제목·인용구도 일단 평범한 문단으로 입력한다 (서식은 맨 마지막에 일괄 적용)
      const lines = blk.text.split("\n");
      for (let li = 0; li < lines.length; li++) {
        // ⚠️ "1. " "- " 로 시작하면 에디터가 자동으로 '목록' 서식으로 바꿔버린다
        //    (왼쪽에 번호 마커가 붙고 다크모드에서 회색으로 보임) → 표기를 떼고 평문으로 넣는다
        await page.keyboard.type(stripListMarker(lines[li]!), { delay: 6 });
        if (li < lines.length - 1) await page.keyboard.press("Shift+Enter"); // 문단 내 줄바꿈
      }
      // 소제목 바로 다음에 사진 2장 (원본 구조 재현)
      const putImages = afterHeading
        ? blk.kind !== "text" && gi < groups.length
        : Boolean(every) && gi < groups.length && (bi + 1) % every === 0;

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

    // 4) 서명 (학습 블로그의 반복되는 마지막 블록) — 순서대로 그대로 복사
    if (input.signature && input.signature.length > 0) {
      for (const b of input.signature) {
        if (b.type === "oglink") {
          await insertOgLink(page, frame, b.url);
        } else if (b.type === "text") {
          await applyFormat(frame, input.textStyle?.bodySize ?? "fs19");
          await page.keyboard.type(b.text, { delay: 6 });
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

    // 6) 원문의 색·굵기 재현 (서명 블록 + 인사말)
    const emphasis: { text: string; color?: string; bold?: boolean; where?: "head" | "tail" }[] = [];
    // ⚠️ 서명 줄 색·굵기는 잠시 비활성.
    //    본문 문단에 색이 잘못 칠해지는 현상(다크모드에서 회색 글씨로 보임)이 재현돼,
    //    원인 규명 전까지는 잘못 칠하느니 안 칠하는 쪽을 택한다. (SENBI_SIG_EMPHASIS=1 로 실험 가능)
    if (process.env.SENBI_SIG_EMPHASIS) {
      for (const b of input.signature ?? []) {
        if (b.type === "text" && b.style && (b.style.color || b.style.bold)) {
          emphasis.push({ text: b.text, color: b.style.color, bold: b.style.bold, where: "tail" });
        }
      }
    }
    if (input.introStyle && bodyBlocks[0]?.kind === "text") {
      emphasis.push({
        text: bodyBlocks[0].text,
        color: input.introStyle.color,
        bold: input.introStyle.bold,
        where: "head",
      });
    }
    await applyEmphasis(frame, page, emphasis);

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
