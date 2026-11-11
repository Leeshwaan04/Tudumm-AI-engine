// Tudumm ingest runner entry. Usage: node --experimental-strip-types runner/ingest.ts <job> [flags]
// See worker/README-market.md (Runner).
import "./lib/register.ts";

const { main } = await import("./main.ts");
try {
  const code = await main(process.argv.slice(2));
  process.exit(code);
} catch (e) {
  console.error(`✖ runner failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
}
