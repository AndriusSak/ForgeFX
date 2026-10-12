// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-2e-dump-perturbation — READ-ONLY. Does the oracle itself move the thing it is measuring?
//
// WHY (ROUND 15). An arm on the `fn=0x01 sub=0x2e` reply has to prove its restore through a DIFFERENT
// path, and the candidate is the EDIT-BUFFER BODY (`fn=0x77/0x78/0x79` → decodeRawPatch) — the only
// byte-stable oracle measured today. But the arm would then interleave body dumps BETWEEN its 0x2e stage
// captures, and a body dump is a big burst of device traffic: if the 0x2e reply's HEAD carries any state
// derived from recent traffic, the oracle perturbs the subject and the arm measures its own instrument.
// Measured today as the trigger for this script: two consecutive 0x2e reads taken right after two body
// dumps moved offsets **22, 23, 25 and 27**, while sixteen consecutive 0x2e reads in a session that had
// done no dumps moved only **22, 23 and 24**. Two different volatile FOOTPRINTS, with nothing written in
// either case — which is exactly what "some preceding traffic leaves the region looking different" looks
// like, and the whole reason the arm cannot be built on a guessed mask.
//
// WHAT THIS DOES — four groups of N long 0x2e reads inside ONE connection:
//   A   reads, nothing in between
//   A2  reads — the NO-INTERVENTION CONTROL: this pair is the drift the region shows by itself, so any
//       later "change" smaller than this is not attributable to an intervention
//   B   reads AFTER one edit-buffer body dump (the candidate ORACLE)
//   C   reads AFTER one fn-0x13 status dump (the landing check every other probe in this repo uses)
// For every data offset it reports the value SET in each group and classifies the offset:
//   STABLE everywhere      — one value in all four groups
//   VOLATILE (self)        — more than one value within a group that had no intervention
//   MOVED BY ORACLE        — constant across A and A2, different in B (attributable)
//   MOVED BY STATUS DUMP   — constant across A, A2, B, different in C (attributable)
//   NOT ATTRIBUTABLE       — volatile in more than one group; named, never called a change
//
// The verdict names the offsets each intervention moved, so the arm can either mask them, order its
// captures to avoid them, or — if the ORACLE moves the subject — say so and not run the arm at all.
//
// NOTHING IS WRITTEN. No cell, no switch, no store: dumps are reads.
//
// USAGE  npx tsx scripts/probe-2e-dump-perturbation.ts [--port /dev/ttyACM0] [--reads 4] [--outdir DIR]
// Exit: 0 measured · 2 a control failed · 3 no device.
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { subQuery } from './standing-read.js';
import { parsePresetDump, decodeRawPatch } from 'forgefx-midi/devices/gen3';

