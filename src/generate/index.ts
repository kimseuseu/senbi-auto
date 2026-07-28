import type { GenerateResult, ReferencePost } from "../core/types";
import type { Settings } from "../config/settings";
import { runPipeline } from "./pipeline";
import { createLogger } from "../core/logger";

const log = createLogger("generate");

export { runPipeline };

/**
 * 크롤링한 참고글을 학습해 지정 키워드로 글 1편을 생성한다.
 * brandName 이 설정돼 있으면 화자 정체성으로 주입해 참고글 상호 복사를 막는다.
 */
export async function generateFromReferences(
  settings: Settings,
  references: ReferencePost[],
  mainKeyword: string,
  apiKey: string,
  instructions?: string,
): Promise<GenerateResult> {
  // 키워드 하나 = 글 하나. 다른 주제 키워드를 서브로 섞지 않는다.
  // 서브키워드는 메인 키워드 자체를 구성하는 어절(롱테일)만 사용.
  const subKeywords = [
    ...new Set(mainKeyword.split(/\s+/).map((w) => w.trim()).filter((w) => w.length >= 2)),
  ]
    .filter((w) => w !== mainKeyword)
    .slice(0, 3);

  const userInfo = settings.brandName?.trim()
    ? [
        {
          question: "이 글의 화자(블로그·업체) 이름은 무엇인가요?",
          answer: settings.brandName.trim(),
        },
      ]
    : [];

  log.info(`글 생성 시작 — 메인키워드 "${mainKeyword}", 참고글 ${references.length}건`);

  const result = await runPipeline({
    mainKeyword,
    subKeywords,
    references,
    filters: settings.filters ?? [],
    lineWidth: settings.lineWidth,
    apiKey,
    model: settings.model,
    postType: settings.postType,
    userInfo,
    instructions,
    onProgress: (stage) => log.debug(`파이프라인 단계: ${stage}`),
  });

  log.info(
    `생성 완료 — "${result.title}" (${result.charCount}자, 센비 ${result.score?.total ?? "-"} / GEO ${result.geoScore?.total ?? "-"})`,
  );
  return result;
}

/** 이 글의 키워드에서 태그 생성 — 공백제거 합성어 + 어절 (다른 주제는 안 섞음) */
export function keywordTags(keyword: string): string[] {
  const words = keyword
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);
  return [...new Set([keyword.replace(/\s+/g, ""), ...words])].slice(0, 6);
}

/** topicKeywords 중 아직 안 쓴 키워드를 고른다 (간단 라운드로빈용 훅) */
export function pickNextKeyword(
  keywords: string[],
  usedKeywords: string[],
): string | null {
  const unused = keywords.find((k) => !usedKeywords.includes(k));
  return unused ?? keywords[0] ?? null;
}
