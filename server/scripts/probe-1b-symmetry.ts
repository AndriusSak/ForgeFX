// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-1b-symmetry — ROUND 14, task 2 (SYMMETRY half). READ-ONLY, no writes anywhere.
//
// Restated in the terms task 1 established: the `fn=0x01 sub=0x1b` reply is `frame.slice(7,-1)` = a 5-byte
// address echo (data 0-4) + a NINE-byte content field C9 = data 5..13. "What are the 21 bits" is dead.
//
// THE QUESTION. C9 is a function of the five address bytes. Two of them are known to walk something:
// at1 (byte 8, the "eid") and at3 (byte 10, whose sweep gives 23 distinct values on eid 0x46 and 37 on
// 0x3a, jointly with the eid). If the two axes are really ONE flat index — C9 = T(at1 + at3) — then the
// repo's picture changes: the "eid" byte is not an eid at all, just a second offset.
//
// HYPOTHESES AND PREDICTIONS — written BEFORE any frame was sent. With V_E(d) = C9(at1=E, at3=d) and
// U_D(b) = C9(at1=b, at3=D), the flat-index hypothesis predicts U_D(b) == V_E(b + (D-E)) for EVERY b.
//
//   H_FLAT   one flat index. PREDICTS: some shift Delta with mismatch(Delta) = 0 over an overlap >= 32,
//            and specifically Delta = D - E for the two D values tried.
//   H_TWO    two independent addressing dimensions. PREDICTS: no shift matches; the best mismatch ratio
//            is at chance level. Chance is calibrated in-run by pooling all tokens and re-comparing.
//   H_PART   partial: report the best Delta and the rows that disagree; no verdict.
//
// A DISCIPLINE NOTE THIS ROUND PAID FOR TWICE: the test compares across TWO different D values, because a
// single D can match by luck. And the comparison uses a RATIO, not a raw count — overlap shrinks with |Delta|,
// so a raw count would favour the largest shift.
//
// NOT READ-ONLY-BY-ACCIDENT: the STABILITY half of task 2 needs a scene change (`fn=0x0c`), which is a WRITE.
// It lives behind `--with-scene` and is NOT run by default; the read-only half does not touch the unit's state.
//
// USAGE  npx tsx scripts/probe-1b-symmetry.ts [--port /dev/ttyACM0]
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { fractalChecksum } from 'forgefx-midi/shared';

const MODEL = 0x11;
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function subQuery(sub: number, at: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, 0x01, sub, ...at];
  while (body.length < 20) body.push(0x00);
  return [...body, fractalChecksum(body), 0xf7];
}
const content = (frames: readonly number[][], sub: number): string | null => {
  const f = frames.find((x) => x[5] === 0x01 && x[6] === sub && x.length <= 100 && x.length > 10);
  return f ? hex(f.slice(7, -1).slice(5, 14)) : null;   // C9 = data 5..13
};
function patchNameQuery(): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, 0x0d, 0x7f, 0x7f];
  return [...body, fractalChecksum(body), 0xf7];
}
function patchNameOf(frames: readonly number[][]): string {
  const f = frames.find((x) => x[5] === 0x0d);
  if (!f) return '<no reply>';
  return String.fromCharCode(...f.slice(6, -2).filter((b) => b >= 0x20 && b < 0x7f)).trim();
}

/** mismatch(Delta) over the rows where both sides exist, compared as 9-byte tokens. */
function translation(u: readonly string[], v: readonly string[]): { delta: number; mismatch: number; overlap: number } | null {
  let best: { delta: number; mismatch: number; overlap: number } | null = null;
  for (let d = -63; d <= 63; d++) {
    let overlap = 0; let bad = 0;
    for (let b = 0; b < u.length; b++) {
      const j = b + d;
      if (j < 0 || j >= v.length) continue;
      overlap++;
      if (u[b] !== v[j]) bad++;
    }
    if (overlap < 8) continue;
    if (!best || bad / overlap < best.mismatch / best.overlap) best = { delta: d, mismatch: bad, overlap };
  }
  return best;
}

