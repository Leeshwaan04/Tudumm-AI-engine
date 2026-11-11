// In-memory MarketDb on node:sqlite, created from the real D1 schema (worker/migrations/0002_market.sql),
// so offline tools (the backtest) can drive the production market/service.ts runCycle unchanged.
// write() is one transaction, like a D1 batch: all statements apply or none do.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MarketDb, Row, SqlStmt } from "../../worker/src/market/store.ts";
import { ROOT } from "./sink.ts";

export class MemDb implements MarketDb {
  readonly db: DatabaseSync;
  reads = 0;
  writes = 0;

  constructor(migrations: string[] = ["0002_market.sql", "0004_lifecycle_forming.sql"]) {
    this.db = new DatabaseSync(":memory:");
    for (const m of migrations) this.db.exec(readFileSync(join(ROOT, "worker", "migrations", m), "utf8"));
  }

  async read(stmts: SqlStmt[]): Promise<Row[][]> {
    this.reads += stmts.length;
    return stmts.map((s) => this.db.prepare(s.sql).all(...s.params) as Row[]);
  }

  async write(stmts: SqlStmt[]): Promise<void> {
    if (!stmts.length) return;
    this.writes += stmts.length;
    this.db.exec("BEGIN");
    try {
      for (const s of stmts) this.db.prepare(s.sql).run(...s.params);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
