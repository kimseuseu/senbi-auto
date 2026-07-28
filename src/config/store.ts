import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDir } from "./paths";

/**
 * 아주 단순한 파일 기반 JSON 저장소.
 * - 네이티브 모듈(better-sqlite3 등) 없이 맥/윈도우에서 동일 동작.
 * - 원자적 쓰기(temp 파일 → rename)로 손상 방지.
 * - 단일 사용자·저빈도 쓰기를 전제로 한다.
 */
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
    fs.renameSync(tmp, this.file);
    this.cache = data;
  }

  update(mutate: (draft: T) => T | void): T {
    const current = structuredClone(this.read());
    const next = mutate(current);
    const resolved = (next ?? current) as T;
    this.write(resolved);
    return resolved;
  }
}
