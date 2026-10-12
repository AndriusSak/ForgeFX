// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-map-volatility — READ-ONLY: explain the three volatile bytes (`+22`/`+23`/`+24`) of the 590-byte
// `fn=0x01 sub=0x2e` reply. Until they are explained, NO byte of that reply may be used as a stable
// identity — the rule the cab-slot region already taught (never build on a volatile region).
//
// WHAT IS ALREADY KNOWN (from `test/fixtures/query-subs/fm3-query-subs.tap`, no new hardware needed):
// the trio differs between two long replies taken 124 ms apart INSIDE ONE CONNECTION, and differs again
// across connections. So "a per-connection nonce" is already REFUTED. This probe separates what is left.
//
// HYPOTHESES AND THEIR PREDICTIONS — written BEFORE any frame is sent. Each is falsifiable, and the two
// connections below predict DIFFERENT numbers for the exact steps this probe runs:
//
//   H1  FREE-RUNNING COUNTER (a device clock/uplink counter, 24-bit, wrapping).
//       CONN A (equal 500 ms steps)  → the per-step trio Δ is CONSTANT (equal spacing, constant rate).
//       CONN B (250/500/1000/2000/4000/8000 ms steps) → the Δ is PROPORTIONAL to the spacing
//         (a 4000 ms step moves ~8× a 500 ms step, modulo the 2^24 wrap).
//   H2  PER-READ NONCE / pseudorandom (a replay guard).
//       CONN A → Δ shows NO constant value; CONN B → Δ bears NO relation to the spacings.
//   H3  PER-CONNECTION NONCE. ALREADY REFUTED by the fixture tap (two replies 124 ms apart in one
//       connection differ). Re-tested here only so the refutation stays re-observable, never re-asserted.
//   H4  DERIVED FROM THE REQUEST (an echo of address/checksum bytes). Predicts the SAME trio for the same
//       request bytes; the fixture already shows one `zeros` request giving two different trios, so this is
//       refuted too — re-observed here across the two connections.
//
// The instrument is validated in the same run: every step ALSO sends the SHORT `0x2e` (request byte 7 = 0x01)
// whose single varying data byte flipped 00→01 between the two fixture runs. If that byte and the trio move
// together they share a source; if not, the quartet is two separate things — a distinction nobody has made.
//
// NOTHING IS WRITTEN. Every frame is a read-shaped `fn=0x01` with no value bytes; a frame tap is written and
// `#conn N` markers are appended to it so the connection boundary is visible in the data, not inferred from a
// gap in the timestamps. The preset name is read before and after; a difference exits 5.
//
// USAGE  npx tsx scripts/probe-map-volatility.ts [--port /dev/ttyACM0] [--tap /path.log]
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'node:url';
import { appendFileSync } from 'node:fs';
import { openProbeSession } from './probe-device.js';
import { fractalChecksum } from 'forgefx-midi/shared';

const MODEL = 0x11;
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The LONG `0x2e` request (byte 7 = 0x00): the full model-side table. */
function longQuery(): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, 0x01, 0x2e, 0x00, 0x00, 0x00, 0x00, 0x00];
  while (body.length < 20) body.push(0x00);
  return [...body, fractalChecksum(body), 0xf7];
}
/** The SHORT `0x2e` request (byte 7 = 0x01): the SELECTOR switches this sub to one small record. */
function shortQuery(): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, 0x01, 0x2e, 0x01, 0x00, 0x00, 0x00, 0x00];
  while (body.length < 20) body.push(0x00);
  return [...body, fractalChecksum(body), 0xf7];
}
/** fn=0x0D QUERY PATCH NAME — the cheap "has anything changed" oracle for a read-only probe. */
function patchNameQuery(): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, 0x0d, 0x7f, 0x7f];
  return [...body, fractalChecksum(body), 0xf7];
}
function patchNameOf(frames: readonly number[][]): string {
  const f = frames.find((x) => x[5] === 0x0d);
  if (!f) return '<no reply>';
  return String.fromCharCode(...f.slice(6, -2).filter((b) => b >= 0x20 && b < 0x7f)).trim();
}

