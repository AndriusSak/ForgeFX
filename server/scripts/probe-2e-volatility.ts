// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-2e-volatility — READ-ONLY. DERIVE the `fn=0x01 sub=0x2e` reply's volatile offset set instead of
// carrying the guessed trio.
//
// WHY (ROUND 15). Every arm built on this reply compares two or three captures of it, so any offset that
// moves on its own reads as a change the arm *caused*. ROUND 13 measured a per-READ trio at data
// 22/23/24 and every differ since has been run with `--mask 22,23,24`. Measured today, on two consecutive
// reads with NOTHING written between, the set of offsets that actually moved was **22, 23, 25 and 27** —
// 24 did not move, 25 and 27 did. A mask that names three bytes while four move is a false-positive
// generator: data 25 and 27 sit INSIDE head record #3 (data 24..31), so a naive diff would report
// "head record #3 changed" on a run that changed nothing.
//
// WHAT THIS DOES: N reads of the same long reply, in ONE connection, with no write anywhere, then per data
// offset it collects the SET of observed values. An offset whose set has more than one member is VOLATILE
// and is named with every value seen and how often; an offset whose set has one member is stable over
// these N reads. It then prints, derived from its own measurement:
//   • the volatile set, as the exact `--mask` argument diff-2e-head-vs-grid.ts wants;
//   • which 8-byte HEAD records contain a volatile offset — i.e. which records a naive diff could blame;
//   • whether any volatile offset falls in the TAIL grid region (it must not: if one did, the TAIL grid
//     comparison would be unreliable too, and that is a result worth knowing before an arm runs).
//
// THE LIMIT, STATED: N reads bound this from ABOVE (a byte that stayed put in N reads may still drift
// rarely). The set is therefore a MEASURED MINIMUM at this cadence, not a proof of constancy — and the
// arm's own before-stage check must happen in the same connection, immediately before it writes.
//
// USAGE  npx tsx scripts/probe-2e-volatility.ts [--port /dev/ttyACM0] [--reads 12] [--outdir DIR]
// Exit: 0 read · 2 a control failed (the reply's own address/length must be constant, and neg 0x99 silent) · 3 no device.
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { subQuery } from './standing-read.js';

