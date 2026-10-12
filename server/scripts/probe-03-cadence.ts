// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-03-cadence — READ-ONLY. WHAT IS `fn=0x01 sub=0x03` byte 5? A free-running TIMER sampled at read
// time, or a per-READ counter? A third-party offline fit of the existing arm taps says TIMER at
// ~93.78 units/s (mod 128), which contradicts the fixture README's "advances +6 per READ". This run
// decides it on the unit, with cadences chosen so the two mechanisms predict DIFFERENT numbers.
//
// HYPOTHESES AND THEIR PREDICTIONS — written BEFORE any frame is sent. `b5` = reply data byte 5.
// R = 93.75 units/s is the offline fit; `d` = drop of `b5` between two reads, mod 128.
//
//   M_CLOCK   b5 is a free-running timer; it advances by R x (elapsed time), independent of read count.
//             I20 (20 s idle, no frames)  -> d ~ +84       (1875 mod 128)
//             I30 (30 s idle, no frames)  -> d ~ +125      (2813 mod 128)
//             A   (8 reads @64 ms)        -> d ~  +6 per read
//             B   (8 reads @500 ms)       -> d ~ +47 per read
//             C   (20 tight reads, ~20 ms apart) -> d ~ +2 per read
//             0x3a over a 20 s idle       -> d = 0 (that field is write-driven, not clock-driven)
//   M_COUNTER b5 advances a fixed step PER READ of this block. Predicts d = +6 for EVERY block above
//             including both idle windows, and +6 per read in C (=> ~+120 over 20 reads, mod 128).
//   M_COUNTER_ALL b5 advances per ANY fn=0x01 read on the bus. Same shape; the idle windows still
//             predict a small number (~+6), never ~84/~125.
//
// The idle windows are the clean discriminator: no frame is sent for 20 s and 30 s, so a counter can
// only move by its per-read step while a timer must move by ~84 and ~125. Every frame heard during an
// idle window is COUNTED and reported, so "no frames during the gap" is measured, not assumed.
//
// The instrument is validated in-run: sub 0x99 must be SILENT, three reads of eid 0x46 must be identical,
// and the fn=0x0d preset name is logged. NOTHING IS WRITTEN. Read-only; a frame tap is written.
//
// USAGE  npx tsx scripts/probe-03-cadence.ts [--port /dev/ttyACM0] [--target 0x5e]
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { fractalChecksum } from 'forgefx-midi/shared';

const MODEL = 0x11;
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const R_OFFLINE = 93.78; // units/s from the offline fit of the existing arm taps

function addrQuery(sub: number, at: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, 0x01, sub, ...at];
  while (body.length < 20) body.push(0x00);
  return [...body, fractalChecksum(body), 0xf7];
}
const payload = (frames: readonly number[][], sub: number): number[] | null => {
  const f = frames.find((x) => x[5] === 0x01 && x[6] === sub && x.length <= 100 && x.length > 10);
  return f ? f.slice(7, -1) : null;
};
/** fn=0x0D QUERY PATCH NAME — the correct frame is NOT padded to 20 bytes like the fn=0x01 reads. */
function patchNameQuery(): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, 0x0d, 0x7f, 0x7f];
  return [...body, fractalChecksum(body), 0xf7];
}
function patchNameOf(frames: readonly number[][]): string {
  const f = frames.find((x) => x[5] === 0x0d);
  if (!f) return '<no reply>';
  return String.fromCharCode(...f.slice(6, -2).filter((b) => b >= 0x20 && b < 0x7f)).trim();
}

interface Sample { t: number; b5: number | null; b6: number | null; b7: number | null }

