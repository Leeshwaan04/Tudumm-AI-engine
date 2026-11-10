// Generates the landing hero texture: a faint topographic "market terrain" contour
// field plus fine film grain, in --line tones on --bg ink. Pure Node (zlib PNG writer),
// then converted to WebP with `cwebp` if available.
// Usage: node scripts/gen-hero-texture.mjs  -> web/public/assets/hero-terrain.webp
import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";

const W = 1800, H = 1100;
const OUT_DIR = new URL("../web/public/assets/", import.meta.url);
mkdirSync(OUT_DIR, { recursive: true });

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261110);
const G = 64;
const grid = new Float32Array((G + 1) * (G + 1)).map(() => rnd());
const sm = (t) => t * t * (3 - 2 * t);
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const ix = ((xi % G) + G) % G, iy = ((yi % G) + G) % G;
  const at = (a, b) => grid[(b % G) * (G + 1) + (a % G)];
  const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
  const u = sm(xf), v = sm(yf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function field(x, y) {
  const nx = x / W, ny = y / H;
  let f = 0, amp = 1, freq = 3.2, norm = 0;
  for (let o = 0; o < 4; o++) {
    f += amp * vnoise(nx * freq * 1.6 + o * 17.3, ny * freq + o * 9.1);
    norm += amp; amp *= 0.5; freq *= 2.03;
  }
  f /= norm;
  // a rising ridge toward the upper right: the market "terrain" climbs
  f += 0.55 * nx - 0.35 * ny;
  return f;
}
const N = 26; // contour density
const F = new Float32Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) F[y * W + x] = field(x, y) * N;

const bg = [10, 11, 13];      // --bg
const line = [35, 40, 51];    // --line
const strong = [50, 57, 70];  // --line-strong
const raw = Buffer.alloc((W * 3 + 1) * H);
const grain = mulberry32(7);
for (let y = 0; y < H; y++) {
  raw[y * (W * 3 + 1)] = 0;
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const v = F[i];
    const dx = x < W - 1 ? F[i + 1] - v : v - F[i - 1];
    const dy = y < H - 1 ? F[i + W] - v : v - F[i - W];
    const fw = Math.abs(dx) + Math.abs(dy) + 1e-4;
    const fr = v - Math.floor(v);
    const dist = Math.min(fr, 1 - fr) / fw;
    let a = Math.max(0, 1 - dist / 0.9);
    const idx = Math.floor(v + 0.5);
    const isIndex = ((idx % 5) + 5) % 5 === 0;
    const col = isIndex ? strong : line;
    // vignette: fade contours toward the left/bottom where copy sits
    const nx = x / W, ny = y / H;
    const vig = Math.min(1, Math.max(0, (nx - 0.08) * 1.4)) * Math.min(1, Math.max(0, 1.15 - ny));
    a *= (isIndex ? 0.95 : 0.6) * vig;
    const g = (grain() - 0.5) * 5;
    const o = y * (W * 3 + 1) + 1 + x * 3;
    for (let c = 0; c < 3; c++) {
      const val = bg[c] + (col[c] - bg[c]) * a + g;
      raw[o + c] = Math.max(0, Math.min(255, Math.round(val)));
    }
  }
}
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
]);
const pngPath = new URL("hero-terrain.png", OUT_DIR);
writeFileSync(pngPath, png);
try {
  execFileSync("cwebp", ["-quiet", "-q", "72", pngPath.pathname, "-o", new URL("hero-terrain.webp", OUT_DIR).pathname]);
  unlinkSync(pngPath);
  console.log("wrote web/public/assets/hero-terrain.webp");
} catch {
  console.log("cwebp not found; wrote web/public/assets/hero-terrain.png");
}