/** The trio, data-relative +22/+23/+24 = frame offsets 34/35/36 (data = frame.slice(12, -2)). */
const trioOf = (f: readonly number[]) => [f[34] ?? -1, f[35] ?? -1, f[36] ?? -1];

interface Read { step: number; gapMs: number; at: number; trio: number[]; ck: string; short: string; len: number }

type Req = (f: number[], o: { timeoutMs: number; quietMs: number }) => Promise<number[][]>;

async function oneConnection(label: string, req: Req, gaps: readonly number[], tap: string | null): Promise<Read[]> {
  if (tap) appendFileSync(tap, `${Date.now()} #conn ${label}\n`);
  const out: Read[] = [];
  for (let step = 0; step < gaps.length; step++) {
    if (step > 0) await sleep(gaps[step]!);
    const heard = await req(longQuery(), { timeoutMs: 1200, quietMs: 80 });
    const lo = heard.find((f) => f[5] === 0x01 && f[6] === 0x2e && f.length > 100);
    const heard2 = await req(shortQuery(), { timeoutMs: 1200, quietMs: 80 });
    const sh = heard2.find((f) => f[5] === 0x01 && f[6] === 0x2e && f.length <= 100 && f.length > 10);
    out.push({
      step,
      at: Date.now(),
      gapMs: step === 0 ? 0 : 0, // filled below from arrival times
      trio: lo ? trioOf(lo) : [],
      ck: lo ? hex(lo.slice(-3, -1)) : '--',
      short: sh ? `${sh.length}B ${hex(sh.slice(7, 23))}` : 'no short reply',
      len: lo?.length ?? 0
    });
  }
  for (let i = 1; i < out.length; i++) out[i]!.gapMs = out[i]!.at - out[i - 1]!.at;
  return out;
}

const wrapDelta = (a: readonly number[], b: readonly number[]) => a.map((v, i) => (v - b[i]! + 256) % 256);

function report(title: string, reads: Read[], equalSpacing: boolean): void {
  console.log(`\n${title}`);
  console.log('  step  gap(ms)  +22 +23 +24   ck      Δ vs prev          short(0x2e sel=1)');
  reads.forEach((r, i) => {
    const d = i === 0 ? '-' : hex(wrapDelta(r.trio, reads[i - 1]!.trio));
    console.log(`  ${String(r.step).padStart(3)}  ${String(i === 0 ? '-' : r.gapMs).padStart(7)}  ${hex(r.trio)}   ${r.ck}   ${d.padEnd(8)}  ${r.short}`);
  });
  const trios = reads.map((r) => hex(r.trio));
  console.log(`  distinct trios: ${new Set(trios).size}/${trios.length}  · replies ${reads[0]?.len}B`);
  console.log(`  H1 prediction here: ${equalSpacing ? 'a CONSTANT Δ column (equal spacing, constant rate)' : 'Δ proportional to the gap column'}`);
}

/** The SHORT `0x2e` request with an explicit address region (`sel`, then `addr`), as the fixture used. */
function shortQueryAt(sel: number, addr: number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, 0x01, 0x2e, sel, ...addr];
  while (body.length < 20) body.push(0x00);
  return [...body, fractalChecksum(body), 0xf7];
}

/**
 * SAMPLING MODE — the timer test above separates "counter" from "not a counter". This mode characterises
 * what IS there, because 16 samples already showed something a uniform random byte cannot do: `+22` never
 * left `0..3`. A uniform byte would have had probability (4/256)^16 ≈ 1e-27 of that. So the trio is not
 * three independent random bytes — it has structure, and the structure is the thing to measure.
 *
 * It also settles a discrepancy the fixture left open: with address `01 3a` its short reply carried a byte
 * that flipped `00`→`01` between runs, while this probe's short replies (address zeros) were identical 16/16.
 * Same subject, two readings — so both addresses are sampled here and the distinct-payload counts compared.
 */
