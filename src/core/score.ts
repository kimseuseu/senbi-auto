import type { SenbiScore, ScoreAxis } from "./types";
import { countChars, buildFlexiblePattern } from "./text";

/**
 * 센비 스코어 — 네이버 노출 관점의 결정적(비 AI) 0~100 점수.
 * senbiPost src/lib/score.ts 이식.
 */
export function computeScore(input: {
  title: string;
  content: string;
  mainKeyword?: string;
  subKeywords?: string[];
  remainingFilterWords: string[];
}): SenbiScore {
  const axes: ScoreAxis[] = [];
  const { title, content } = input;
  const main = input.mainKeyword?.trim();
  const subs = (input.subKeywords ?? []).map((s) => s.trim()).filter(Boolean);

  // ---------- 키워드 배치 (35) ----------
  if (main) {
    const mainPattern = buildFlexiblePattern(main, "gi", "\\s*");
    const titleHits = mainPattern ? (title.match(mainPattern) ?? []).length : 0;
    const bodyHits = mainPattern ? (content.match(mainPattern) ?? []).length : 0;

    axes.push({
      key: "titleKeyword",
      label: "제목 키워드",
      score: titleHits >= 1 ? 10 : 0,
      max: 10,
      suggestion:
        titleHits >= 1 ? undefined : `제목에 메인키워드 "${main}"를 넣어 주세요.`,
    });

    let bodyScore: number;
    let bodySuggestion: string | undefined;
    if (bodyHits >= 4 && bodyHits <= 6) {
      bodyScore = 15;
    } else if (bodyHits === 3 || bodyHits === 7) {
      bodyScore = 11;
      bodySuggestion = `본문 메인키워드가 ${bodyHits}회입니다. 4~6회가 적정 범위예요.`;
    } else if (bodyHits === 2 || (bodyHits >= 8 && bodyHits <= 10)) {
      bodyScore = 7;
      bodySuggestion =
        bodyHits === 2
          ? "본문에 메인키워드를 2~3회 더 자연스럽게 넣어 주세요 (적정 4~6회)."
          : `메인키워드가 ${bodyHits}회로 과합니다. 키워드 반복(스터핑)은 저품질 위험이 있어요.`;
    } else {
      bodyScore = 3;
      bodySuggestion =
        bodyHits < 2
          ? "본문에 메인키워드가 거의 없습니다 (적정 4~6회)."
          : `메인키워드 ${bodyHits}회는 과도한 반복입니다. 줄여 주세요.`;
    }
    axes.push({
      key: "bodyKeyword",
      label: "본문 키워드 밀도",
      score: bodyScore,
      max: 15,
      suggestion: bodySuggestion,
    });

    if (subs.length > 0) {
      const covered = subs.filter((kw) => {
        const p = buildFlexiblePattern(kw, "i", "\\s*");
        return p ? p.test(content) || p.test(title) : false;
      });
      const ratio = covered.length / subs.length;
      const score = Math.round(ratio * 10);
      const missing = subs.filter((kw) => !covered.includes(kw));
      axes.push({
        key: "subKeywords",
        label: "서브키워드 커버리지",
        score,
        max: 10,
        suggestion:
          missing.length > 0 ? `빠진 서브키워드: ${missing.join(", ")}` : undefined,
      });
    } else {
      axes.push({
        key: "subKeywords",
        label: "서브키워드 커버리지",
        score: 10,
        max: 10,
      });
    }
  } else {
    axes.push({
      key: "keywords",
      label: "키워드 배치 (키워드 미지정)",
      score: 35,
      max: 35,
    });
  }

  // ---------- 분량 (20) ----------
  const chars = countChars(content);
  let lengthScore: number;
  let lengthSuggestion: string | undefined;
  if (chars >= 1000 && chars <= 1200) {
    lengthScore = 20;
  } else if (chars >= 900 && chars <= 1400) {
    lengthScore = 14;
    lengthSuggestion = `공백 제외 ${chars.toLocaleString()}자 — 1,000~1,200자가 적정 범위예요.`;
  } else if (chars >= 700 && chars <= 1800) {
    lengthScore = 8;
    lengthSuggestion = `공백 제외 ${chars.toLocaleString()}자로 적정 범위(1,000~1,200자)를 벗어났습니다.`;
  } else {
    lengthScore = 3;
    lengthSuggestion = `공백 제외 ${chars.toLocaleString()}자 — 분량 조정이 필요합니다 (적정 1,000~1,200자).`;
  }
  axes.push({
    key: "length",
    label: "분량",
    score: lengthScore,
    max: 20,
    suggestion: lengthSuggestion,
  });

  // ---------- 가독성 (25) ----------
  const paragraphs = content
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const paraCount = paragraphs.length;
  let paraCountScore: number;
  let paraCountSuggestion: string | undefined;
  if (paraCount >= 5) paraCountScore = 8;
  else if (paraCount >= 3) {
    paraCountScore = 5;
    paraCountSuggestion = `문단이 ${paraCount}개입니다. 5개 이상으로 나누면 모바일 가독성이 좋아져요.`;
  } else {
    paraCountScore = 2;
    paraCountSuggestion = "문단 구분(빈 줄)이 거의 없습니다. 내용 단위로 나눠 주세요.";
  }
  axes.push({
    key: "paragraphs",
    label: "문단 리듬",
    score: paraCountScore,
    max: 8,
    suggestion: paraCountSuggestion,
  });

  const longParas = paragraphs.filter((p) => countChars(p) > 300).length;
  const paraLenScore = longParas === 0 ? 9 : longParas === 1 ? 6 : 3;
  axes.push({
    key: "paragraphLength",
    label: "문단 길이",
    score: paraLenScore,
    max: 9,
    suggestion:
      longParas > 0
        ? `공백 제외 300자를 넘는 긴 문단이 ${longParas}개 있습니다. 나눠 주세요.`
        : undefined,
  });

  const sentences = content
    .split(/(?<=[.!?다요죠])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const avgSentence =
    sentences.length > 0
      ? sentences.reduce((a, s) => a + countChars(s), 0) / sentences.length
      : 0;
  let sentenceScore: number;
  let sentenceSuggestion: string | undefined;
  if (avgSentence > 0 && avgSentence <= 55) sentenceScore = 8;
  else if (avgSentence <= 75) {
    sentenceScore = 5;
    sentenceSuggestion = "문장이 다소 깁니다. 짧게 끊으면 모바일에서 읽기 편해요.";
  } else {
    sentenceScore = 2;
    sentenceSuggestion = "문장이 깁니다. 한 문장에 한 가지 내용만 담아 주세요.";
  }
  axes.push({
    key: "sentences",
    label: "문장 길이",
    score: sentenceScore,
    max: 8,
    suggestion: sentenceSuggestion,
  });

  // ---------- 클린도 (20) ----------
  const remaining = input.remainingFilterWords.length;
  const cleanScore = Math.max(20 - remaining * 10, 0);
  axes.push({
    key: "clean",
    label: "금칙어 클린",
    score: cleanScore,
    max: 20,
    suggestion:
      remaining > 0
        ? `금칙어 ${remaining}건이 남아 있습니다: ${input.remainingFilterWords.join(", ")}`
        : undefined,
  });

  const total = Math.min(
    100,
    axes.reduce((a, x) => a + x.score, 0),
  );
  return { total, axes };
}

export function scoreGrade(total: number): {
  label: string;
  tone: "good" | "ok" | "warn";
} {
  if (total >= 85) return { label: "노출 준비 완료", tone: "good" };
  if (total >= 65) return { label: "양호 — 일부 보완", tone: "ok" };
  return { label: "보완 필요", tone: "warn" };
}