export async function main(argv: string[]): Promise<number> {
  const arg = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const withScene = argv.includes('--with-scene');
  if (arg('--tap')) process.env.FORGEFX_TAP = arg('--tap')!;
  const opened = await openProbeSession(MODEL, arg('--port'));
  if (!opened.ok) { console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`); return 3; }
  const { session } = opened;
  try {
    console.log(`device ${session.label} · sub 0x1b symmetry test ${withScene ? '(+ STABILITY scene arm — WRITES)' : '(READ-ONLY)'}`);
    console.log('predictions (written before any frame was sent):');
    console.log('  H_FLAT  C9 = T(at1 + at3): some Delta gives mismatch=0 over an overlap >= 32, and Delta = D - E');
    console.log('  H_TWO   two independent axes: no Delta matches; the best ratio sits at the in-run chance level');
    console.log('  H_PART  the best Delta matches only partly -> report the disagreeing rows, publish no verdict');

    console.log(`\npreset in the edit buffer (fn=0x0d): "${patchNameOf(await session.transport.request(patchNameQuery(), { timeoutMs: 900, quietMs: 60 }))}"`);
    const state = (await session.driver.sceneState?.()) ?? [];
    const placed = state.map((s) => s.effectId).sort((a, b) => a - b);
    console.log(`fn=0x13 placed: ${placed.map((e) => '0x' + e.toString(16)).join(' ')}`);

    const neg = (await session.transport.request(subQuery(0x99, [0x00, 0x46, 0, 0, 0]), { timeoutMs: 900, quietMs: 60 }))
      .filter((f) => f[5] === 0x01 && f[6] === 0x99);
    console.log(`negative control sub 0x99 → ${neg.length ? 'ANSWERED (unexpected)' : 'SILENT'}`);

    const read = async (at: readonly number[]): Promise<string | null> =>
      content(await session.transport.request(subQuery(0x1b, at), { timeoutMs: 900, quietMs: 15 }), 0x1b);

    // The stability oracle is a NON-drifting row (0x46 with a zeroed tail); the hole sentinel is logged because
    // it moved uncommanded earlier today and a fresh value must not be mistaken for a change caused by this run.
    const orc: string[] = [];
    for (let i = 0; i < 3; i++) orc.push((await read([0x00, 0x46, 0, 0, 0])) ?? '(silent)');
    const orcOk = new Set(orc).size === 1;
    console.log(`stability oracle C9(0x46, tail 0): ${orc.join(' | ')} → ${orcOk ? 'IDENTICAL' : 'DIFFERENT — channel not stable enough to compare maps'}`);
    console.log(`hole sentinel C9(0x24, tail 0): ${(await read([0x00, 0x24, 0, 0, 0])) ?? '(silent)'}  (log it: this record moved once today with no trigger)`);
    if (!orcOk) return 2;

    // ── the sweeps ───────────────────────────────────────────────────────────────────────────────
    // TWO DIFFERENT AXES, and a first version of this tool conflated them: it swept at1 for BOTH "maps"
    // and produced two byte-identical outputs for different eids, which is what exposed the bug. An at3 map
    // holds at1 FIXED and walks at3; an at1 map holds at3 FIXED and walks at1.
    const sweepAxis = async (label: string, fixed: number, axis: 'at1' | 'at3'): Promise<string[]> => {
      const out: string[] = [];
      for (let v = 0; v <= 0x3f; v++) {
        const at = axis === 'at1' ? [0x00, v, 0x00, fixed, 0x00] : [0x00, fixed, 0x00, v, 0x00];
        out.push((await read(at)) ?? '(silent)');
      }
      const uniq = new Map<string, number[]>();
      out.forEach((c, i) => uniq.set(c, [...(uniq.get(c) ?? []), i]));
      console.log(`\n${label}`);
      console.log(`   ${uniq.size} distinct — ${[...uniq].sort((a, b) => b[1].length - a[1].length).slice(0, 8).map(([c, ix]) => `${c}(×${ix.length})`).join('  ')}`);
      return out;
    };

    const V46 = await sweepAxis('V(0x46) — at3 walked 0x00..0x3f, at1 fixed at 0x46', 0x46, 'at3');
    const V3a = await sweepAxis('V(0x3a) — at3 walked 0x00..0x3f, at1 fixed at 0x3a', 0x3a, 'at3');
    const U01 = await sweepAxis('U(D=0x01) — at1 walked 0x00..0x3f, at3 fixed at 0x01', 0x01, 'at1');
    const U08 = await sweepAxis('U(D=0x08) — at1 walked 0x00..0x3f, at3 fixed at 0x08', 0x08, 'at1');
    const U00 = await sweepAxis('U(D=0x00) — at1 walked 0x00..0x3f, at3 fixed at 0x00 (the plain eid sweep)', 0x00, 'at1');

    // ── the verdict ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── translation test (mismatch over the rows where both sides exist) ──');
    // The null is NOT "one over the number of tokens": the token distribution is dominated by one value, so
    // the honest chance level is the probability that two independent draws agree, sum(p_i^2).
    const pool = [...V46, ...V3a, ...U01, ...U08, ...U00];
    const freq = new Map<string, number>();
    for (const t of pool) freq.set(t, (freq.get(t) ?? 0) + 1);
    const chance = [...freq.values()].reduce((s, n) => s + (n / pool.length) ** 2, 0);
    console.log(`   in-run chance calibration: ${freq.size} distinct tokens across ${pool.length} readings → two independent draws agree with probability sum(p²) = ${chance.toFixed(3)}`);
    // Reference: the SAME axis read twice with at3 changed measures how much at3 perturbs the at1 axis.
    for (const [label, u, v] of [['U(0x01) vs U(0x00) — same axis, at3 moved', U01, U00], ['U(0x08) vs U(0x01) — same axis, both at3 non-zero', U08, U01]] as const) {
      const t = translation(u, v);
      if (t) console.log(`   ${label}: best Delta=${String(t.delta).padStart(3)}  mismatch=${t.mismatch}/${t.overlap} (ratio ${(t.mismatch / t.overlap).toFixed(3)})`);
    }
    for (const [label, u, v, E, D] of [
      ['U(0x01) vs V(0x46)', U01, V46, 0x46, 0x01],
      ['U(0x08) vs V(0x46)', U08, V46, 0x46, 0x08],
      ['U(0x01) vs V(0x3a)', U01, V3a, 0x3a, 0x01],
      ['U(0x08) vs V(0x3a)', U08, V3a, 0x3a, 0x08],
    ] as const) {
      const t = translation(u, v);
      if (!t) { console.log(`   ${label}: not enough overlap to test`); continue; }
      const ratio = t.mismatch / t.overlap;
      const verdict = t.mismatch === 0 && t.overlap >= 32
        ? `H_FLAT (a shift matches exactly${t.delta === D - E ? ', and it is exactly D-E' : `, but the shift is ${t.delta} NOT D-E=${D - E}`})`
        : ratio >= 0.5 ? 'H_TWO (at chance — the two axes are unrelated)' : 'H_PART (partial match; publish no verdict)';
      console.log(`   ${label}: best Delta=${String(t.delta).padStart(3)}  mismatch=${t.mismatch}/${t.overlap} (ratio ${ratio.toFixed(3)})  → ${verdict}`);
    }

    if (!withScene) {
      console.log('\nSTABILITY half NOT run: it needs a scene change (`fn=0x0c`), which is a WRITE to the unit.');
      console.log('Re-run with --with-scene once that is approved. Read-only otherwise: nothing was written.');
      return 0;
    }
    console.log('\n(the scene arm would go here — see the README for the anchor set and the 4-stage design)');
    return 0;
  } finally {
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
