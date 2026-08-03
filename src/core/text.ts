// 한국어 텍스트 처리 유틸 — senbiPost src/lib/textUtils.ts 에서 이식

/** 공백·줄바꿈 제외 글자 수 */
export function countChars(text: string): number {
  return text.replace(/\s/g, "").length;
}

/** 줄바꿈 제외, 공백 포함 글자 수 */
export function countCharsWithSpaces(text: string): number {
  return text.replace(/\n/g, "").length;
}

// 줄 끝으로 자연스러운 어절 끝 — 조사·어미·문장부호. 이 위치에서 끊으면 덜 어색하다.
const GOOD_LINE_END =
  /(은|는|이|가|을|를|에|의|도|만|과|와|로|으로|에서|에게|께|부터|까지|보다|처럼|마다|고|며|서|데|면|지만|라서|니까|어서|아서|거나|든|든지|요|죠|다|네요|어요|아요|해요|세요|습니다|입니다|랍니다|합니다|[.,!?~…])$/;

function endsNatural(word: string): boolean {
  return GOOD_LINE_END.test(word);
}

/**
 * 앞 어절에 붙어야 자연스러운 말들 — 이 앞에서 줄을 끊으면 어색하다.
 * 예: "차가 지날 선을 / 따라" (X) → "차가 지날 선을 따라" (O)
 */
const DEPENDENT_WORD =
  /^(따라|대로|수|것|점|때|뒤|후|중|등|및|만큼|뿐|채|줄|편|쪽|측|안|밖|위|아래|앞|옆|사이|같이|정도|이상|이하|가지|번|개|대|명|곳)/;

/**
 * 뒤 명사를 꾸미는 관형형("쓰는", "지은", "따뜻한")인지 — 이 뒤에서 끊으면 "쓰는 / 장비"처럼 어색하다.
 * 조사 '는'(칸에는·으로는…)은 제외해서 정상적인 끊김을 방해하지 않는다.
 */
function isAdnominal(word: string): boolean {
  if (/(에는|서는|로는|고는|지는|기는|만은|과는|와는|보다는)$/.test(word)) return false;
  return /(는|던)$/.test(word) && word.length <= 4;
}

/**
 * 한 문단을 균형 잡힌 여러 줄로 나눈다.
 * 그리디로 꽉 채우면 마지막 줄에 한 어절만 남는(고아) 일이 잦아서,
 * 줄 수를 먼저 정하고 각 줄 길이가 고르게 되도록 최적 분할을 찾는다(DP).
 */
function wrapWords(words: string[], maxChars: number): string[] {
  const n = words.length;
  if (n === 0) return [];
  const total = words.join(" ").length;
  if (total <= maxChars) return [words.join(" ")];

  const lineCount = Math.max(2, Math.ceil(total / maxChars));
  const ideal = total / lineCount; // 줄당 목표 길이
  const lenOf = (i: number, j: number) => words.slice(i, j).join(" ").length;

  const best = new Array<number>(n + 1).fill(Infinity);
  const prev = new Array<number>(n + 1).fill(-1);
  best[0] = 0;

  for (let j = 1; j <= n; j++) {
    for (let i = 0; i < j; i++) {
      const bi = best[i]!;
      if (bi === Infinity) continue;
      const L = lenOf(i, j);
      if (L > maxChars + 4 && j - i > 1) continue; // 너무 긴 줄 제외(한 어절뿐이면 허용)

      let cost = (L - ideal) ** 2; // 고르게 나눌수록 좋다
      if (j < n) {
        if (!endsNatural(words[j - 1]!)) cost += 45; // 조사·어미로 안 끝나면 어색
        if (DEPENDENT_WORD.test(words[j]!)) cost += 130; // 다음 어절이 앞에 붙어야 하면 크게 감점
        if (isAdnominal(words[j - 1]!)) cost += 70; // "쓰는 / 장비" 처럼 꾸미는 말과 명사를 가르지 않기
      } else if (L < Math.min(9, ideal * 0.55)) {
        cost += 150; // 마지막 줄에 한 어절만 남는 '고아 줄' 방지
      }

      if (bi + cost < best[j]!) {
        best[j] = bi + cost;
        prev[j] = i;
      }
    }
  }

  const cuts: number[] = [];
  for (let j = n; j > 0; j = prev[j]!) {
    cuts.push(j);
    if (prev[j]! < 0) break;
  }
  cuts.reverse();

  const lines: string[] = [];
  let start = 0;
  for (const c of cuts) {
    const seg = words.slice(start, c).join(" ");
    if (seg) lines.push(seg);
    start = c;
  }
  return lines.length > 0 ? lines : [words.join(" ")];
}