async function sample(req: Req, n: number): Promise<void> {
  const trios: number[][] = [];
  for (let i = 0; i < n; i++) {
    const heard = await req(longQuery(), { timeoutMs: 1200, quietMs: 60 });
    const lo = heard.find((f) => f[5] === 0x01 && f[6] === 0x2e && f.length > 100);
    if (lo) trios.push(trioOf(lo));
  }
  const shortZeros: string[] = [];
  const shortAddr: string[] = [];
  for (let i = 0; i < n; i++) {
    const hz = await req(shortQueryAt(0x01, [0x00, 0x00, 0x00, 0x00]), { timeoutMs: 1200, quietMs: 60 });
    const fz = hz.find((f) => f[5] === 0x01 && f[6] === 0x2e && f.length <= 100 && f.length > 10);
    if (fz) shortZeros.push(hex(fz.slice(7, -1)));
    const ha = await req(shortQueryAt(0x01, [0x3a, 0x00, 0x00, 0x00]), { timeoutMs: 1200, quietMs: 60 });
    const fa = ha.find((f) => f[5] === 0x01 && f[6] === 0x2e && f.length <= 100 && f.length > 10);
    if (fa) shortAddr.push(hex(fa.slice(7, -1)));
  }

  console.log(`\nSAMPLING — ${trios.length} long replies, ${shortZeros.length}+${shortAddr.length} short replies`);
  console.log('  byte   min  max  distinct  values (sorted)');
  for (let k = 0; k < 3; k++) {
    const s = trios.map((t) => t[k]!);
    const uniq = [...new Set(s)].sort((a, b) => a - b);
    console.log(`  +${22 + k}    ${String(Math.min(...s)).padStart(3)}  ${String(Math.max(...s)).padStart(3)}  ${String(uniq.length).padStart(8)}  ${uniq.map((v) => v.toString(16).padStart(2, '0')).join(' ')}${uniq.length > 32 ? ' …' : ''}`);
  }
  const maxOf = (s: readonly number[]) => Math.max(...s);
  console.log(`\n  a uniform 24-bit value would put +22 in 0..255; measured max +22 = ${maxOf(trios.map((t) => t[0]!))}`);
  const top = trios.map((t) => t[0]!);
  console.log(`  +22 histogram: ${[...new Set(top)].sort((a, b) => a - b).map((v) => `${v}×${top.filter((x) => x === v).length}`).join(' ')}`);
  // Correlations worth checking before inventing anything: are the three bytes really independent?
  const pairs: Array<[number, number]> = [[0, 1], [0, 2], [1, 2]];
  for (const [i, j] of pairs) {
    const eq = trios.filter((t) => t[i]! === t[j]!).length;
    console.log(`  +${22 + i} == +${22 + j} in ${eq}/${trios.length} samples (independence ⇒ ~${(trios.length / 256).toFixed(2)})`);
  }
  console.log(`\n  short reply, address zeros:   ${new Set(shortZeros).size}/${shortZeros.length} distinct`);
  if (new Set(shortZeros).size <= 4) for (const p of [...new Set(shortZeros)]) console.log(`      ${p}`);
  console.log(`  short reply, address 01 3a:   ${new Set(shortAddr).size}/${shortAddr.length} distinct`);
  if (new Set(shortAddr).size <= 4) for (const p of [...new Set(shortAddr)]) console.log(`      ${p}`);
  console.log('\n  ⇒ "distinct 1/1" means that short record is REPRODUCIBLE for its address (not a nonce);');
  console.log('    "distinct n/n" means it carries the same per-read volatility as the long reply.');
}

