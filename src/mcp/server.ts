import "./quiet";
import "dotenv/config";
import readline from "node:readline";
import { ensureAppDirs } from "../config/paths";
import { TOOLS, callTool } from "./tools";

/**
 * senbi-auto MCP 서버 — 클로드가 주체가 되어 네이버 블로그에 글을 올린다.
 *
 * 앱(대시보드)은 버튼을 누르면 API로 글을 만들어 올린다. 이 서버는 같은 엔진을 도구로 열어서,
 * 클로드가 키워드를 고르고 → 글을 직접 쓰고 → 검사하고 → 발행하게 한다. API 키가 필요 없다.
 *
 * 전송: 표준입출력, 한 줄에 JSON-RPC 메시지 하나.
 */

const INSTRUCTIONS = `senbi-auto는 네이버 블로그에 자사 제품 글을 올리는 도구다. 글은 네가 직접 쓴다.
순서: senbi_accounts(어느 블로그인지) → senbi_keywords(쓸 수 있는 키워드) → senbi_brief(글쓰기 지침·참고글·사진 후보) → 글 작성 → senbi_check(분량·겹침·필터 검사, 통과할 때까지 고쳐 쓴다) → senbi_publish.
키워드는 senbi_keywords 가 준 후보에서만 고른다(새로 지어내지 않는다). 같은 제품을 되풀이해 올리는 것이 목적이므로 주제가 겹치는 것은 문제가 아니다 — 막는 것은 너무 짧은 간격의 반복과 참고글 문장을 베끼는 것뿐이다.
senbi_publish 는 실제 블로그에 글이 올라간다. 사용자가 이번 대화에서 발행하라고 하지 않았다면 mode 를 "naverDraft"(임시저장)로 하고, 제목과 블로그를 알려 확인을 받은 뒤 발행한다.
사진은 네가 직접 보고 고른다 — senbi_brief 가 보여 주는 본문 사진 후보를 하나하나 보고, 배너·상호/전화번호 카드·로고·글자만 있는 이미지·제품과 상관없는 사진은 excludeImageUrls 로 뺀다.
이웃 관리(senbi_neighbor_posts → senbi_neighbor_engage, senbi_buddy_candidates → senbi_buddy_request)는 목록을 먼저 보여 주고 사용자가 고른 것에만, 한 건씩 한다. 댓글과 신청 문구는 그 글을 읽고 네가 직접 쓴다. 한꺼번에 여러 건을 몰아서 하지 않는다 — 짧은 간격의 대량 활동은 네이버 보호조치를 부른다.
senbi_delete_post 는 되돌릴 수 없다. 사용자가 그 글을 지우라고 분명히 말했을 때만 쓴다.
로그인이 풀려 있으면 senbi_login 으로 로그인 창을 띄운다. 아이디·비밀번호는 사용자가 그 창에 직접 입력한다(네가 대신 입력하지 않는다). 앱(senbiPOST)을 열 필요는 없다.`;

type Json = Record<string, unknown>;

function send(msg: Json): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handle(msg: Json): Promise<void> {
  const id = msg.id as string | number | undefined;
  const method = msg.method as string | undefined;
  if (!method) return; // 응답 메시지 — 우리가 보낸 요청이 없으니 무시
  const isRequest = id !== undefined && id !== null;
  const reply = (result: unknown) => isRequest && send({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) =>
    isRequest && send({ jsonrpc: "2.0", id, error: { code, message } });

  try {
    switch (method) {
      case "initialize": {
        const params = (msg.params ?? {}) as { protocolVersion?: string };
        reply({
          protocolVersion: params.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "senbi-auto", version: process.env.npm_package_version ?? "0" },
          instructions: INSTRUCTIONS,
        });
        return;
      }
      case "ping":
        reply({});
        return;
      case "tools/list":
        reply({ tools: TOOLS });
        return;
      case "tools/call": {
        const params = (msg.params ?? {}) as { name?: string; arguments?: Json };
        reply(await callTool(params.name ?? "", params.arguments ?? {}));
        return;
      }
      default:
        if (method.startsWith("notifications/")) return;
        fail(-32601, `지원하지 않는 메서드: ${method}`);
    }
  } catch (err) {
    fail(-32603, err instanceof Error ? err.message : String(err));
  }
}

ensureAppDirs();
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let msg: Json;
  try {
    msg = JSON.parse(text) as Json;
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 해석 실패" } });
    return;
  }
  pending++;
  void handle(msg).finally(() => {
    pending--;
    if (closing && pending === 0) process.exit(0);
  });
});
// 클라이언트가 연결을 끊어도 진행 중인 발행은 끝까지 간다 — 중간에 죽으면 글이 반쯤 입력된 채 남는다
let pending = 0;
let closing = false;
rl.on("close", () => {
  closing = true;
  if (pending === 0) process.exit(0);
});