/**
 * 자주 묻는 질문의 "Q." "A." 를 각각 독립 문단으로 떼어 놓는다.
 *
 * 모델이 질문 끝에 물음표를 빠뜨리면("…반납하나요 A. 굽는 망과…") 문장 경계를 못 찾아
 * 질문과 답이 한 줄에 붙어버린다. 줄바꿈을 먹이기 전에 여기서 정리한다.
 */
export function splitFaqBlocks(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    // 줄 한가운데 나타난 Q./A. 앞을 문단 경계로
    .replace(/([^\n])\s+(?=[QA]\.\s)/g, "$1\n\n")
    // 이미 줄바꿈으로만 나뉜 Q./A. 도 빈 줄로 벌린다
    .replace(/\n(?!\n)(?=[QA]\.\s)/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * 네이버 블로그 모바일 가독성용 줄바꿈.
 * - 어절(공백) 중간은 절대 끊지 않고, 가능하면 조사·어미로 끝나는 자리에서 끊어 자연스럽게.
 * - 한 줄이 maxChars를 넘지 않도록 하되, 자연스러운 끊김을 우선한다.
 * - 문단(빈 줄) 구조는 그대로 유지한다.
 */
export function wrapForMobile(text: string, maxChars = 20): string {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .split(/\n{2,}/);

  const wrapped = paragraphs.map((paragraph) => {
    // 문장 끝(. ! ? ~ …)에서 먼저 나눈다 — 문장이 바뀌는 자리가 가장 자연스러운 줄바꿈이다.
    // 단 "Q." "A." 같은 자주 묻는 질문 표기 뒤에서는 나누지 않는다 (표기만 덩그러니 남는다)
    const sentences = paragraph
      .replace(/\s+/g, " ")
      .trim()
      .split(/(?<!(?:^|\s)[QA]\.)(?<=[.!?~…])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const lines: string[] = [];
    for (const sentence of sentences) {
      const words = sentence.split(/\s+/).filter(Boolean);
      lines.push(...wrapWords(words, maxChars));
    }
    return lines.join("\n");
  });

  return wrapped.filter((p) => p.length > 0).join("\n\n");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 여러 어절 문구를 유연하게 매칭하는 정규식.
 * joiner 기본 "\\s*" — 붙여쓴 변형까지 잡는다(스코어·잔존검사 공용).
 */
export function buildFlexiblePattern(
  snippet: string,
  flags = "",
  joiner = "\\s*",
): RegExp | null {
  const tokens = snippet.split(/\s+/).filter(Boolean).map(escapeRegex);
  if (tokens.length === 0) return null;
  return new RegExp(tokens.join(joiner), flags);
}

/**
 * 필터 단어가 본문에 남아 있는지 검사 (대소문자 무시).
 * senbiPost 의 findRemainingWords 와 동일 규칙.
 */
export function findRemainingWords(
  text: string,
  filters: { word: string; replacement?: string }[],
): string[] {
  const lower = text.toLowerCase();
  return filters
    .filter((f) => {
      const parts = f.word.toLowerCase().split(/\s+/).filter(Boolean);
      if (parts.length === 0) return false;
      const escaped = parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      const pattern = new RegExp(escaped.join("\\s*"));

      let haystack = lower;
      if (f.replacement) {
        const rep = f.replacement.toLowerCase();
        if (rep && pattern.test(rep)) {
          haystack = haystack.split(rep).join(" ");
        }
      }
      return pattern.test(haystack);
    })
    .map((f) => f.word);
}
