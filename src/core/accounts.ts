import fs from "node:fs";
import { JsonStore } from "../config/store";
import { getSettings, type NeighborSettings, type Settings } from "../config/settings";
import { dataPath, ensureDir } from "../config/paths";
import type { Visibility } from "../naver/publish";
import { createLogger } from "./logger";

const log = createLogger("accounts");

/** 계정(블로그) 하나 = 발행 대상 + 학습 소스 + 계정별 설정 + 자체 로그인 세션 */
export interface Account {
  id: string;
  name: string;
  blogId: string; // 발행 대상 블로그 아이디 (이 계정의 블로그)
  templateId: string; // 학습 템플릿 id (비우면 blogId 즉석 크롤)
  topicKeywords: string[];
  /** 주제 키워드를 AI가 자동으로 새로 뽑을지 (발행 블로그 최근 글과 안 겹치게) */
  autoKeyword: boolean;
  postVisibility: Visibility;
  /** 이 계정 블로그에서 글이 올라갈 카테고리 이름 (비우면 블로그 기본값) */
  postCategory: string;
  postsPerRun: number; // 발행할 글 수
  postIntervalMin: number; // 발행 텀 (글 사이 분)
  neighbor: NeighborSettings; // 이 계정 이웃 관리 설정
  createdAt: string;
  updatedAt: string;
}

interface AccountsDb {
  accounts: Account[];
}
const store = new JsonStore<AccountsDb>("accounts", { accounts: [] });

function now(): string {
  return new Date().toISOString();
}

/** 처음 실행 시 현재 단일 설정을 '계정 1'로 이관 */
export function ensureMigrated(): void {
  const db = store.read();
  if (db.accounts.length > 0) return;
  const s = getSettings();
  if (!s.blogId) return; // 아직 아무 설정 없음 — 이관 불필요
  const acc: Account = {
    id: `acc-${s.blogId}`,
    name: s.brandName?.trim() || s.blogId,
    blogId: s.blogId,
    templateId: s.activeTemplateId || "",
    topicKeywords: s.topicKeywords ?? [],
    autoKeyword: true, // 기본: 발행 블로그 최근 글과 안 겹치는 주제를 AI가 자동 선정
    postVisibility: s.postVisibility,
    postCategory: s.postCategory ?? "",
    postsPerRun: s.postsPerRun ?? 1,
    postIntervalMin: 5,
    neighbor: s.neighbor,
    createdAt: now(),
    updatedAt: now(),
  };
  store.update((d) => {
    d.accounts.push(acc);
    return d;
  });
  // 기존 단일 로그인 세션(루트 cookies.json)을 이 계정 폴더로 이관해 로그인 유지
  try {
    const legacy = dataPath("cookies.json");
    if (fs.existsSync(legacy)) {
      const dest = dataPath("accounts", acc.id, "cookies.json");
      ensureDir(dataPath("accounts", acc.id));
      fs.copyFileSync(legacy, dest);
      log.info(`기존 로그인 세션을 계정 "${acc.name}"으로 이관`);
    }
  } catch (err) {
    log.warn("기존 세션 이관 실패(무시)", err);
  }
  log.info(`현재 설정을 계정으로 이관: "${acc.name}" (${acc.blogId})`);
}

export function listAccounts(): Account[] {
  return store.read().accounts;
}

export function getAccount(id: string): Account | null {
  return store.read().accounts.find((a) => a.id === id) ?? null;
}

export function addAccount(
  partial: Partial<Account> & { name: string; blogId: string },
): Account {
  const s = getSettings();
  const acc: Account = {
    id: `acc-${partial.blogId}-${Date.now().toString(36)}`,
    name: partial.name,
    blogId: partial.blogId,
    templateId: partial.templateId ?? "",
    topicKeywords: partial.topicKeywords ?? [],
    autoKeyword: partial.autoKeyword ?? true,
    postVisibility: partial.postVisibility ?? "private",
    postCategory: partial.postCategory ?? "",
    postsPerRun: partial.postsPerRun ?? 1,
    postIntervalMin: partial.postIntervalMin ?? 5,
    neighbor: partial.neighbor ?? structuredClone(s.neighbor),
    createdAt: now(),
    updatedAt: now(),
  };
  store.update((d) => {
    d.accounts.push(acc);
    return d;
  });
  return acc;
}

export function updateAccount(id: string, patch: Partial<Account>): Account | null {
  store.update((d) => {
    const a = d.accounts.find((x) => x.id === id);
    if (a) {
      Object.assign(a, patch, { id: a.id, updatedAt: now() });
      if (patch.neighbor) a.neighbor = { ...a.neighbor, ...patch.neighbor };
    }
    return d;
  });
  return getAccount(id);
}

export function deleteAccount(id: string): void {
  store.update((d) => {
    d.accounts = d.accounts.filter((a) => a.id !== id);
    return d;
  });
}

/**
 * 계정 설정을 전역 Settings 위에 덮어써 이 계정 전용 Settings를 만든다.
 * (모델·API키·필터·이미지 옵션 등 공통값은 전역에서 상속)
 */
export function resolveAccountSettings(acc: Account): Settings {
  const base = getSettings();
  return {
    ...base,
    blogId: acc.blogId,
    activeTemplateId: acc.templateId,
    topicKeywords: acc.topicKeywords,
    autoKeyword: acc.autoKeyword ?? true,
    postVisibility: acc.postVisibility,
    postCategory: acc.postCategory ?? base.postCategory,
    postsPerRun: acc.postsPerRun,
    brandName: acc.name || base.brandName,
    neighbor: { ...base.neighbor, ...acc.neighbor },
  };
}