const MODEL = 0x11;
const EDIT_BUFFER = 0x3fff;
const CONTENT_BASE = 12;
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function main(argv: string[]): Promise<number> {
  const arg = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const reads = Math.max(2, Number(arg('--reads') ?? 4));
  const outdir = (arg('--outdir') ?? '/home/insn/repos/stack/review-2026-10-12').replace('~', process.env.HOME ?? '');
  if (arg('--tap')) process.env.FORGEFX_TAP = arg('--tap')!;

  const opened = await openProbeSession(MODEL, arg('--port'));
  if (!opened.ok) { console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`); return 3; }
  const { session } = opened;
  const problems: string[] = [];
  try {
    console.log(`══ probe-2e-dump-perturbation — READ-ONLY · ${reads} reads per group, one connection ══`);
    console.log(`tap: ${process.env.FORGEFX_TAP ?? '(none set)'}`);
    const neg = (await session.transport.request(subQuery(0x99, [0x00, 0x24, 0, 0, 0]), { timeoutMs: 900, quietMs: 60 }))
      .filter((f) => f[5] === 0x01 && f[6] === 0x99);
    console.log(`negative control sub 0x99 → ${neg.length ? 'ANSWERED (unexpected)' : 'SILENT'}`);
    if (neg.length) problems.push('negative control sub 0x99 answered');

    const group = async (label: string): Promise<number[][]> => {
      const out: number[][] = [];
      for (let i = 0; i < reads; i++) {
        const heard = await session.transport.request(subQuery(0x2e, [0, 0, 0, 0, 0]), { timeoutMs: 1200, quietMs: 80 });
        const f = heard.find((x) => x[5] === 0x01 && x[6] === 0x2e && x.length > 100);
        if (f) out.push(f.slice(CONTENT_BASE, f.length - 2));
        await sleep(45);
      }
      console.log(`  group ${label}: ${out.length}/${reads} long replies${out.length ? ` · ${out[0]!.length}B data` : ''}`);
      if (out.length < reads) problems.push(`group ${label} got ${out.length}/${reads} replies`);
      return out;
    };
    const bodyDump = async (): Promise<string> => {
      const frames = await session.transport.request(session.codec.buildRequestPresetDump(EDIT_BUFFER), {
        timeoutMs: 8000,
        quietMs: 300,
        match: (fs) => fs.some((f) => f[5] === 0x79)
      });
      if (!frames.some((f) => f[5] === 0x79)) { problems.push('edit-buffer dump incomplete'); return ''; }
      const parsed = parsePresetDump(Uint8Array.from(frames.flat()), 0, MODEL);
      const { body } = decodeRawPatch(parsed.chunkPayloads);
      return Buffer.from(body).toString('hex');
    };

    console.log('\nA  (nothing between reads)');
    const A = await group('A ');
    console.log('A2 (nothing between reads — the self-drift control)');
    const A2 = await group('A2');
    console.log('── one EDIT-BUFFER BODY DUMP (the candidate restore oracle) ──');
    const bh = await bodyDump();
    console.log(`   body ${bh.length / 2} B`);
    const B = await group('B ');
    // HOW LONG does the oracle's effect last? Two more groups with nothing in between, so the arm knows
    // whether it can wait the transient out instead of masking the offsets for the whole round.
    console.log('B2 (nothing between — does the oracle\'s effect persist?)');
    const B2 = await group('B2');
    console.log('B3 (nothing between)');
    const B3 = await group('B3');
    console.log('── one fn-0x13 STATUS DUMP (the landing-check path) ──');
    await session.transport.request(session.codec.buildStatusDump(), { timeoutMs: 1500, quietMs: 90 });
    const C = await group('C ');

    const set = (g: number[][], off: number): string => [...new Set(g.map((d) => d[off]!.toString(16).padStart(2, '0')))].sort().join(' ');
    const width = Math.min(...[...A, ...A2, ...B, ...C].map((d) => d.length));
    const cls: Record<string, number[]> = { 'stable everywhere': [], 'volatile (self)': [], 'MOVED BY ORACLE': [], 'MOVED BY STATUS DUMP': [], 'not attributable': [] };
    for (let off = 0; off < width; off++) {
      const sa = set(A, off), sa2 = set(A2, off), sb = set(B, off), sc = set(C, off);
      const nA = sa.split(' ').length, nA2 = sa2.split(' ').length, nB = sb.split(' ').length, nC = sc.split(' ').length;
      let k: string;
      if (nA === 1 && nA2 === 1 && nB === 1 && nC === 1) k = sa !== sb ? 'MOVED BY ORACLE' : sa !== sc ? 'MOVED BY STATUS DUMP' : 'stable everywhere';
      else if (nA === 1 && nA2 === 1 && nB > 1) k = 'MOVED BY ORACLE';
      else if (nA === 1 && nA2 === 1 && nB === 1 && nC > 1) k = 'MOVED BY STATUS DUMP';
      else if (nA2 > 1 && nA === 1) k = 'volatile (self)';
      else k = 'not attributable';
      cls[k]!.push(off);
    }
    for (const [k, offs] of Object.entries(cls)) {
      // a 576-long offset list is noise: name them when few, count them when many (the mask line names all)
      const shown = offs.length <= 24 ? offs.join(' ') : `${offs.slice(0, 8).join(' ')} … ${offs.slice(-4).join(' ')} (${offs.length})`;
      console.log(`\n${k}: ${offs.length}${offs.length ? ' → ' + shown : ''}`);
    }
    // per-offset detail for anything that is not "stable everywhere"
    console.log('\nper-offset value sets (only offsets that are NOT stable everywhere):');
    const interesting = [...cls['MOVED BY ORACLE']!, ...cls['MOVED BY STATUS DUMP']!, ...cls['volatile (self)']!, ...cls['not attributable']!].sort((a, b) => a - b);
    if (!interesting.length) console.log('  (none — every data offset read one value in all four groups; the reply is quiet at this cadence)');
    for (const off of interesting) {
      console.log(`  data ${String(off).padStart(3)}  A[${set(A, off)}]  A2[${set(A2, off)}]  B-after-dump[${set(B, off)}]  C-after-status[${set(C, off)}]  ${interesting.includes(off) && cls['MOVED BY ORACLE']!.includes(off) ? '← the ORACLE moved it' : cls['MOVED BY STATUS DUMP']!.includes(off) ? '← the STATUS DUMP moved it' : ''}`);
    }
    // the settle table for whatever the oracle touched
    if (cls['MOVED BY ORACLE']!.length) {
      console.log('\nSETTLE (does the oracle\'s effect clear on its own?) — group, value set per touched offset:');
      for (const off of cls['MOVED BY ORACLE']!) {
        const row = [['B ', B], ['B2', B2], ['B3', B3], ['C ', C]].map(([l, g]) => `${l}[${set(g as number[][], off)}]`).join('  ');
        console.log(`  data ${String(off).padStart(3)}  A[${set(A, off)}]  ${row}`);
      }
    }
    const oracleMoves = cls['MOVED BY ORACLE']!;
    const statusMoves = cls['MOVED BY STATUS DUMP']!;
    const mask = [...new Set([...cls['volatile (self)']!, ...cls['not attributable']!, ...oracleMoves, ...statusMoves])].sort((a, b) => a - b);
    const headRecs = [...new Set(mask.filter((o) => o < 352).map((o) => Math.floor(o / 8)))].sort((a, b) => a - b);
    console.log(`\nDERIVED MASK for a differ run after these interventions: --mask ${mask.join(',')}`);
    console.log(`  head records touched by that mask: ${headRecs.length ? headRecs.map((r) => '#' + r).join(' ') : 'none'}`);

    mkdirSync(outdir, { recursive: true });
    writeFileSync(join(outdir, 'dump-perturbation.json'), JSON.stringify({ reads, classification: cls, mask, oracleMoves, statusMoves }, null, 1) + '\n');
    console.log(`\nVERDICT: ${problems.length ? 'CONTROLS NOT GREEN' : oracleMoves.length
      ? `the ORACLE MOVES THE SUBJECT at offsets ${oracleMoves.join(', ')} — an arm cannot dump between stages without masking them`
      : statusMoves.length ? `the STATUS DUMP moves the subject at offsets ${statusMoves.join(', ')}`
      : 'no intervention-attributable change measured at this cadence (the reply varies only per-read, where it varies at all)'}`);
    for (const p of problems) console.log(`  • ${p}`);
    return problems.length === 0 ? 0 : 2;
  } finally {
    await sleep(50);
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
