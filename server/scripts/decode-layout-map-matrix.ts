// ────────────────────────────────────────────────────────────────────────────────────────────────
// decode-layout-map-matrix — test the ONE structural hypothesis that would crack the 576-byte
// `fn=0x01 sub=0x2e` data region, and test it OFFLINE against every alignment rather than by eye.
//
// THE HYPOTHESIS. 220 of the 576 bytes hold a single bit (`0x40/0x20/0x10/0x08/0x04/0x02/0x01`), and
// they come in runs of the LADDER `40 20 10 08 04 02 01`. A column-major bit matrix — one bit per byte,
// value = 1<<bit — produces EXACTLY that shape: a "column" whose every bit is set reads as the ladder.
// So: is the region a W-row matrix stored column-major, from some start offset?
//
// THE TEST, and why it is falsifiable. Under that reading every byte inside a column is either 0x00 or a
// DISTINCT power of two, and no bit may appear twice in one column. Two violation counters are scored over
// every (start, width) pair:
//     multibit  — a byte with more than one bit set
//     dupbit    — the same bit value twice in one column
// A true matrix alignment drives both to ~0. A wrong one does not. Neither is adjusted by hand: the grid
// is enumerated, not chosen. The header region is expected to violate (it holds plain 7-bit values like
// `0x70 0x03 0x4d`), which is exactly why the scan is over the START OFFSET too.
//
// It also reports the RUN-LENGTH DISTRIBUTION of consecutive single-bit bytes, because the hand-off's
// stated prediction for this round was "a family's bit-run length equals its param count". If no run is
// longer than 7, that prediction is refuted by measurement — and a refuted prediction is a result.
//
// USAGE  npx tsx scripts/decode-layout-map-matrix.ts <tap.log> [--frame 0]
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseTap } from './inspect-tap.js';

const SINGLE_BITS = [0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01];
const isSingleBit = (b: number) => SINGLE_BITS.includes(b);
const popcount = (b: number) => b.toString(2).split('').filter((x) => x === '1').length;

