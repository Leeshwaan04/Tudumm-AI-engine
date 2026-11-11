// Lets Node (type stripping) load the Worker's extensionless TS imports (`./engine/types` -> `./engine/types.ts`).
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const rel = specifier.startsWith("./") || specifier.startsWith("../");
    if (rel && !/\.(c|m)?(j|t)s$|\.json$/.test(specifier) && context.parentURL?.endsWith(".ts")) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        /* fall through */
      }
    }
    return nextResolve(specifier, context);
  },
});
