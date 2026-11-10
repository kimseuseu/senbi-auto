import fs from "node:fs";
import path from "node:path";
import { request } from "playwright";
import { dataPath, ensureDir } from "../config/paths";
import { createLogger } from "../core/logger";

const log = createLogger("proxy");

// 계정별 프록시.
//
// 왜: 이 PC의 IP로 여러 아이디가 로그인·발행하면 네이버가 로그인 직후 보호조치를 건다(실측).
// 계정마다 정해진 IP(프록시)로만 네이버에 접속하게 한다 — 로그인·세션 확인·발행·이웃 관리 전부.
//
// 원칙: 프록시를 적어 둔 계정은 프록시가 안 되면 **멈춘다**. 이 PC의 IP로 몰래 대신 접속하지 않는다.

export interface ProxyConfig {
  /** Playwright 에 넘기는 주소 (http://1.2.3.4:8080) */
  server: string;
  username?: string;
  password?: string;
  /** 화면·로그에 보여 줄 값 — 비밀번호는 빠진다 (1.2.3.4:8080) */
  label: string;
}

export type ParsedProxy = { ok: true; proxy: ProxyConfig | null } | { ok: false; error: string };

const HOST_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)$/i;

function validHost(h: string): boolean {
  if (!HOST_RE.test(h)) return false;
  if (/^\d+(\.\d+){3}$/.test(h)) return h.split(".").every((n) => Number(n) <= 255);
  return true;
}

/**
 * 사용자가 적은 프록시를 해석한다. 빈 값은 '프록시 안 씀'.
 *   1.2.3.4:8080
 *   1.2.3.4:8080:아이디:비밀번호      (프록시 업체가 흔히 주는 모양)
 *   아이디:비밀번호@1.2.3.4:8080
 *   http:// · https:// · socks5:// 를 앞에 붙여도 된다 (없으면 http)
 */
export function parseProxy(raw: string | undefined | null): ParsedProxy {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: true, proxy: null };

  let scheme = "http";
  let rest = text;
  const m = /^([a-z0-9]+):\/\//i.exec(rest);
  if (m) {
    scheme = (m[1] ?? "").toLowerCase();
    rest = rest.slice(m[0].length);
  }
  if (!["http", "https", "socks5"].includes(scheme)) {
    return { ok: false, error: `지원하지 않는 프록시 종류입니다: ${scheme} (http · https · socks5 만 가능)` };
  }
  rest = rest.replace(/\/+$/, "");

  let username: string | undefined;
  let password: string | undefined;
  let hostPort = rest;
  // IP:포트:아이디:비밀번호 를 먼저 본다 — 비밀번호에 @ 가 들어 있어도 이 모양이다
  const colonForm = /^[^:@/]+:\d+:/.test(rest);
  const at = colonForm ? -1 : rest.lastIndexOf("@");
  if (at >= 0) {
    const cred = rest.slice(0, at);
    hostPort = rest.slice(at + 1);
    const c = cred.indexOf(":");
    username = c >= 0 ? cred.slice(0, c) : cred;
    password = c >= 0 ? cred.slice(c + 1) : "";
  } else {
    const parts = rest.split(":");
    if (parts.length >= 4) {
      // 1.2.3.4:8080:아이디:비밀번호 (비밀번호에 : 가 있어도 그대로)
      hostPort = `${parts[0] ?? ""}:${parts[1] ?? ""}`;
      username = parts[2];
      password = parts.slice(3).join(":");
    } else if (parts.length !== 2) {
      return { ok: false, error: "프록시는 IP:포트 모양으로 적어 주세요. 예) 123.45.67.89:8080" };
    }
  }

  const hp = hostPort.split(":");
  if (hp.length !== 2) {
    return { ok: false, error: "프록시는 IP:포트 모양으로 적어 주세요. 예) 123.45.67.89:8080" };
  }
  const host = hp[0] ?? "";
  const portText = hp[1] ?? "";
  const port = Number(portText);
  if (!validHost(host)) return { ok: false, error: `프록시 IP(주소)가 올바르지 않습니다: ${host}` };
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) {
    return { ok: false, error: `프록시 포트가 올바르지 않습니다: ${portText} (1~65535)` };
  }
  if (scheme === "socks5" && username) {
    // 크로미움은 아이디·비밀번호가 붙은 SOCKS5 프록시를 지원하지 않는다
    return {
      ok: false,
      error: "아이디·비밀번호가 있는 socks5 프록시는 브라우저가 지원하지 않습니다. http 프록시로 받아 주세요.",
    };
  }

  const label = `${scheme === "http" ? "" : `${scheme}://`}${host}:${port}`;
  return {
    ok: true,
    proxy: {
      server: `${scheme}://${host}:${port}`,
      ...(username ? { username, password: password ?? "" } : {}),
      label,
    },
  };
}

/** 저장된 값을 화면에 돌려줄 때 — 비밀번호는 가린다 */
export function maskProxy(raw: string | undefined | null): string {
  const p = parseProxy(raw);
  if (!p.ok || !p.proxy) return String(raw ?? "");
  return p.proxy.username ? `${p.proxy.label}:${p.proxy.username}:••••` : p.proxy.label;
}

export const MASK = "••••";

// IP 를 되돌려 주는 공개 서비스 — 하나가 막혀도 다음 것으로
const IP_ECHO = ["https://api.ipify.org?format=json", "https://ipinfo.io/json", "https://icanhazip.com"];

