// Recomputes the ledger hash chain in Node with the exact algorithm the browser uses.
// Usage: node scripts/verify-ledger.mjs [path/to/seed.json]
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const path = process.argv[2] ?? new URL("../shared/seed.json", import.meta.url);
const seed = JSON.parse(readFileSync(path, "utf8"));
let prev = seed.meta.ledgerGenesisPrevHash;
let ok = 0;
for (const e of seed.ledger) {
  const canon = JSON.stringify([prev, e.id, e.issuedAt, e.symbol, e.direction, e.entry, e.stop, e.target, e.exit, e.closedAt, e.r]);
  const h = createHash("sha256").update(canon, "utf8").digest("hex");
  if (e.prevHash !== prev || h !== e.hash) {
    console.error(`BROKEN at ${e.id}`);
    process.exit(1);
  }
  prev = h;
  ok++;
}
console.log(`Chain intact: ${ok}/${seed.ledger.length} entries`);
