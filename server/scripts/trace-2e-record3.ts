// ────────────────────────────────────────────────────────────────────────────────────────────────
// trace-2e-record3 — READ-ONLY. Watch head record #3 (data 24..31) of the fm3 0x2e reply over TIME with
// NOTHING else happening, so a value that moves on its own is separated from one that moves with state.
//
// WHY. ROUND 15 §3/§4 measured data 25/26 as a placement state field: `46 50` when no extra block is
// placed and `4c 10` with chorus 2 alone, held for a whole 5 s dwell. Then two later runs of the SAME
// 6-write chain showed the pair SWITCHING INSIDE a stage (`4b 50` -> `4c 10` at S1; `52 50` -> `52 10` at
// S2), and a single `4b 50` read had already been recorded mid-dwell in the placement arm. A value that can
// change while nothing is being asked of the device cannot be attributed to an edit without knowing its own
// dynamics, so this instrument measures them: one long sequence of reads, fixed cadence, no write, no dump,
// per-read values printed with the wall-clock gap.
//
// PREDICTIONS, written before the run:
//   H_STATIC  the pair holds one value for the whole trace (and per-offset, everything but 22/23/24 is
//             constant) ⇒ the switches seen in the state-chain runs need an intervention to explain them.
//   H_DRIFT   the pair moves during the trace with no intervention ⇒ it is (at least partly) time-driven,
//             and every "state" correlation measured so far has to be re-tested against the drift.
//   H_EVENT   it moves only in the first reads after the connection opens, then holds ⇒ it is a
//             connection/traffic effect, not preset state.
//
// USAGE  npx tsx scripts/trace-2e-record3.ts [--reads 120] [--gap 500] [--port /dev/ttyACM0]
// Exit 0 read · 2 the trace itself drifted in a way it cannot classify (printed, never smoothed) · 3 no device.
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { subQuery } from './standing-read.js';

const MODEL = 0x11;
const CONTENT_BASE = 12;
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function main(argv: string[]): Promise<number> {
  const arg = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const reads = Math.max(4, Number(arg('--reads') ?? 120));
  const gap = Math.max(60, Number(arg('--gap') ?? 500));
  if (arg('--tap')) process.env.FORGEFX_TAP = arg('--tap')!;

  const opened = await openProbeSession(MODEL, arg('--port'));
  if (!opened.ok) { console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`); return 3; }
  const { session } = opened;
  try {
    console.log(`══ trace-2e-record3 — READ-ONLY · ${reads} reads at ~${gap} ms, nothing written ══`);
    console.log('predictions: H_STATIC one value all trace · H_DRIFT moves with no intervention (time-driven) · H_EVENT moves only right after the connection opens');
    console.log(`tap: ${process.env.FORGEFX_TAP ?? '(none set)'}`);
    const neg = (await session.transport.request(subQuery(0x99, [0x00, 0x24, 0, 0, 0]), { timeoutMs: 900, quietMs: 60 }))
      .filter((f) => f[5] === 0x01 && f[6] === 0x99);
    console.log(`negative control sub 0x99 → ${neg.length ? 'ANSWERED (unexpected)' : 'SILENT'}`);

    const t0 = Date.now();
    const rows: { ms: number; rec: string; d24: string }[] = [];
    for (let i = 0; i < reads; i++) {
      const heard = await session.transport.request(subQuery(0x2e, [0, 0, 0, 0, 0]), { timeoutMs: 1200, quietMs: 80 });
      const f = heard.find((x) => x[5] === 0x01 && x[6] === 0x2e && x.length > 100);
      if (f) {
        const d = f.slice(CONTENT_BASE, f.length - 2);
        rows.push({ ms: Date.now() - t0, rec: hex(d.slice(25, 32)), d24: d[24]!.toString(16).padStart(2, '0') });
      }
      await sleep(gap);
    }
    console.log(`\nreads answered: ${rows.length}/${reads}`);
    console.log('  t(ms)   data25..31                 data24');
    let prev = '';
    for (const r of rows) {
      const mark = r.rec === prev ? ' ' : '*';
      console.log(`  ${String(r.ms).padStart(6)} ${mark} ${r.rec}   ${r.d24}`);
      prev = r.rec;
    }
    const uniqRec = [...new Set(rows.map((r) => r.rec))];
    console.log(`\ndistinct data25..31 values: ${uniqRec.length} → ${uniqRec.join(' | ')}`);
    console.log(`distinct data24 values: ${new Set(rows.map((r) => r.d24)).size} (per-read volatile expected)`);
    // per-offset stability, so a single moving byte is named rather than reported as "the record"
    const movers: string[] = [];
    for (let off = 25; off <= 31; off++) {
      const vals = new Set(rows.map((r) => r.rec.split(' ')[off - 25]!));
      if (vals.size > 1) movers.push(`data ${off} (${[...vals].join('/')})`);
    }
    console.log(`moving offsets in 25..31: ${movers.length ? movers.join(', ') : 'none'}`);
    const firstChange = rows.findIndex((r, i) => i > 0 && r.rec !== rows[i - 1]!.rec);
    const lateChanges = rows.map((r, i) => (i > 0 && r.rec !== rows[i - 1]!.rec ? i : -1)).filter((i) => i > 3);
    const verdict = uniqRec.length === 1 ? 'H_STATIC — one value for the whole trace'
      : lateChanges.length > 0 ? `H_DRIFT — the value moved at read index(es) ${lateChanges.join(', ')} with NO intervention`
      : 'H_EVENT — it moved only in the first few reads after connecting';
    console.log(`\nfirst change at read index ${firstChange === -1 ? '(none)' : firstChange} · changes after index 3: ${lateChanges.length}`);
    console.log(`VERDICT: ${verdict}`);
    return 0;
  } finally {
    await sleep(50);
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
