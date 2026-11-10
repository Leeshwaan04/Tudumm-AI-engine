import { defineConfig, type Plugin, type Connect } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const EXT_DIR = resolve(HERE, "../extension");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Serves the sibling Chrome extension folder (read-only) at /extension/ so the landing
 * page can link to its preview.html, and exposes /__tudumm/ext-status so the page only
 * shows that link when the preview actually exists.
 */
function extensionPreview(): Plugin {
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    const url = (req.url ?? "").split("?")[0];
    if (url === "/__tudumm/ext-status") {
      const preview = existsSync(resolve(EXT_DIR, "preview.html"));
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify({ preview, path: "/extension/preview.html" }));
      return;
    }
    if (url.startsWith("/extension/")) {
      let rel = decodeURIComponent(url.slice("/extension/".length));
      if (rel === "" || rel.endsWith("/")) rel += "index.html";
      const file = resolve(EXT_DIR, rel);
      if ((file === EXT_DIR || file.startsWith(EXT_DIR + sep)) && existsSync(file) && statSync(file).isFile()) {
        res.setHeader("content-type", MIME[extname(file)] ?? "application/octet-stream");
        res.setHeader("cache-control", "no-store");
        res.end(readFileSync(file));
        return;
      }
    }
    next();
  };
  return {
    name: "tudumm-extension-preview",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  plugins: [react(), extensionPreview()],
  server: { port: 5180, strictPort: true },
  preview: { port: 5180, strictPort: true },
  build: { chunkSizeWarningLimit: 900 },
});
