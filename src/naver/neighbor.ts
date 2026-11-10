import type { BrowserContext, Page } from "playwright";
import type { Settings } from "../config/settings";
import { humanDelay } from "./session";
import { MOBILE_UA } from "../crawl/post";
import { fetchPostContent } from "../crawl/post";
import { generateComment, generateBuddyMessage } from "../generate/social";
import {
  logActivity,
  todayCount,
  actedRecently,
} from "../core/activity";
import { shouldStop } from "../core/cancel";
import { createLogger } from "../core/logger";

const log = createLogger("neighbor");

/**
 * ⚠️ 튜닝 필요: 모바일 네이버 블로그(m.blog.naver.com)의 공감/댓글/서로이웃 DOM.
 * 셀렉터를 한 곳에 모아 실계정에서 조정한다.
 */
// 모바일(m.blog.naver.com) 실제 DOM 기준 (2026-07 검증)
const SEL = {
  likeButton: "a.u_likeit_button", // 공감 (미클릭 .off / 클릭됨 .on)
  likeOn: "a.u_likeit_button.on",
  commentOpen: "[class*=comment_btn]", // 댓글 버튼(창 열기)
  commentText: ".u_cbox_text", // 댓글 입력(contenteditable div)
  commentSubmit: ".u_cbox_btn_upload", // 등록 (스티커 버튼과 다른 토큰)
  buddyBothLabel: 'label[for="bothBuddyRadio"]', // 서로이웃 신청
  buddyBothRadio: "#bothBuddyRadio",
  buddyMessage: ".textarea_t1",
  buddyConfirm: '.btn_ok, button:has-text("확인")',
} as const;

/** 이웃새글 피드에서 (blogId, logNo) 목록을 수집 — 소통 대상 */
export interface FeedItem {
  blogId: string;
  logNo: string;
  title?: string;
}

/**
 * 이웃새글 피드를 읽어 최근 글 목록을 가져온다.
 * ⚠️ 튜닝 필요: 실제 피드 URL·DOM에 맞춰 셀렉터 조정.
 */
export async function fetchNeighborFeed(
  context: BrowserContext,
  limit = 30,
): Promise<FeedItem[]> {
  const page = await context.newPage();
  try {
    await page.goto("https://m.blog.naver.com/FeedList.naver", {
      waitUntil: "domcontentloaded",
    });
    await humanDelay(1.5, 3);
    // 피드 항목에서 blogId/logNo 추출 (링크 href 파싱)
    const items = await page.$$eval("a[href*='blog.naver.com']", (anchors) =>
      anchors
        .map((a) => (a as { href: string }).href)
        .map((href) => {
          const m = href.match(/blog\.naver\.com\/([A-Za-z0-9_-]+)\/(\d+)/);
          return m ? { blogId: m[1], logNo: m[2] } : null;
        })
        .filter(Boolean),
    );
    const seen = new Set<string>();
    const feed: FeedItem[] = [];
    for (const it of items as { blogId: string; logNo: string }[]) {
      const key = `${it.blogId}/${it.logNo}`;
      if (seen.has(key)) continue;
      seen.add(key);
      feed.push(it);
      if (feed.length >= limit) break;
    }
    log.info(`이웃 피드 ${feed.length}건 수집`);
    return feed;
  } catch (err) {
    log.error("이웃 피드 수집 실패", err);
    return [];
  } finally {
    await page.close().catch(() => {});
  }
}