function pickIp(body: string): string | null {
  try {
    const j = JSON.parse(body) as { ip?: string };
    if (j.ip) return String(j.ip).trim();
  } catch {
    /* 평문 */
  }
  const m = /(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{7,})/i.exec(body.trim());
  return m?.[1] ?? null;
}

/** 프록시를 거쳐 밖에서 보이는 IP. 프록시가 안 되면 오류를 던진다. */
export async function proxyExitIp(proxy: ProxyConfig, timeoutMs = 12000): Promise<string> {
  const ctx = await request.newContext({
    proxy: { server: proxy.server, username: proxy.username, password: proxy.password },
    timeout: timeoutMs,
    ignoreHTTPSErrors: false,
  });
  let lastErr: unknown = null;
  try {
    for (const url of IP_ECHO) {
      try {
        const res = await ctx.get(url, { timeout: timeoutMs });
        if (res.status() === 407) throw new Error("프록시가 아이디·비밀번호를 요구합니다 (407)");
        if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
        const ip = pickIp(await res.text());
        if (ip) return ip;
        throw new Error("IP 를 읽지 못함");
      } catch (err) {
        lastErr = err;
        if (err instanceof Error && /407/.test(err.message)) break;
      }
    }
  } finally {
    await ctx.dispose().catch(() => {});
  }
  // 브라우저 오류는 여러 줄(Call log …)이라 첫 줄만, 앞의 함수 이름은 떼고 쓴다
  const why = (lastErr instanceof Error ? lastErr.message : String(lastErr))
    .split("\n")[0]!
    .replace(/^apiRequestContext\.\w+:\s*/, "");
  throw new Error(
    `프록시(${proxy.label})로 접속하지 못했습니다 — ${why}. ` +
      "프록시 프로그램이 켜져 있는지, IP·포트가 맞는지 확인해 주세요. " +
      "이 PC의 IP로 대신 접속하지 않도록 작업을 멈췄습니다.",
  );
}

/** 프록시 없이 이 PC가 밖에서 보이는 IP (확인 화면에서 비교용). 실패하면 null. */
export async function directIp(timeoutMs = 8000): Promise<string | null> {
  for (const url of IP_ECHO) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) continue;
      const ip = pickIp(await res.text());
      if (ip) return ip;
    } catch {
      /* 다음 */
    }
  }
  return null;
}

// ---------- 로그인한 IP 기록 ----------
// 세션(쿠키)은 로그인한 IP 에 묶어 쓴다. 이 PC의 IP로 로그인한 세션을 프록시 IP로 들고 가면
// 그 자체가 'IP가 갑자기 바뀐 로그인'으로 보인다 → 그런 세션으로는 작업하지 않고 다시 로그인하게 한다.

export interface LoginIpRecord {
  /** 로그인할 때 쓴 프록시 (label, 비밀번호 없음). 프록시 없이 로그인했으면 "" */
  proxy: string;
  /** 그때 밖에서 보인 IP (프록시 없이 로그인했으면 확인 안 함 → null) */
  ip: string | null;
  at: string;
}

function loginIpFile(accountId: string): string {
  return dataPath("accounts", accountId, "login-ip.json");
}

export function readLoginIp(accountId: string): LoginIpRecord | null {
  try {
    return JSON.parse(fs.readFileSync(loginIpFile(accountId), "utf8")) as LoginIpRecord;
  } catch {
    return null;
  }
}

export function recordLoginIp(accountId: string, proxy: ProxyConfig | null, ip: string | null): void {
  const file = loginIpFile(accountId);
  ensureDir(path.dirname(file));
  const rec: LoginIpRecord = { proxy: proxy?.label ?? "", ip, at: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(rec, null, 2), "utf8");
  log.info(`[${accountId}] 로그인 IP 기록: ${proxy ? `${proxy.label} → ${ip}` : "프록시 없음"}`);
}

/**
 * 지금 세션을 이 프록시로 써도 되는지. 안 되면 사용자에게 보여 줄 이유.
 * - 프록시를 안 쓰는 계정: 항상 통과 (예전과 같다)
 * - 프록시를 쓰는 계정: 같은 프록시로 로그인한 세션이어야 한다
 */
export function sessionProxyMismatch(accountId: string, proxy: ProxyConfig | null): string | null {
  if (!proxy) return null;
  const rec = readLoginIp(accountId);
  if (rec && rec.proxy === proxy.label) return null;
  const was = rec?.proxy ? `다른 프록시(${rec.proxy})` : "이 PC의 IP";
  return (
    `이 계정의 로그인 세션은 ${was}로 로그인한 것입니다. ` +
    `그대로 프록시(${proxy.label})로 쓰면 IP가 갑자기 바뀐 접속으로 보입니다. ` +
    "상세 설정 → 블로그 계정에서 이 계정으로 다시 로그인해 주세요 (프록시 IP로 로그인됩니다)."
  );
}

/**
 * 화면에서 돌아온 값에 가려진 비밀번호(••••)가 있으면 저장된 비밀번호로 되돌린다.
 * 저장된 비밀번호가 없는데 •••• 가 왔으면 null (다시 적게 한다).
 */
export function restoreProxyPassword(input: string, stored: string | undefined | null): string | null {
  if (!input.includes(MASK)) return input;
  const prev = parseProxy(stored);
  if (!prev.ok || !prev.proxy?.username) return null;
  return input.replace(MASK, prev.proxy.password ?? "");
}
