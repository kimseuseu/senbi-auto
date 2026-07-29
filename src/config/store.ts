import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDir } from "./paths";

/**
 * 아주 단순한 파일 기반 JSON 저장소.
 * - 네이티브 모듈(better-sqlite3 등) 없이 맥/윈도우에서 동일 동작.
 * - 원자적 쓰기(temp 파일 → rename)로 손상 방지.
 * - 단일 사용자·저빈도 쓰기를 전제로 한다.
 */
/** 아주 짧은 동기 대기 (재시도 간격용) */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class JsonStore<T> {
  private readonly file: string;
  private cache: T | null = null;

  constructor(
    name: string,
    private readonly fallback: T,
  ) {
    this.file = path.join(DATA_DIR, `${name}.json`);
  }

  read(): T {
    if (this.cache !== null) return this.cache;
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      this.cache = JSON.parse(raw) as T;
    } catch {
      this.cache = structuredClone(this.fallback);
    }
    return this.cache;
  }

  write(data: T): void {
    ensureDir(DATA_DIR);
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    // 윈도우에선 백신·검색 인덱서가 파일을 잠깐 잡고 있어 rename 이 EPERM/EBUSY 로 튈 수 있다.
    // 짧게 재시도하면 대부분 통과한다.
    let lastErr: unknown = null;
    for (let i = 0; i < 5; i++) {
      try {
        fs.renameSync(tmp, this.file);
        this.cache = data;
        return;
      } catch (err) {
        lastErr = err;
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") break;
        sleepSync(40 * (i + 1));
      }
    }
    // 마지막 수단 — 임시 파일을 지우고 직접 덮어쓴다 (원자성은 포기하되 데이터는 지킨다)
    try {
      fs.writeFileSync(this.file, JSON.stringify(data, null, 2), "utf8");
      this.cache = data;
      fs.rmSync(tmp, { force: true });
      return;
    } catch {
      fs.rmSync(tmp, { force: true });
      throw lastErr;
    }
  }

  update(mutate: (draft: T) => T | void): T {
    const current = structuredClone(this.read());
    const next = mutate(current);
    const resolved = (next ?? current) as T;
    this.write(resolved);
    return resolved;
  }
}
