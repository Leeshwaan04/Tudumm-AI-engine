// Tudumm engine v0 walk-forward backtest on the cached NSE EOD archive (offline; no network, no D1).
// Usage:
//   node --experimental-strip-types --disable-warning=ExperimentalWarning runner/backtest.ts [--trades] [--out FILE.json]
//        [--slip PCT_PER_SIDE (stocks, default 0.05)] [--idx-cost PCT_PER_SIDE (indices, default 0.05)]
//        [--seed N] [--boot N] [--run-utc HH:MM (default 14:00)] [--cache DIR (default runner/.cache/nse)]
// Replays every cached session through the production runCycle (see runner/jobs/backtest.ts for the method).
import "./lib/register.ts";

const { backtestMain } = await import("./jobs/backtest.ts");
try {
  process.exit(await backtestMain(process.argv.slice(2)));
} catch (e) {
  console.error(`✖ backtest failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
}