export function main(argv: string[]): number {
  const path = argv.find((a) => !a.startsWith('--'));
  if (!path) { console.log('usage: npx tsx scripts/decode-layout-map-matrix.ts <tap.log> [--frame 0]'); return 2; }
  const arg = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const which = Number(arg('--frame') ?? 0);

  const frames = parseTap(readFileSync(path, 'utf8')).filter((f) => f.dir === 'RX' && f.bytes[5] === 0x01 && f.bytes[6] === 0x2e && f.bytes.length > 100);
  if (!frames.length) { console.log(`${path}: no long sub=0x2e reply in this tap`); return 1; }
  const f = frames[Math.min(which, frames.length - 1)]!;
  const data = f.bytes.slice(12, -2);
  console.log(`${path} · reply [${which}] · data region ${data.length}B`);

  // ── run-length distribution of consecutive single-bit bytes ────────────────────────────────────
  const runs: number[] = [];
  let cur = 0;
  for (const b of data) {
    if (isSingleBit(b)) cur++;
    else { if (cur) runs.push(cur); cur = 0; }
  }
  if (cur) runs.push(cur);
  const rl = new Map<number, number>();
  for (const r of runs) rl.set(r, (rl.get(r) ?? 0) + 1);
  console.log(`\nsingle-bit runs (maximal consecutive single-bit bytes): ${runs.length}`);
  console.log(`  length → count: ${[...rl].sort((a, b) => a[0] - b[0]).map(([len, n]) => `${len}→${n}`).join(' ')}`);
  console.log(`  longest run: ${Math.max(...runs)}   (the hand-off's prediction "a family's bit-run length = its param count"`);
  console.log(`  needs a run per family; the smallest family has far more than ${Math.max(...runs)} params — see the verdict below)`);
  console.log(`  multi-bit bytes in the region: ${data.filter((b) => b !== 0 && !isSingleBit(b)).length}`);

  // ── periodicity: find the RECORD STRIDE from the data instead of guessing it ────────────────────
  //
  // A table of fixed-size records is periodic at its record size. Two independent signals are scored,
  // both alignment-free (they compare data[o] with data[o+lag] over every o):
  //   nz    — "byte is non-zero" agrees
  //   exact — the byte VALUES are equal (the trio is excluded: it is volatile by measurement)
  // A lag that beats the field on BOTH is the stride. Nothing is chosen by hand.
  const VOL = new Set([22, 23, 24]);
  const ac: Array<{ lag: number; nz: number; exact: number }> = [];
  for (let lag = 1; lag <= 128; lag++) {
    let nzHit = 0, exactHit = 0, n = 0;
    for (let o = 0; o + lag < data.length; o++) {
      if (VOL.has(o) || VOL.has(o + lag)) continue;
      n++;
      if ((data[o] !== 0) === (data[o + lag] !== 0)) nzHit++;
      if (data[o] === data[o + lag]) exactHit++;
    }
    ac.push({ lag, nz: nzHit / n, exact: exactHit / n });
  }
  const base = ac.reduce((s, a) => s + a.exact, 0) / ac.length;
  console.log(`\nperiodicity over ${data.length}B (exact-match baseline across all lags: ${(base * 100).toFixed(1)}%)`);
  console.log('  top lags by EXACT byte agreement:');
  for (const a of [...ac].sort((x, y) => y.exact - x.exact).slice(0, 8)) {
    console.log(`    lag ${String(a.lag).padStart(3)}: exact ${(a.exact * 100).toFixed(1)}%  non-zero-agreement ${(a.nz * 100).toFixed(1)}%${a.exact > base + 0.15 ? '   ← above the field' : ''}`);
  }

  if (arg('--rows')) {
    const w = Number(arg('--rows'));
    console.log(`\nrows of ${w} from offset 0 (the region's strongest period is lag 8):`);
    for (let o = 0; o < data.length; o += w) {
      const row = data.slice(o, o + w);
      console.log(`  +${String(o).padStart(3)}  ${row.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
    }
    return 0;
  }

  // ── enumerate (start, width) and score the matrix reading ──────────────────────────────────────
  interface Score { start: number; width: number; cols: number; multibit: number; dupbit: number; full: number; empty: number }
  const scores: Score[] = [];
  for (let start = 0; start <= 72; start++) {
    for (let width = 4; width <= 10; width++) {
      const avail = data.length - start;
      const cols = Math.floor(avail / width);
      if (cols < 8) continue;
      let multibit = 0, dupbit = 0, full = 0, empty = 0;
      for (let c = 0; c < cols; c++) {
        const col = data.slice(start + c * width, start + c * width + width);
        const seen = new Set<number>();
        let bad = false;
        for (const b of col) {
          if (b === 0) continue;
          if (!isSingleBit(b)) { multibit++; bad = true; continue; }
          if (seen.has(b)) { dupbit++; bad = true; continue; }
          seen.add(b);
        }
        if (!bad) { if (seen.size === 7) full++; else if (seen.size === 0) empty++; }
      }
      scores.push({ start, width, cols, multibit, dupbit, full, empty });
    }
  }
  scores.sort((a, b) => (a.multibit + a.dupbit) - (b.multibit + b.dupbit) || b.full - a.full);
  console.log('\ncolumn-major one-bit-per-byte matrix — best (start, width) by violation count:');
  console.log('  start  width  cols  multibit  dupbit  full-ladders  empty-cols');
  for (const s of scores.slice(0, 10)) {
    console.log(`  ${String(s.start).padStart(5)}  ${String(s.width).padStart(5)}  ${String(s.cols).padStart(4)}  ${String(s.multibit).padStart(8)}  ${String(s.dupbit).padStart(6)}  ${String(s.full).padStart(12)}  ${String(s.empty).padStart(10)}`);
  }
  const best = scores[0]!;
  const totalViol = best.multibit + best.dupbit;
  console.log(`\nbest: start ${best.start}, width ${best.width} → ${best.cols} columns, ${totalViol} violation(s), ${best.full} full ladders`);
  console.log(totalViol === 0
    ? '  ⇒ a column-major bit matrix fits this alignment EXACTLY. The matrix reading stands and the next step is to name the rows.'
    : '  ⇒ NO alignment is violation-free: the plain column-major one-bit-per-byte matrix does NOT fit the whole region.');
  console.log('\nEither way this decides that alignment only. Nothing here names a row, a column or a meaning.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
