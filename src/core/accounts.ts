import fs from "node:fs";
import { JsonStore } from "../config/store";
import {
  getSettings,
  isVisibility,
  cleanNumber,
  cleanString,
  cleanStringList,
  sanitizeNeighborPatch,
  type NeighborSettings,
  type Sanitized,
  type Settings,
} from "../config/settings";
import { normalizeBlogId, isValidBlogId, resolveBlogId } from "../crawl/rss";
import { dataPath, ensureDir } from "../config/paths";
import type { Visibility } from "../naver/publish";
import { createLogger } from "./logger";
import { parseProxy, MASK } from "../naver/proxy";

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
  /**
   * 이 계정이 네이버에 접속할 프록시 (IP:포트, 또는 IP:포트:아이디:비밀번호). 비우면 이 PC의 IP.
   * 적어 두면 로그인·세션 확인·발행·이웃 관리가 전부 이 IP로만 나간다 (안 되면 멈춘다).
   */
  proxy?: string;
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

/**
 * 계정에 적힌 블로그 아이디를 블로그의 실제 주소로 바로잡는다.
 * 로그인 아이디와 블로그 주소가 다른 계정은 그대로 두면 학습도 겹침 확인도 되지 않는다.
 * @returns 바로잡은 계정 수
 */
export async function fixAccountBlogIds(): Promise<number> {
  let fixed = 0;
  for (const acc of listAccounts()) {
    const real = await resolveBlogId(acc.blogId);
    if (!real || real === acc.blogId) continue;
    log.info(`계정 "${acc.name}": 블로그 주소를 ${acc.blogId} → ${real} 로 바로잡음 (로그인 아이디와 주소가 다른 블로그)`);
    updateAccount(acc.id, { blogId: real });
    fixed++;
  }
  return fixed;
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
    proxy: partial.proxy ?? "",
    createdAt: now(),
    updatedAt: now(),
  };
  store.update((d) => {
    d.accounts.push(acc);
    return d;
  });
  return acc;
}

/**
 * 대시보드 API 로 들어온 계정 값 검증 — 모르는 필드는 버리고, 숫자는 범위 안으로 맞춘다.
 * 블로그 아이디는 세션 폴더 이름에도 쓰이므로 형식이 틀리면 저장 자체를 거부한다.
 */
export function sanitizeAccountPatch(input: unknown): Sanitized<Account> {
  if (!input || typeof input !== "object") return { ok: false, error: "계정 값이 비어 있습니다." };
  const p = input as Record<string, unknown>;
  const patch: Partial<Account> = {};

  if (p.blogId !== undefined) {
    const blogId = typeof p.blogId === "string" ? normalizeBlogId(p.blogId) : "";
    if (!isValidBlogId(blogId)) {
      return { ok: false, error: "블로그 아이디 형식이 올바르지 않습니다(영문·숫자·-·_ 만 가능)." };
    }
    patch.blogId = blogId;
  }
  if (p.postVisibility !== undefined) {
    if (!isVisibility(p.postVisibility)) {
      return { ok: false, error: "공개 범위 값이 올바르지 않습니다." };
    }
    patch.postVisibility = p.postVisibility;
  }

  const name = cleanString(p.name, 60);
  if (name) patch.name = name;
  const templateId = cleanString(p.templateId, 120);
  if (templateId !== undefined) patch.templateId = templateId;
  const postCategory = cleanString(p.postCategory, 60);
  if (postCategory !== undefined) patch.postCategory = postCategory;
  const topicKeywords = cleanStringList(p.topicKeywords);
  if (topicKeywords) patch.topicKeywords = topicKeywords;
  if (typeof p.autoKeyword === "boolean") patch.autoKeyword = p.autoKeyword;
  const postsPerRun = cleanNumber(p.postsPerRun, 1, 20);
  if (postsPerRun !== undefined) patch.postsPerRun = postsPerRun;
  const postIntervalMin = cleanNumber(p.postIntervalMin, 0, 240);
  if (postIntervalMin !== undefined) patch.postIntervalMin = postIntervalMin;
  const neighbor = sanitizeNeighborPatch(p.neighbor);
  if (neighbor) patch.neighbor = neighbor as NeighborSettings;
  if (p.proxy !== undefined) {
    if (typeof p.proxy !== "string") return { ok: false, error: "프록시 값이 올바르지 않습니다." };
    const raw = p.proxy.trim().slice(0, 300);
    // 가려진 비밀번호(••••)가 섞인 값은 호출하는 쪽에서 저장된 비밀번호로 되돌린 뒤 넘긴다
    const parsed = parseProxy(raw.replace(MASK, "x"));
    if (!parsed.ok) return { ok: false, error: parsed.error };
    patch.proxy = raw;
  }

  return { ok: true, patch };
}

export function updateAccount(id: string, patch: Partial<Account>): Account | null {
  store.update((d) => {
    const a = d.accounts.find((x) => x.id === id);
    if (a) {
      const { neighbor, ...rest } = patch;
      Object.assign(a, rest, { id: a.id, updatedAt: now() });
      if (neighbor) a.neighbor = { ...a.neighbor, ...neighbor };
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