/** 한 글에 공감 + (선택) 댓글 */
async function engagePost(
  page: Page,
  item: FeedItem,
  comment: string | null,
  allowLike = true,
): Promise<{ liked: boolean; commented: boolean }> {
  const url = `https://m.blog.naver.com/${item.blogId}/${item.logNo}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await humanDelay(2, 5); // 글을 읽는 척

  let liked = false;
  let commented = false;

  // 공감은 댓글보다 먼저 (댓글 패널이 열리면 공감 버튼이 가려져 클릭이 막힌다)
  const doLike = async () => {
    if (!allowLike) return; // 일일 공감 한도 도달
    try {
      const likeBtn = page.locator(SEL.likeButton).first();
      if (await likeBtn.isVisible({ timeout: 4000 })) {
        const already = (await page.locator(SEL.likeOn).count()) > 0;
        if (!already) {
          await likeBtn.click({ timeout: 8000 });
          await humanDelay(1, 2.5);
          // 클릭만으로 성공 처리하면 비로그인 상태에서도 카운트가 올라간다 → 실제 반영 확인
          liked = (await page.locator(SEL.likeOn).count()) > 0;
          if (!liked) log.info(`공감 미반영(로그인 상태 확인 필요) ${url}`);
        }
      }
    } catch (err) {
      log.warn(`공감 실패 ${url}`, err);
    }
  };

  await doLike(); // 공감 먼저 (패널이 열리기 전)

  // 댓글
  if (comment) {
    try {
      // 댓글 영역 열기 (버튼이 있으면)
      const openBtn = page.locator(SEL.commentOpen).first();
      if (await openBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await openBtn.click().catch(() => {});
        await humanDelay(1, 2);
      }
      // ⚠️ 댓글 위젯(u_cbox)은 비동기 초기화 중 입력칸을 비운다 — 너무 일찍 치면 글이 지워짐.
      //    등록 버튼이 뜰 때까지 기다리고 추가로 안정화 시간을 준다. (실측: 1~2초는 부족)
      await page
        .locator(`${SEL.commentSubmit}:visible`)
        .first()
        .waitFor({ state: "visible", timeout: 8000 })
        .catch(() => {});
      await humanDelay(1.2, 2);
      // 보이는 입력창만 대상 (숨은 템플릿 .u_cbox_text 제외)
      const box = page.locator(`${SEL.commentText}:visible`).first();
      if (!(await box.isVisible({ timeout: 3000 }).catch(() => false))) {
        log.info(`댓글창 없음/비허용 — 스킵 ${url}`);
      } else {
        await box.scrollIntoViewIfNeeded().catch(() => {});
        // ⚠️ locator.click()은 플레이스홀더 오버레이에 가려 30초 타임아웃 → JS로 직접 포커스
        // (DOM 타입 충돌 회피를 위해 문자열로 전달)
        const focusJs = `(() => {
          const els = Array.from(document.querySelectorAll(${JSON.stringify(SEL.commentText)}));
          const el = els.find((e) => e.getBoundingClientRect().width > 0) || els[0];
          if (!el) return false;
          if (el.innerText.length) el.innerHTML = ""; // 불필요한 DOM 변경은 피한다(위젯 리셋 유발)
          el.focus();
          return document.activeElement === el;
        })()`;
        const readJs = `(() => {
          const els = Array.from(document.querySelectorAll(${JSON.stringify(SEL.commentText)}));
          const el = els.find((e) => e.getBoundingClientRect().width > 0) || els[0];
          return el ? el.innerText : "";
        })()`;
        const injectJs = `(() => {
          const els = Array.from(document.querySelectorAll(${JSON.stringify(SEL.commentText)}));
          const el = els.find((e) => e.getBoundingClientRect().width > 0) || els[0];
          if (!el) return false;
          const t = ${JSON.stringify(comment)};
          el.focus();
          el.textContent = t;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: t, inputType: "insertText" }));
          el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
          return el.innerText.length > 0;
        })()`;
        const readBox = async () =>
          String((await page.evaluate(readJs).catch(() => "")) ?? "").trim();
        const dbg = process.env.SENBI_COMMENT_DEBUG
          ? async (label: string) => {
              const env = await page
                .evaluate(`document.visibilityState + "/" + document.hasFocus() + "/pages:" + "?"`)
                .catch(() => "?");
              log.info(`  [디버그:${label}] "${(await readBox()).slice(0, 25)}" | ${env}`);
            }
          : async () => {};

        // ⚠️ 핵심: 댓글 위젯이 비동기 초기화를 끝내며 입력칸을 비운다(실측: 입력 직후엔 있다가 400ms 뒤 사라짐).
        //    그래서 "입력 → 잠시 대기 → 남아있는지 검증 → 지워졌으면 재시도" 루프로 확실히 채운다.
        let entered = false;
        for (let attempt = 1; attempt <= 3 && !entered; attempt++) {
          // ① 실제 사용자처럼 플레이스홀더(u_cbox_guide)를 눌러 위젯을 '편집 모드'로 전환.
          //    이 과정을 건너뛰고 값만 넣으면 위젯이 placeholder 상태로 되돌리며 입력을 지운다.
          await page
            .locator(".u_cbox_guide:visible, .u_cbox_write_area:visible")
            .first()
            .click({ force: true, timeout: 5000 })
            .catch(() => {});
          await page.waitForTimeout(400);
          // ② 그래도 포커스가 안 잡히면 JS로 보강
          const focused = (await page.evaluate(focusJs).catch(() => false)) as boolean;
          if (!focused) {
            await humanDelay(0.8, 1.2);
            continue;
          }
          if (attempt === 1) {
            await page.bringToFront().catch(() => {});
            await page.keyboard.type(comment, { delay: 35 }); // 사람처럼 실제 키 입력
          } else {
            await page.evaluate(injectJs).catch(() => {}); // 재시도는 빠르게 주입
          }
          await page.waitForTimeout(900); // 위젯이 지우는지 지켜본다
          entered = (await readBox()).length > 0;
          await dbg(`시도${attempt}`);
          if (!entered) await humanDelay(0.8, 1.4); // 초기화가 끝나길 기다렸다 재시도
        }

          if (!entered) {
            // 실패 원인 규명용 상태 덤프 (활성 요소·박스 개수·실제 텍스트)
            const diagJs = `(() => {
              const els = Array.from(document.querySelectorAll(${JSON.stringify(SEL.commentText)}));
              const vis = els.filter((e) => e.getBoundingClientRect().width > 0);
              const ae = document.activeElement;
              return JSON.stringify({
                total: els.length,
                visible: vis.length,
                active: ae ? ae.tagName + "." + String(ae.className || "").slice(0, 30) : "none",
                text: vis[0] ? vis[0].innerText.slice(0, 40) : "(none)",
              });
            })()`;
            const diag = await page.evaluate(diagJs).catch(() => "(진단 실패)");
            log.info(`댓글 입력 안 됨 — 스킵 ${url} | 상태 ${diag} | 보낸글자수 ${comment.length}`);
          } else if (process.env.SENBI_COMMENT_DRYRUN) {
            log.info(`[드라이런] 댓글 입력 성공(등록 생략) ${url} — "${comment.slice(0, 30)}"`);
          } else if ((await readBox()).length === 0) {
            log.info(`등록 직전 입력칸이 비워짐 — 스킵 ${url}`); // 빈 댓글 등록 방지
          } else {
            await page
              .locator(`${SEL.commentSubmit}:visible`)
              .first()
              .click({ force: true, timeout: 8000 });
            commented = true;
            await humanDelay(1, 2.5);
          }
      }
    } catch (err) {
      log.warn(`댓글 처리 오류 ${url}`, err);
    }
  }

  return { liked, commented };
}

/** 단일 글에 공감+댓글 (수동 실행·테스트용) */
export async function engageOne(
  context: BrowserContext,
  blogId: string,
  logNo: string,
  comment: string | null,
): Promise<{ liked: boolean; commented: boolean }> {
  const page = await context.newPage();
  try {
    return await engagePost(page, { blogId, logNo }, comment);
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * 이웃 소통 라운드: 피드의 이웃 글을 돌며 공감 + 맥락형 댓글.
 * 일일 한도·랜덤 지연·중복 방지를 지킨다.
 */
export async function runNeighborRound(
  context: BrowserContext,
  settings: Settings,
  apiKey: string,
  /** 한도·중복 방지를 이 계정 기준으로 센다 (다계정이면 계정마다 따로) */
  accountId?: string,
): Promise<{ likes: number; comments: number }> {
  const n = settings.neighbor;
  const feed = await fetchNeighborFeed(context, 40);
  const page = await context.newPage();

  let likes = 0;
  let comments = 0;

  try {
    for (const item of feed) {
      if (shouldStop()) { log.info("중지 요청 — 이웃 소통 중단"); break; }
      // 한도 체크
      const likeRoom = todayCount("like", accountId) < n.dailyLikeLimit;
      const commentRoom = todayCount("comment", accountId) < n.dailyCommentLimit;
      if (!likeRoom && !commentRoom) {
        log.info("일일 공감·댓글 한도 도달 — 라운드 종료");
        break;
      }
      // 최근 이 블로그에 이미 활동했으면 스킵 (도배 방지)
      if (actedRecently(item.blogId, "comment", 3, accountId) && actedRecently(item.blogId, "like", 3, accountId)) {
        continue;
      }

      // 맥락형 댓글 생성 (한도 남았을 때만)
      let comment: string | null = null;
      if (commentRoom && !actedRecently(item.blogId, "comment", 7, accountId)) {
        try {
          const post = await fetchPostContent(item.blogId, item.logNo, item.title);
          comment = await generateComment(apiKey, settings.model, post.title, post.text);
        } catch (err) {
          log.warn("댓글 생성 스킵", err);
        }
      }

      // 공감 한도가 차도 댓글은 계속할 수 있어야 한다 (예전엔 likeRoom이 댓글까지 막았음)
      const { liked, commented } = await engagePost(page, item, comment, likeRoom);
      if (liked) {
        logActivity({ accountId, action: "like", targetBlogId: item.blogId, targetLogNo: item.logNo, ok: true });
        likes++;
        log.info(`♥ 공감 ${item.blogId} (오늘 ${todayCount("like", accountId)}/${n.dailyLikeLimit})`);
      }
      if (commented && comment) {
        logActivity({ accountId, action: "comment", targetBlogId: item.blogId, targetLogNo: item.logNo, message: comment, ok: true });
        comments++;
        log.info(
          `💬 댓글 등록 ${item.blogId} (오늘 ${todayCount("comment", accountId)}/${n.dailyCommentLimit}) — "${comment.slice(0, 30)}${comment.length > 30 ? "…" : ""}"`,
        );
      }

      // 사람처럼 다음 글로 넘어가는 간격
      await humanDelay(n.minDelaySec, n.maxDelaySec);
    }
  } finally {
    await page.close().catch(() => {});
  }

  log.info(`이웃 소통 완료 — 공감 ${likes} · 댓글 ${comments}`);
  return { likes, comments };
}

/**
 * 서로이웃 신청 라운드: 주제 키워드로 블로그를 찾아 서로이웃 신청.
 * ⚠️ 튜닝 필요: 블로그 검색 결과 파싱 + 서로이웃 신청 플로우.
 */
export async function runBuddyRequestRound(
  context: BrowserContext,
  settings: Settings,
  apiKey: string,
  accountId?: string,
): Promise<{ requests: number }> {
  const n = settings.neighbor;
  if (!n.buddyRequestEnabled || n.buddyTopicKeywords.length === 0) {
    return { requests: 0 };
  }

  const page = await context.newPage();
  let requests = 0;

  try {
    for (const topic of n.buddyTopicKeywords) {
      if (todayCount("buddy-request", accountId) >= n.dailyBuddyRequestLimit) break;

      // 블로그 검색 (모바일) — 대상 blogId 수집
      const searchUrl = `https://m.search.naver.com/search.naver?where=m_blog&query=${encodeURIComponent(topic)}`;
      await page.goto(searchUrl, { waitUntil: "domcontentloaded" });
      await humanDelay(1.5, 3);

      const blogIds = await page.$$eval("a[href*='blog.naver.com']", (anchors) => {
        const ids = new Set<string>();
        anchors.forEach((a) => {
          const m = (a as { href: string }).href.match(/blog\.naver\.com\/([A-Za-z0-9_-]+)/);
          if (m) ids.add(m[1]!);
        });
        return [...ids];
      });

      for (const blogId of blogIds) {
        if (shouldStop()) break;
        if (todayCount("buddy-request", accountId) >= n.dailyBuddyRequestLimit) break;
        if (actedRecently(blogId, "buddy-request", 30, accountId)) continue;

        try {
          const message = await generateBuddyMessage(
            apiKey,
            settings.model,
            blogId,
            topic,
            settings.brandName,
          );
          const ok = await sendBuddyRequest(context, blogId, message);
          logActivity({ accountId, action: "buddy-request", targetBlogId: blogId, message, ok });
          if (ok) requests++;
          await humanDelay(n.minDelaySec, n.maxDelaySec);
        } catch (err) {
          log.warn(`서로이웃 신청 실패 ${blogId}`, err);
        }
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  log.info(`서로이웃 신청 완료 — ${requests}건`);
  return { requests };
}

