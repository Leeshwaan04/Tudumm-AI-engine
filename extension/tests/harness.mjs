// Tiny shared test harness (no dependencies).
//
// `node extension/tests/*.test.mjs` hands Node every file, but Node only runs the
// first one and passes the rest as arguments. So whichever file runs first imports
// the others listed on the command line; each file can also run on its own.
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const S = (globalThis.__tudummTests ??= { pass: 0, fail: 0, main: null, seen: new Set(), section: null, sectionPass: 0, sectionFail: 0 });

export function section(name) {
  if (S.section) console.log(`  ${S.section}: ${S.sectionPass} passed, ${S.sectionFail} failed`);
  S.section = name;
  S.sectionPass = 0;
  S.sectionFail = 0;
}

export function check(name, cond, detail = "") {
  if (cond) {
    S.pass++;
    S.sectionPass++;
  } else {
    S.fail++;
    S.sectionFail++;
    console.error(`FAIL  [${S.section || "?"}] ${name}${detail ? `  (${detail})` : ""}`);
  }
}

export async function rejects(name, fn) {
  try {
    await fn();
    check(name, false, "did not throw");
  } catch {
    check(name, true);
  }
}

/** Call at the end of every test file. */
export async function done(url) {
  const self = fileURLToPath(url);
  S.seen.add(self);
  if (S.section) console.log(`  ${S.section}: ${S.sectionPass} passed, ${S.sectionFail} failed`);
  S.section = null;
  if (S.main) return;
  S.main = self;
  for (const arg of process.argv.slice(2)) {
    const p = resolve(arg);
    if (!/\.test\.mjs$/.test(p) || S.seen.has(p)) continue;
    S.seen.add(p);
    await import(pathToFileURL(p).href);
  }
  console.log(`${S.pass} passed, ${S.fail} failed`);
  process.exitCode = S.fail ? 1 : 0;
}