export async function main(argv: string[]): Promise<number> {
  const arg = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const target = arg('--target') !== undefined ? parseInt(arg('--target')!, 16) : 0x5e;
  if (arg('--tap')) process.env.FORGEFX_TAP = arg('--tap')!;
  const opened = await openProbeSession(MODEL, arg('--port'));
  if (!opened.ok) { console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`); return 3; }
  const { session } = opened;
  try {
    console.log(`device ${session.label} · READ-ONLY · sub 0x03 byte-5 cadence test, target eid 0x${target.toString(16)}`);
    console.log('predictions (written before any frame was sent):');
    console.log(`  M_CLOCK  timer @ ~${R_OFFLINE} units/s mod 128: I20 -> +84 · I30 -> +125 · A +6/read · B +47/read · C +2/read · 0x3a idle -> 0`);
    console.log('  M_COUNTER fixed step (+6) per read of this block: EVERY block, idle windows included, -> +6');
    console.log('  M_COUNTER_ALL same, per any fn=0x01 read on the bus: idle windows still -> small, never ~84/~125');

    console.log(`\npreset in the edit buffer (fn=0x0d): "${patchNameOf(await session.transport.request(patchNameQuery(), { timeoutMs: 900, quietMs: 60 }))}"`);
    const placed = ((await session.driver.sceneState?.()) ?? []).map((s) => s.effectId).sort((a, b) => a - b);
    console.log(`fn=0x13 placed: ${placed.map((e) => '0x' + e.toString(16)).join(' ')}`);

    // ── in-run validation ───────────────────────────────────────────────────────────────────────
    const neg = await session.transport.request(addrQuery(0x99, [0x01, target, 0, 0, 0]), { timeoutMs: 900, quietMs: 60 });
    console.log(`negative control sub 0x99 → ${neg.filter((f) => f[5] === 0x01 && f[6] === 0x99).length ? 'ANSWERED (unexpected)' : 'SILENT'}`);

    // Every frame (TX or RX) that reaches the transport while a flag is armed — used to MEASURE that an
    // idle window is really idle rather than assuming it.
    let counting = false;
    let framesDuringIdle = 0;
    const off = session.transport.onFrame(() => { if (counting) framesDuringIdle++; });

    const readB5 = async (): Promise<Sample> => {
      const t = Date.now();
      const d = payload(await session.transport.request(addrQuery(0x03, [0x01, sampleEid, 0, 0, 0]), { timeoutMs: 900, quietMs: 15 }), 0x03);
      return { t, b5: d ? d[5] ?? null : null, b6: d ? d[6] ?? null : null, b7: d ? d[7] ?? null : null };
    };
    let sampleEid = target;

    // The stability control MUST be a block that is NOT expected to drift. Using the target here would
    // abort the run on exactly the behaviour being measured — the drift is the SUBJECT, not a fault.
    const STABLE = 0x46;
    sampleEid = STABLE;
    const st: Sample[] = [];
    for (let i = 0; i < 3; i++) st.push(await readB5());
    const stSame = new Set(st.map((s) => String(s.b5))).size === 1;
    console.log(`stability control 0x${STABLE.toString(16)} x3 (a NON-drifting eid): ${st.map((s) => s.b5 === null ? 'silent' : '0x' + s.b5!.toString(16)).join(' ')}` +
      ` → ${stSame ? 'IDENTICAL (channel readable)' : 'DIFFERENT — the channel is not readable enough to run this'}`);
    if (!stSame) { off(); return 2; }
    sampleEid = target;
    // The target's own drift at the tightest cadence, measured rather than asserted.
    const t0 = await readB5(); const t1 = await readB5(); const t2 = await readB5();
    console.log(`target 0x${target.toString(16)} x3 tight reads: ${[t0, t1, t2].map((s) => s.b5 === null ? 'silent' : '0x' + s.b5!.toString(16)).join(' ')}` +
      `  (Δt ${t1.t - t0.t}/${t2.t - t1.t} ms — a per-read step of 6 would need ≥64 ms spacing at ~94 units/s)`);

    const D = (a: Sample, b: Sample): number | null => (a.b5 === null || b.b5 === null) ? null : ((b.b5 - a.b5) % 128 + 128) % 128;
    /** Per-step Δ, the elapsed ms, and the two predictions for that gap. */
    const row = (label: string, a: Sample, b: Sample, reads: number): void => {
      const d = D(a, b); const dt = b.t - a.t;
      const clock = ((R_OFFLINE * dt) / 1000) % 128;
      const counter = (6 * reads) % 128;
      console.log(`  ${label.padEnd(26)} Δt=${String(dt).padStart(5)}ms  reads=${String(reads).padStart(2)}  measured Δ=${d === null ? '--' : String(d).padStart(3)}` +
        `   M_CLOCK≈${clock.toFixed(0).padStart(3)}  M_COUNTER≈${String(counter).padStart(3)}${d !== null && Math.abs(((d - clock + 64) % 128) - 64) <= 2 ? '   <-- clock fits' : ''}`);
    };

    // ── A: 8 reads at ~64 ms (the cadence the old arm used) ──────────────────────────────────────
    console.log('\nA — 8 reads at ~64 ms:');
    {
      const s: Sample[] = [];
      for (let i = 0; i < 8; i++) { s.push(await readB5()); if (i < 7) await sleep(50); }
      for (let i = 1; i < s.length; i++) row(`A step ${i}`, s[i - 1]!, s[i]!, 1);
    }

    // ── I20 / I30: an idle window with NO frames at all ──────────────────────────────────────────
    for (const secs of [20, 30]) {
      console.log(`\nI${secs} — one read, then ${secs} s with nothing sent, then one read:`);
      const a = await readB5();
      counting = true; framesDuringIdle = 0;
      await sleep(secs * 1000);
      counting = false;
      const b = await readB5();
      row(`I${secs}`, a, b, 1);
      console.log(`  frames heard during the ${secs} s window: ${framesDuringIdle} (0 = the field moved with nothing on the bus)`);
    }

    // ── B: 8 reads at ~500 ms ────────────────────────────────────────────────────────────────────
    console.log('\nB — 8 reads at ~500 ms:');
    {
      const s: Sample[] = [];
      for (let i = 0; i < 8; i++) { s.push(await readB5()); if (i < 7) await sleep(480); }
      for (let i = 1; i < s.length; i++) row(`B step ${i}`, s[i - 1]!, s[i]!, 1);
    }

    // ── C: 20 tight reads ────────────────────────────────────────────────────────────────────────
    console.log('\nC — 20 tight reads (transport resolves on a 15 ms quiet gap):');
    {
      const s: Sample[] = [];
      for (let i = 0; i < 20; i++) s.push(await readB5());
      for (let i = 1; i < s.length; i++) row(`C step ${i}`, s[i - 1]!, s[i]!, 1);
      row('C first→last', s[0]!, s[s.length - 1]!, s.length - 1);
    }

    // ── contrast: a write-driven field must NOT move across an idle window ───────────────────────
    const other = target === 0x3a ? 0x5e : 0x3a;
    console.log(`\nCONTRAST — eid 0x${other.toString(16)} (write-driven per ROUND 12) across a 20 s idle:`);
    sampleEid = other;
    const c1 = await readB5();
    await sleep(20000);
    const c2 = await readB5();
    row('contrast 20 s idle', c1, c2, 1);
    off();
    console.log('\nREAD ONLY — nothing was written. A verdict needs the idle windows to agree with ONE mechanism;');
    console.log('if I20/I30 land near +84/+125 the field is a timer and the README\'s "+6 per READ" is wrong.');
    return 0;
  } finally {
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
