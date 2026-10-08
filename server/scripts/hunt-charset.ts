// hunt-charset — the same idea as hunt-cab-name, for the encodings a DEVICE might use instead of ASCII:
// charset indices (A=1 / A=0), a 0x80-flagged variant, and 16-bit characters. Report hits, never guesses.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readChunks, framesOf } from './scan-usb-capture.js';

const hex = (a: readonly number[]) => a.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const findAt = (hay: readonly number[], needle: readonly number[]) => {
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
};

export function main(argv: string[]): number {
  const path = argv.find((a) => !a.startsWith('--'));
  const needleText = (argv.filter((a) => !a.startsWith('--'))[1] ?? 'NAMETEST').toUpperCase();
  if (!path) { console.log('usage: npx tsx scripts/hunt-charset.ts <capture.pcapng> [TEXT]'); return 2; }
  const { chunks } = readChunks(readFileSync(path));
  const { frames } = framesOf(chunks);
  const chars = [...needleText];
  const variants: [string, number[]][] = [
    ['ASCII', chars.map((c) => c.charCodeAt(0))],
    ['A=1 (space=0)', chars.map((c) => (c === ' ' ? 0 : c.charCodeAt(0) - 0x40))],
    ['A=0 (space=0x1a)', chars.map((c) => (c === ' ' ? 0x1a : c.charCodeAt(0) - 0x41))],
    ['A=1 + 0x80 flag (bit7 set on each char)', chars.map((c) => 0x80 | (c === ' ' ? 0 : c.charCodeAt(0) - 0x40))],
    ['ASCII with high bit set', chars.map((c) => 0x80 | c.charCodeAt(0))],
    ['ASCII as 16-bit LE', chars.flatMap((c) => [c.charCodeAt(0), 0])],
    ['ASCII as 16-bit BE', chars.flatMap((c) => [0, c.charCodeAt(0)])],
    ['5-septet packing, 4 chars per 5 bytes', (() => {
      const out: number[] = [];
      for (let i = 0; i < chars.length; i += 4) {
        const grp = chars.slice(i, i + 4).map((c) => c.charCodeAt(0));
        let w = 0;
        for (let k = 0; k < 4; k++) w |= (grp[k] ?? 0x20) << (8 * k);
        for (let k = 0; k < 5; k++) out.push((w >> (7 * k)) & 0x7f);
      }
      return out;
    })()]
  ];
  console.log(`${path}: ${frames.length} frames · hunting "${needleText}" as ${variants.length} encodings`);
  let any = false;
  for (const [label, needle] of variants) {
    const hits: { fn: number; sub: number; ep: number; at: number; len: number; bytes: number[] }[] = [];
    for (const f of frames) { const at = findAt(f.bytes, needle); if (at >= 0) hits.push({ fn: f.fn, sub: f.bytes[6] ?? 0, ep: f.ep, at, len: f.bytes.length, bytes: f.bytes }); }
    if (hits.length) any = true;
    console.log(`${hits.length ? 'FOUND ' : '  --  '}${label} (${needle.length} B): ${hits.length} frame(s)`);
    for (const h of hits.slice(0, 4)) console.log(`        fn=0x${h.fn.toString(16)} sub=0x${h.sub.toString(16)} ep=${h.ep} at ${h.at}: ${hex(h.bytes.slice(Math.max(0, h.at - 4), h.at + needle.length + 6))}`);
  }
  if (!any) console.log('\nNOT PRESENT IN ANY OF THESE ENCODINGS.');
  return any ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
