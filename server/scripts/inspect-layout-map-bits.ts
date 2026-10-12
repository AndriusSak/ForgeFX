// ────────────────────────────────────────────────────────────────────────────────────────────────
// inspect-layout-map-bits — the BIT STRUCTURE of the `fn=0x01 sub=0x2e` data region (576 bytes), read
// from a tap. `inspect-layout-map.ts` answers "what shape is this" (zero fraction, single-bit bytes, the
// repeated run, the geometry check). This one answers "where are the non-zero bytes and how do they
// cluster", which is the question the bit-packed hypothesis needs answered first.
//
// It interprets nothing. It reports:
//   • the non-zero bytes as (offset, value, bits-set) rows;
//   • the CLUSTERS: maximal spans where non-zero bytes are within `--gap` (default 2) of each other —
//     a bit-packed family table would show one cluster per family, a table-of-records would not;
//   • per-cluster: length, the distinct values used, and the count of single-bit bytes in it;
//   • the global value histogram, so "one bit per byte" vs "7-bit values" is a fact and not a guess.
//
// USAGE  npx tsx scripts/inspect-layout-map-bits.ts <tap.log> [--gap 2] [--frame 0]
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseTap } from './inspect-tap.js';

const hex2 = (b: number) => b.toString(16).padStart(2, '0');
const bitsOf = (b: number) => b.toString(2).padStart(8, '0');
const SINGLE_BITS = [0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01];

export function main(argv: string[]): number {
  const path = argv.find((a) => !a.startsWith('--'));
  if (!path) { console.log('usage: npx tsx scripts/inspect-layout-map-bits.ts <tap.log> [--gap 2] [--frame 0]'); return 2; }
  const arg = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const gap = Number(arg('--gap') ?? 2);
  const which = Number(arg('--frame') ?? 0);

  const frames = parseTap(readFileSync(path, 'utf8')).filter((f) => f.dir === 'RX' && f.bytes[5] === 0x01 && f.bytes[6] === 0x2e && f.bytes.length > 100);
  if (!frames.length) { console.log(`${path}: no long sub=0x2e reply in this tap`); return 1; }
  const f = frames[Math.min(which, frames.length - 1)]!;
  const data = f.bytes.slice(12, -2);
  console.log(`${path} · reply [${which}] of ${frames.length} · frame ${f.bytes.length}B · data region ${data.length}B`);

  const nz: number[] = [];
  for (let o = 0; o < data.length; o++) if (data[o] !== 0) nz.push(o);
  console.log(`\nnon-zero bytes: ${nz.length}/${data.length}  (zero: ${data.length - nz.length})`);

  // Clusters: maximal spans of non-zero bytes within `gap` of each other.
  const clusters: Array<{ from: number; to: number; idx: number[] }> = [];
  for (const o of nz) {
    const last = clusters[clusters.length - 1];
    if (last && o - last.to <= gap) { last.to = o; last.idx.push(o); }
    else clusters.push({ from: o, to: o, idx: [o] });
  }
  console.log(`\nclusters (non-zero bytes within ${gap} of each other): ${clusters.length}`);
  console.log('  #    span           len  bytes(off:val)                                   single-bit');
  clusters.forEach((c, i) => {
    const vals = c.idx.map((o) => data[o]!);
    const singles = vals.filter((v) => SINGLE_BITS.includes(v)).length;
    const body = c.idx.map((o) => `${o}:${hex2(data[o]!)}`).join(' ');
    console.log(`  ${String(i).padStart(3)}  ${String(c.from).padStart(4)}..${String(c.to).padEnd(4)}  ${String(c.idx.length).padStart(3)}  ${body.slice(0, 60).padEnd(60)}  ${singles}/${c.idx.length}`);
    if (body.length > 60) console.log(`       ${body.slice(60)}`);
  });

  // Global value histogram: "one bit per byte" is a claim about VALUES, so it is measured.
  const hist = new Map<number, number>();
  for (const b of data) hist.set(b, (hist.get(b) ?? 0) + 1);
  const singlesTotal = SINGLE_BITS.reduce((n, v) => n + (hist.get(v) ?? 0), 0);
  console.log(`\nvalue histogram (top 12): ${[...hist].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([v, n]) => `0x${hex2(v)}=${n}`).join(' ')}`);
  console.log(`single-bit values: ${singlesTotal}/${data.length} · bytes with >1 bit set: ${data.length - (hist.get(0) ?? 0) - singlesTotal}`);
  console.log(`bytes >= 0x80 (illegal in SysEx data): ${data.filter((b) => b >= 0x80).length}`);

  // The first 96 bytes, offset-labelled with bits, because the header region is where a "count" field would live.
  console.log('\nfirst 96 bytes, offset : value : bits : popcount');
  for (let o = 0; o < 96 && o < data.length; o++) {
    if (data[o] === 0) continue;
    const pc = bitsOf(data[o]!).split('').filter((x) => x === '1').length;
    console.log(`  +${String(o).padStart(3)}  ${hex2(data[o]!)}  ${bitsOf(data[o]!)}  ${pc}`);
  }
  console.log('\nNOTHING HERE IS DECODED. Positions and values only.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
