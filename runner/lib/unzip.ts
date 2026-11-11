// Minimal ZIP reader (central directory + deflate/stored) for NSE bhavcopy archives.
import { inflateRawSync } from "node:zlib";

export function unzipFirst(buf: Buffer, want: (name: string) => boolean = () => true): { name: string; data: Buffer } | null {
  // find End Of Central Directory (signature 0x06054b50) within the last 64 KB
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip: no end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip: bad central directory");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (!want(name)) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error("zip: bad local header");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    if (method === 0) return { name, data: Buffer.from(raw) };
    if (method === 8) return { name, data: inflateRawSync(raw) };
    throw new Error(`zip: unsupported method ${method}`);
  }
  return null;
}
