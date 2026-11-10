import { fetchBlogRss } from "../crawl/rss";
import { createLogger } from "../core/logger";

const log = createLogger("keywords");

/**
 * 거래·작업 방식을 가리키는 말. 글의 소재(무엇을)가 아니라 방식(어떻게)이라
 * "돈풍기 대여"와 "돈풍기 임대"처럼 이것만 다른 두 키워드는 같은 주제다.
 * 긴 것부터 둔다 — "주문제작"이 "제작"보다 먼저 걸려야 한다.
 */
export const ACTION_WORDS = [
  "주문제작",
  "렌탈",
  "렌트",
  "대여",
  "임대",
  "구입",
  "구매",
  "매입",
  "판매",
  "제작",
  "설치",
  "시공",
] as const;

/** 어절이 거래어로 끝나면 그 거래어를 돌려준다 ("렌탈" → 렌탈, "대형트리렌탈" → 렌탈) */
export function actionSuffix(word: string): string | null {
  return ACTION_WORDS.find((a) => word.endsWith(a)) ?? null;
}

/** 제목/키워드 비교용 정규화 — 공백·조사성 어미 제거 후 소문자 */
function norm(s: string): string {
  return s.replace(/\s+/g, "").replace(/[,·|~\-–—()[\]]/g, "").toLowerCase();
}

function hasAction(s: string): boolean {
  return s.split(/\s+/).some((w) => actionSuffix(w) !== null);
}

/**
 * 거래어를 뺀 '소재' 어절만 남긴다.
 * ("돈풍기 대여" → [돈풍기], "대형트리렌탈 연말" → [대형트리, 연말])
 */
function subjectWords(s: string): string[] {
  return s
    .split(/\s+/)
    .map((w) => {
      const a = actionSuffix(w);
      return norm(a ? w.slice(0, w.length - a.length) : w);
    })
    .filter((w) => w.length >= 2);
}

/**
 * 이미 다룬 주제와 겹치는지.
 *  - 한쪽이 다른 쪽을 통째로 포함하거나
 *  - 소재 어절을 2개 이상 공유하거나
 *  - 소재가 같고 거래어(렌탈·대여·임대…)만 다르면 겹침으로 본다
 *
 * 거래어는 공유 어절로 세지 않는다 — 렌탈 블로그는 키워드마다 "렌탈"이 붙어 있어서,
 * 이걸 세면 "카페 집기 렌탈"과 "주방집기 렌탈"처럼 다른 소재까지 겹친다고 나온다.
 */
export function overlapsExisting(keyword: string, existing: string[]): boolean {
  const k = norm(keyword);
  if (!k) return true;
  const subject = subjectWords(keyword);
  const keywordHasAction = hasAction(keyword);
  for (const e of existing) {
    const n = norm(e);
    if (!n) continue;
    if (n.includes(k) || k.includes(n)) return true;
    const shared = subject.filter((w) => n.includes(w)).length;
    // 소재 어절이 둘 이상 겹치면 사실상 같은 주제.
    // 붙여 쓴 합성어도 같은 말로 본다 ("대형제습기" ⊃ "제습기") — 2자짜리는 우연히 걸리기 쉬워 3자부터.
    const parts = subjectWords(e).filter((w) => w.length >= 3);
    const sharedLoose = subject.filter(
      (w) => n.includes(w) || parts.some((p) => w.includes(p)),
    ).length;
    if (subject.length >= 2 && sharedLoose >= 2) return true;
    // 소재가 전부 들어 있고 양쪽 다 거래어가 붙어 있다 = 같은 소재를 거래어만 바꿔 쓴 것
    if (subject.length >= 1 && shared === subject.length && keywordHasAction && hasAction(e)) {
      return true;
    }
  }
  return false;
}

const TITLES_TTL_MS = 10 * 60 * 1000;
const titlesCache = new Map<string, { at: number; posts: { title: string; at: number }[] }>();

/**
 * 발행 대상 블로그의 최근 글 제목 (RSS — 본문 안 받아서 가볍다).
 * 키워드 화면과 글 작성이 연달아 부르므로 잠깐 동안은 받아 둔 것을 쓴다.
 * (그 사이 우리가 올린 글은 '최근 쓴 키워드'로 따로 막히므로 빠져도 문제없다)
 */
export async function recentTitles(
  blogId: string,
  count = 20,
  /** 이 기간(일) 안에 올린 글만. 0이면 기간을 보지 않는다 */
  withinDays = 0,
): Promise<string[]> {
  const pick = (posts: { title: string; at: number }[]) => {
    const cutoff = withinDays > 0 ? Date.now() - withinDays * 86400_000 : 0;
    // 날짜를 못 읽은 글(at=0)은 기간을 따질 수 없으니 안전하게 포함한다
    return posts
      .filter((p) => cutoff === 0 || p.at === 0 || p.at >= cutoff)
      .slice(0, count)
      .map((p) => p.title);
  };
  const hit = titlesCache.get(blogId);
  if (hit && Date.now() - hit.at < TITLES_TTL_MS) return pick(hit.posts);
  try {
    const rss = await fetchBlogRss(blogId);
    const posts = rss.posts
      .map((p) => ({ title: p.title.trim(), at: p.pubDate ? Date.parse(p.pubDate) || 0 : 0 }))
      .filter((p) => p.title);
    titlesCache.set(blogId, { at: Date.now(), posts });
    return pick(posts);
  } catch (err) {
    log.warn(`최근 글 제목 조회 실패 (${blogId})`, err);
    return [];
  }
}