/** 개별 서로이웃 신청 — ⚠️ 튜닝 필요 */
async function sendBuddyRequest(
  context: BrowserContext,
  blogId: string,
  message: string,
): Promise<boolean> {
  const page = await context.newPage();
  try {
    const url = `https://m.blog.naver.com/BuddyAddForm.naver?blogId=${encodeURIComponent(blogId)}`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await humanDelay(1, 2.5);

    // 서로이웃 라디오 선택 (label 클릭). 서로이웃 불가 블로그면 선택 안 됨 → 스킵.
    try {
      await page.locator(SEL.buddyBothLabel).first().click({ timeout: 4000 });
      await humanDelay(0.4, 0.8);
    } catch {
      log.warn(`${blogId}: 서로이웃 항목 없음 — 스킵`);
      return false;
    }
    const bothChecked = await page
      .locator(SEL.buddyBothRadio)
      .first()
      .isChecked()
      .catch(() => false);
    if (!bothChecked) {
      log.warn(`${blogId}: 서로이웃 신청 불가(비활성) — 스킵`);
      return false;
    }

    // 신청 메시지
    try {
      const area = page.locator(SEL.buddyMessage).first();
      await area.click();
      await area.fill(message);
    } catch {
      /* 메시지 칸 없어도 진행 */
    }
    await humanDelay(0.5, 1.2);

    // 확인
    await page.locator(SEL.buddyConfirm).first().click({ timeout: 4000 });
    await humanDelay(1, 2);
    log.info(`서로이웃 신청 완료: ${blogId}`);
    return true;
  } catch (err) {
    log.warn(`서로이웃 신청 실패 ${blogId}`, err);
    return false;
  } finally {
    await page.close().catch(() => {});
  }
}

export { MOBILE_UA };
