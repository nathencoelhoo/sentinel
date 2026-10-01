import { inflateRawSync } from 'node:zlib';

/**
 * Minimal zip reader (no dependencies, no `unzip` binary needed): returns the first entry.
 * Reads the central directory, so it also works for zips written with data descriptors.
 * Supports stored (0) and deflate (8). ZIP64 is not supported (daily kline files are small).
 */
export function extractFirstEntry(buf: Buffer): Buffer {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip: end of central directory not found');
  const entries = buf.readUInt16LE(eocd + 10);
  if (entries < 1) throw new Error('zip: empty archive');
  const cd = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error('zip: bad central directory');
  const method = buf.readUInt16LE(cd + 10);
  const compSize = buf.readUInt32LE(cd + 20);
  const localOff = buf.readUInt32LE(cd + 42);
  if (compSize === 0xffffffff || localOff === 0xffffffff) throw new Error('zip: ZIP64 not supported');
  if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('zip: bad local header');
  const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
  const data = buf.subarray(start, start + compSize);
  if (method === 0) return Buffer.from(data);
  if (method === 8) return inflateRawSync(data);
  throw new Error(`zip: unsupported compression method ${method}`);
}