export async function main(argv: string[]): Promise<number> {
  const arg = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const port = arg('--port');
  const sampleCount = Number(arg('--sample') ?? 0);
  if (arg('--tap')) process.env.FORGEFX_TAP = arg('--tap')!;
  const opened = await openProbeSession(MODEL, port);
  if (!opened.ok) { console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`); return 3; }
  const { session } = opened;

  if (sampleCount > 0) {
    try {
      const nameBefore = patchNameOf(await session.transport.request(patchNameQuery(), { timeoutMs: 900, quietMs: 60 }));
      console.log(`device ${session.label} · READ-ONLY · SAMPLING ${sampleCount}× per shape · preset ${JSON.stringify(nameBefore)}`);
      await sample((f, o) => session.transport.request(f, o), sampleCount);
      const nameAfter = patchNameOf(await session.transport.request(patchNameQuery(), { timeoutMs: 900, quietMs: 60 }));
      if (nameAfter !== nameBefore) { console.log('!! THE PRESET NAME CHANGED DURING A READ-ONLY PROBE — investigate.'); return 5; }
      console.log('side-effect check: preset name identical before and after.');
      return 0;
    } finally { await session.close(); }
  }
  const tap = process.env.FORGEFX_TAP ?? null;
  console.log(`device ${session.label} · READ-ONLY · tap ${tap ?? '(none)'}`);
  console.log('predictions (written before any frame was sent):');
  console.log('  H1 free-running counter: CONN A (equal 500 ms) → CONSTANT Δ;  CONN B (250/500/1000/2000/4000/8000 ms) → Δ ∝ spacing');
  console.log('  H2 per-read nonce:       no constant Δ in CONN A, no relation to spacing in CONN B');
  console.log('  H3 per-connection nonce: refuted by the fixture (two replies 124 ms apart in ONE connection differ)');
  console.log('  H4 echo-of-request:      refuted by the fixture (one `zeros` request, two different trios)');

  const EQUAL = [0, 500, 500, 500, 500, 500, 500, 500];   // CONN A — constant-spacing test
  const GEOM = [0, 250, 500, 1000, 2000, 4000, 8000, 500]; // CONN B — proportionality test

  try {
    const nameBefore = patchNameOf(await session.transport.request(patchNameQuery(), { timeoutMs: 900, quietMs: 60 }));
    console.log(`\npreset name before: ${JSON.stringify(nameBefore)}`);

    const a = await oneConnection('1', (f, o) => session.transport.request(f, o), EQUAL, tap);
    report('CONNECTION 1 — equal 500 ms steps', a, true);
    await session.close();

    const opened2 = await openProbeSession(MODEL, port);
    if (!opened2.ok) { console.log(`re-open failed: [${opened2.failure.cls}] ${opened2.failure.detail}`); return 3; }
    const s2 = opened2.session;
    try {
      const b = await oneConnection('2', (f, o) => s2.transport.request(f, o), GEOM, tap);
      report('CONNECTION 2 — geometric steps (proportionality test)', b, false);

      console.log('\nCONN 1 vs CONN 2 at the same step ordinal (a session-scoped value would repeat):');
      a.forEach((r, i) => {
        const q = b[i];
        if (q) console.log(`  step ${i}: ${hex(r.trio)} vs ${hex(q.trio)}  ${hex(r.trio) === hex(q.trio) ? 'SAME' : 'different'}`);
      });
      const nameAfter = patchNameOf(await s2.transport.request(patchNameQuery(), { timeoutMs: 900, quietMs: 60 }));
      console.log(`\npreset name after:  ${JSON.stringify(nameAfter)}`);
      if (nameAfter !== nameBefore) { console.log('!! THE PRESET NAME CHANGED DURING A READ-ONLY PROBE — investigate.'); return 5; }
      console.log('side-effect check: preset name identical before and after.');
    } finally { await s2.close(); }
    return 0;
  } finally {
    try { await session.close(); } catch { /* already closed */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