const MODEL = 0x11;
const CONTENT_BASE = 12;
const HEAD_LEN_DATA = 44 * 8; // 44 full 8-byte head records (derived in diff-2e-head-vs-grid; reported, not asserted)
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function main(argv: string[]): Promise<number> {
  const arg = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const reads = Math.max(2, Number(arg('--reads') ?? 12));
  const outdir = (arg('--outdir') ?? '/home/insn/repos/stack/review-2026-10-12').replace('~', process.env.HOME ?? '');
  if (arg('--tap')) process.env.FORGEFX_TAP = arg('--tap')!;

  const opened = await openProbeSession(MODEL, arg('--port'));
  if (!opened.ok) { console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`); return 3; }
  const { session } = opened;
  const problems: string[] = [];
  try {
    console.log(`══ probe-2e-volatility — READ-ONLY · ${reads} reads of the long sub=0x2e reply, nothing written ══`);
    console.log(`tap: ${process.env.FORGEFX_TAP ?? '(none set)'}`);
    // Control: the unmapped sub must stay silent, or "nothing was written" is not the only thing unproven.
    const neg = (await session.transport.request(subQuery(0x99, [0x00, 0x24, 0, 0, 0]), { timeoutMs: 900, quietMs: 60 }))
      .filter((f) => f[5] === 0x01 && f[6] === 0x99);
    console.log(`negative control sub 0x99 → ${neg.length ? 'ANSWERED (unexpected)' : 'SILENT'}`);
    if (neg.length) problems.push('negative control sub 0x99 answered');

    const replies: number[][] = [];
    for (let i = 0; i < reads; i++) {
      const heard = await session.transport.request(subQuery(0x2e, [0, 0, 0, 0, 0]), { timeoutMs: 1200, quietMs: 80 });
      const f = heard.find((x) => x[5] === 0x01 && x[6] === 0x2e && x.length > 100);
      if (f) replies.push(f);
      await sleep(45);
    }
    console.log(`long replies: ${replies.length}/${reads}${replies.length ? ` · ${replies[0]!.length}B` : ''}`);
    if (replies.length < reads) problems.push(`only ${replies.length}/${reads} long replies arrived`);
    const lens = new Set(replies.map((f) => f.length));
    if (lens.size !== 1) problems.push(`reply LENGTH is not constant across reads (${[...lens].join('/')})`);
    // the address echo (data 0..4) must be identical in every read, or the query is not the same query
    const echoes = new Set(replies.map((f) => hex(f.slice(CONTENT_BASE, CONTENT_BASE + 5))));
    console.log(`address echo constant across reads: ${echoes.size === 1 ? 'YES' : `NO (${[...echoes].join(' | ')})`}`);
    if (echoes.size !== 1) problems.push('address echo varies across reads');

    const datas = replies.map((f) => f.slice(CONTENT_BASE, f.length - 2));
    const width = Math.min(...datas.map((d) => d.length));
    // per-offset value set — the whole measurement
    const volatile: { off: number; values: { v: number; n: number }[] }[] = [];
    const stableCount = width;
    for (let off = 0; off < width; off++) {
      const counts = new Map<number, number>();
      for (const d of datas) counts.set(d[off]!, (counts.get(d[off]!) ?? 0) + 1);
      if (counts.size > 1) volatile.push({ off, values: [...counts].map(([v, n]) => ({ v, n })).sort((a, b) => b.n - a.n) });
    }
    console.log(`\ndata width compared: ${width} B · offsets with a NON-CONSTANT value across the ${datas.length} reads: ${volatile.length} of ${stableCount}`);
    for (const v of volatile) {
      console.log(`  data ${String(v.off).padStart(3)}  ${v.values.map((x) => `${x.v.toString(16).padStart(2, '0')}×${x.n}`).join(' ')}`);
    }
    const mask = volatile.map((v) => v.off).sort((a, b) => a - b);
    const headRecords = [...new Set(volatile.filter((v) => v.off < HEAD_LEN_DATA).map((v) => Math.floor(v.off / 8)))].sort((a, b) => a - b);
    console.log(`\nDERIVED MASK (pass this to the differ): --mask ${mask.join(',')}`);
    console.log(`head records (data 0..${HEAD_LEN_DATA - 1}) containing a volatile offset: ${headRecords.length ? headRecords.map((r) => '#' + r).join(' ') : 'none'}`);
    const inTail = volatile.filter((v) => v.off >= HEAD_LEN_DATA);
    console.log(`volatile offsets in the TAIL grid region (data >= ${HEAD_LEN_DATA}): ${inTail.length ? inTail.map((v) => v.off).join(' ') : 'none'}`);
    if (inTail.length) problems.push(`${inTail.length} volatile offset(s) sit in the TAIL grid region — a TAIL comparison is unreliable at this cadence`);
    const oldMask = [22, 23, 24];
    const missed = mask.filter((m) => !oldMask.includes(m));
    const spurious = oldMask.filter((m) => !mask.includes(m));
    console.log(`vs the ROUND-13 trio 22,23,24 → under-masked (moves, was not masked): ${missed.length ? missed.join(',') : 'none'}; over-masked (masked, did not move here): ${spurious.length ? spurious.join(',') : 'none'}`);

    mkdirSync(outdir, { recursive: true });
    const stage = join(outdir, 'volatility-2e.tap');
    writeFileSync(stage, replies.map((f) => `${Date.now()} RX ${hex(f)}`).join('\n') + '\n');
    writeFileSync(join(outdir, 'volatility-2e.json'), JSON.stringify({ reads: datas.length, width, mask, volatile }, null, 1) + '\n');
    console.log(`wrote ${stage} and volatility-2e.json`);

    console.log(`\nVERDICT: ${problems.length === 0 ? `measured (mask derived: ${mask.join(',') || '<empty>'}); limit: a byte stable in ${datas.length} reads may still drift rarely` : 'CONTROLS NOT GREEN'}`);
    for (const p of problems) console.log(`  • ${p}`);
    return problems.length === 0 ? 0 : 2;
  } finally {
    await sleep(50);
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
