// Tudumm live feed entry: India realtime via 5paisa + crypto from this machine -> the Worker.
// Usage: npm run live [-- --once | --dry-run | --no-india | --no-crypto]   (config: runner/live.env)
import "./lib/register.ts";

const { main } = await import("./live/main.ts");
try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  console.error(`✖ live feed failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
