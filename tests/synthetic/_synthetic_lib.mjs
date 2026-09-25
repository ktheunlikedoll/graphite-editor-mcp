/**
 * Shared helpers for the synthetic fake graphene-cli fixtures (tests/synthetic).
 *
 * Deliberately dependency-light: Node builtins only. The minimal PNG encoder
 * here exists so fakes can write REAL, validator-passing artifacts without
 * external image libraries.
 */
import { deflateSync } from 'node:zlib';

/** Standard CRC-32 (the polynomial used by PNG chunks). */
export function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

/** A real, minimal 1x1 red RGB PNG (signature + IHDR + IDAT + IEND, correct CRCs). */
export function buildMinimalPng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive
  ihdr[12] = 0; // interlace: none
  const rawScanline = Buffer.from([0x00, 0xff, 0x00, 0x00]); // filter 0 + R,G,B
  const idat = deflateSync(rawScanline);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Extracts the value of --output/-o from an export-style argv, so the fakes
 * accept the same argument shape as graphene-cli export.
 */
export function getOutputPath(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--output' || arg === '-o') return argv[i + 1];
    if (arg.startsWith('--output=')) return arg.slice('--output='.length);
    if (arg.startsWith('-o=')) return arg.slice(3);
  }
  return undefined;
}

/**
 * Dies by SIGSEGV — reproducing the measured graphene-cli ground truth.
 * Falls back to exit(139) in case the signal is somehow suppressed, which the
 * runner classifies identically (SIGSEGV / exit 139).
 */
export function dieBySegfault() {
  process.kill(process.pid, 'SIGSEGV');
  setTimeout(() => process.exit(139), 500).unref();
}