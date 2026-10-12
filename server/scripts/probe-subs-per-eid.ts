// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-subs-per-eid — decode-by-falsification of the two ADDRESS-DEPENDENT `fn=0x01` sub-actions
// `0x03` and `0x1b`. Both answered 23 bytes in the 2026-10-12 sweep, and both read differently for
// different address bytes, so each carries *something* addressed. This asks WHICH something.
//
// ALREADY MEASURED (fixture `test/fixtures/query-subs/fm3-query-subs.tap`, no new hardware):
//   sub 0x03 with address `01 3a …` → data `1d 76`;  with `00 3a …` or all zeros → all zeros.
//   So byte 7 (the leading address byte) is load-bearing — it is not a plain echo of the eid.
//
// HYPOTHESES AND THEIR PREDICTIONS — written BEFORE any frame is sent. They predict DIFFERENT data for
// the exact rows this probe sets, which is the only thing that makes them worth running:
//
//   H1  REQUEST ECHO. The reply's data bytes are a function of the request bytes alone (address +
//       checksum). PREDICTS: the reply for a given (sub, byte7, eid) is byte-identical across every
//       repetition of that request, INCLUDING before and after a bypass toggle on that eid.
//   H2  PER-EID LIVE STATE. The reply carries live state of the addressed block. PREDICTS: toggling
//       bypass on one eid CHANGES that eid's reply and LEAVES every other eid's reply untouched; the
//       restore returns it to the original bytes.
//   H3  PLACEMENT FLAG. The reply says only whether a block sits at that eid. PREDICTS: placed eids
//       differ from unplaced eids, and a bypass toggle (which does not move a block) changes NOTHING.
//
// H2 and H3 are separated by the bypass arm — that is its whole purpose. H1 and H3 are separated by the
// before/after byte-identity of unchanged eids.
//
// The instrument is validated in-run: the fn=0x13 status dump must list placed blocks (else the whole
// premise "we know the device state" fails), and a NEGATIVE CONTROL sub (`0x99`, never answered) must
// stay silent. A silent negative control that is silent for the wrong reason would make every "all
// zeros" reading below meaningless.
//
// SAFETY. The sweep is READ-ONLY. The bypass arm writes ONE block's bypass and RESTORES it, then proves
// the restore through a DIFFERENT path (the fn=0x13 status dump) than the one that read the original.
// A failed restore exits 6 with the eid and the value it could not restore.
//
// USAGE  npx tsx scripts/probe-subs-per-eid.ts [--port /dev/ttyACM0] [--write] [--eid 0x2a]
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { fractalChecksum } from 'forgefx-midi/shared';

const MODEL = 0x11;
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `fn=0x01` read frame with the sub-action and the 5-byte address region. */
function addrQuery(sub: number, at: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, 0x01, sub, ...at];
  while (body.length < 20) body.push(0x00);
  return [...body, fractalChecksum(body), 0xf7];
}

/** The 23-byte reply's payload, or null when nothing came back. */
function payload(frames: readonly number[][], sub: number): number[] | null {
  const f = frames.find((x) => x[5] === 0x01 && x[6] === sub && x.length <= 100 && x.length > 10);
  return f ? f.slice(7, -1) : null;
}

export async function main(argv: string[]): Promise<number> {
  const arg = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const port = arg('--port');
  const doWrite = argv.includes('--write');
  const forceEid = arg('--eid') !== undefined ? parseInt(arg('--eid')!, 16) : undefined;
  if (arg('--tap')) process.env.FORGEFX_TAP = arg('--tap')!;
  const opened = await openProbeSession(MODEL, port);
  if (!opened.ok) { console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`); return 3; }
  const { session } = opened;
  try {
    console.log(`device ${session.label} · sub 0x03/0x1b per-eid sweep${doWrite ? ' + bypass arm' : ' (read-only)'}`);
    console.log('predictions (written before any frame was sent):');
    console.log('  H1 request-echo:  same (sub, byte7, eid) ⇒ byte-identical data, before AND after a bypass toggle');
    console.log('  H2 live state:    bypassing eid X changes ONLY X\'s reply; restore returns the exact original bytes');
    console.log('  H3 placement:     placed ≠ unplaced, but a bypass toggle changes nothing');

    // ── instrument validation, in-run ─────────────────────────────────────────────────────────────
    const state = (await session.driver.sceneState?.()) ?? [];
    const placed = state.map((s) => s.effectId).sort((a, b) => a - b);
    console.log(`\nfn=0x13 status dump (the path that says what is placed): ${placed.map((e) => '0x' + e.toString(16)).join(' ')}`);
    if (!placed.length) { console.log('no placed blocks reported — the premise "we know the device state" fails; stopping.'); return 2; }
    const bypassOf = new Map(state.map((s) => [s.effectId, s.bypassed]));

    const negFrames = await session.transport.request(addrQuery(0x99, [0x01, 0x3a, 0, 0, 0]), { timeoutMs: 900, quietMs: 60 });
    const neg = negFrames.filter((f) => f[5] === 0x01 && f[6] === 0x99);
    console.log(`negative control sub 0x99 → ${neg.length ? 'ANSWERED (unexpected)' : 'SILENT'}  (expected silence: on this device an unimplemented sub does not answer)`);

    const UNPLACED = [0x36, 0x32, 0x56, 0x62].filter((e) => !placed.includes(e)).slice(0, 2);
    const eids = [...placed, ...UNPLACED];

    // ── the sweep ─────────────────────────────────────────────────────────────────────────────────
    const read = async (sub: number, sel: number, eid: number): Promise<number[] | null> =>
      payload(await session.transport.request(addrQuery(sub, [sel, eid, 0, 0, 0]), { timeoutMs: 900, quietMs: 60 }), sub);

    for (const sub of [0x03, 0x1b]) {
      console.log(`\n=== sub 0x${sub.toString(16).padStart(2, '0')} — address byte 7 ∈ {00, 01} × eid ===`);
      console.log('  eid    placed  sel=00                              sel=01');
      for (const eid of eids) {
        const p0 = await read(sub, 0x00, eid);
        const p1 = await read(sub, 0x01, eid);
        const isPlaced = placed.includes(eid);
        const fmt = (p: number[] | null) => (p === null ? '(silent)'.padEnd(24) : hex(p).padEnd(24));
        console.log(`  0x${eid.toString(16).padStart(2, '0')}   ${String(isPlaced).padEnd(6)}  ${fmt(p0)}  ${fmt(p1)}`);
      }
    }

    // ── repeatability (the H1/H3 separator) ───────────────────────────────────────────────────────
    console.log('\nrepeatability — the SAME request twice, for a placed and an unplaced eid:');
    for (const eid of [placed[0]!, UNPLACED[0]!]) {
      const a1 = await read(0x03, 0x01, eid);
      const a2 = await read(0x03, 0x01, eid);
      console.log(`  0x${eid.toString(16)}: 0x03[01] ${hex(a1 ?? [])} vs ${hex(a2 ?? [])} → ${hex(a1 ?? []) === hex(a2 ?? []) ? 'IDENTICAL' : 'DIFFERENT'}`);
    }

    if (!doWrite) {
      console.log('\nread-only: the bypass arm is behind --write (it writes one block\'s bypass and restores it).');
      return 0;
    }

    // ── DRIFT CONTROL — mandatory, and it runs FIRST ──────────────────────────────────────────────
    //
    // A reply that moves when you write is only evidence of state if it does NOT move when you don't.
    // The first run of this arm read `6f → 70 → 71` across before/during/after and an unrelated eid moved
    // with no write anywhere near it — i.e. the channel drifts on its own and the arm would have "proved"
    // state from noise. So the no-write baseline is measured on the SAME eids, in the SAME connection,
    // immediately before the arm, and the arm is only read as evidence when the baseline is stable.
    const eid = forceEid ?? placed.find((e) => e !== 0x3a)!;
    const driftTargets = [eid, ...placed.filter((o) => o !== eid).slice(0, 2)];
    console.log('\ndrift control — 3 consecutive reads with NOTHING written (sub 0x03[01] and 0x1b[00]):');
    let channelStable = true;
    for (const t of driftTargets) {
      const a: string[] = [], b: string[] = [];
      for (let i = 0; i < 3; i++) { a.push(hex((await read(0x03, 0x01, t)) ?? [])); b.push(hex((await read(0x1b, 0x00, t)) ?? [])); }
      const sa = new Set(a).size, sb = new Set(b).size;
      if (sa > 1 || sb > 1) channelStable = false;
      console.log(`  0x${t.toString(16).padStart(2, '0')}: 0x03[01] ${new Set(a).size}/3 distinct → ${sa === 1 ? 'STABLE' : 'DRIFTS'}  ·  0x1b[00] ${new Set(b).size}/3 distinct → ${sb === 1 ? 'STABLE' : 'DRIFTS'}`);
      if (sa > 1) console.log(`      ${[...new Set(a)].join(' | ')}`);
      if (sb > 1) console.log(`      ${[...new Set(b)].join(' | ')}`);
    }
    if (!channelStable) {
      console.log('  ⇒ THE CHANNEL DRIFTS WITH NO WRITE. A before/during/after comparison cannot attribute any');
      console.log('    change to the bypass — the arm is INCONCLUSIVE by construction. Recording that rather than a verdict.');
    }

    // ── the bypass arm, as N reads per stage ──────────────────────────────────────────────────────
    //
    // One read per stage cannot separate "the write moved it" from "reads move it": the first version of
    // this arm saw `6f → 70 → 71` and could not tell which. N reads per stage can — a stage that is stable
    // within itself is a baseline, and a step between stages is then attributable to the WRITE between
    // them. N defaults to 1 for the old behaviour; the wide form is `--reads 5`.
    const N = Math.max(1, Number(arg('--reads') ?? 1));
    const readSet = async (sub: number, sel: number, t: number): Promise<string[]> => {
      const out: string[] = [];
      for (let i = 0; i < N; i++) out.push(hex((await read(sub, sel, t)) ?? []));
      return out;
    };
    const stage = (label: string, set: string[]): void => {
      const u = [...new Set(set)];
      console.log(`  ${label.padEnd(12)} ${u.length === 1 ? 'STABLE' : `DRIFTS ${u.length}/${set.length}`}  ${u.join(' | ')}`);
    };
    const beforeSet = await readSet(0x03, 0x01, eid);
    const before1bSet = await readSet(0x1b, 0x01, eid);
    const before = beforeSet[0]!;
    const before1b = before1bSet[0]!;
    const othersBefore = new Map<number, string>();
    for (const o of placed) if (o !== eid) othersBefore.set(o, hex((await read(0x03, 0x01, o)) ?? []));
    const wasBypassed = bypassOf.get(eid);
    console.log(`\n=== bypass arm on eid 0x${eid.toString(16)} (status dump says bypassed=${wasBypassed}) ===`);

    if (wasBypassed === undefined) { console.log('cannot read the eid\'s bypass state — refusing to write; nothing changed.'); return 2; }
    const target = !wasBypassed;
    console.log(`  WRITE setBypass(0x${eid.toString(16)}, ${target})  — will restore to ${wasBypassed}`);
    const w = await session.driver.setBypass?.(eid, target);
    await sleep(400);
    const duringSet = await readSet(0x03, 0x01, eid);
    const during1bSet = await readSet(0x1b, 0x01, eid);

    // restore + prove it through a DIFFERENT path than the one that read the original
    const r = await session.driver.setBypass?.(eid, wasBypassed);
    await sleep(400);
    const afterSet = await readSet(0x03, 0x01, eid);
    const after1bSet = await readSet(0x1b, 0x01, eid);
    const stateNow = (await session.driver.sceneState?.()) ?? [];
    const restoredState = stateNow.find((s) => s.effectId === eid)?.bypassed;
    console.log('\n  per-stage reads (sub 0x03[01] / 0x1b[01]) on eid 0x' + eid.toString(16) + `, ${N} reads per stage:`);
    stage('before', beforeSet);
    console.log(`  -- WRITE setBypass(${target}) --`);
    stage('during', duringSet);
    console.log(`  -- WRITE setBypass(${wasBypassed}) --`);
    stage('after', afterSet);
    stage('0x1b before', before1bSet);
    stage('0x1b during', during1bSet);
    stage('0x1b after', after1bSet);
    const during = duringSet[0]!;
    const after = afterSet[0]!;
    console.log(`  write results: ${JSON.stringify(w)} / restore ${JSON.stringify(r)}`);
    console.log(`  restore proof via the fn=0x13 status dump (a DIFFERENT path): bypassed=${restoredState} (was ${wasBypassed}) → ${restoredState === wasBypassed ? 'RESTORED' : 'NOT CONFIRMED'}`);

    // Set-level comparison: with N reads per stage the question is whether the SET of values moved between
    // the stages, not whether one read differs from another (which is the noise this design exists to kill).
    const key = (s: readonly string[]) => [...new Set(s)].sort().join(' | ');
    const stableBefore = new Set(beforeSet).size === 1;
    const changed = key(beforeSet) !== key(duringSet);
    const reverted = key(beforeSet) === key(afterSet);
    console.log(`\n  OBSERVATION for 0x03: before/during/after = ${before} / ${during} / ${after}`);
    console.log(`    the toggle ${changed ? 'moved' : 'did not move'} the reply; the restore ${reverted ? 'returned it byte-identical' : 'DID NOT return the original bytes'}`);
    // The verdict is gated on the drift control. Without a stable baseline, a move is unattributable, and
    // "changed" must NOT be upgraded into "carries live state" — that is the error this control exists for.
    if (!channelStable || !stableBefore) {
      console.log('  VERDICT for 0x03: INCONCLUSIVE — the no-write baseline drifts, so the move cannot be attributed to the bypass.');
      console.log('    (A NICER experiment is named rather than guessed: N reads before, toggle, N reads after, compare the two sets.)');
    } else if (changed && reverted) {
      console.log('  VERDICT for 0x03: H2 (per-eid live state) SUPPORTED — the toggle moved the reply and the restore returned it exactly.');
    } else if (!changed) {
      console.log('  VERDICT for 0x03: H1/H3 survive — 0x03 does not carry this block\'s bypass state.');
    } else {
      console.log('  VERDICT for 0x03: the toggle moved the reply but the restore did NOT return it — neither H2 nor H1 fits; do not publish a reading.');
    }
    const changed1b = before1b !== (during1bSet[0] ?? '');
    console.log(`  OBSERVATION for 0x1b: bypass toggle ${changed1b ? 'CHANGED' : 'did NOT change'} the reply${channelStable ? '' : ' (baseline itself may drift)'}`);

    // H2 predicts the toggle touches ONLY the eid's own reply. Compared against the bytes captured before
    // the write, not against a second read taken now — a second read now would compare the state to itself.
    let othersMoved = 0;
    for (const o of placed) {
      if (o === eid) continue;
      const now = hex((await read(0x03, 0x01, o)) ?? []);
      if (now !== othersBefore.get(o)) { othersMoved++; console.log(`    eid 0x${o.toString(16)} moved: ${othersBefore.get(o)} → ${now}`); }
    }
    console.log(`  other eids whose 0x03 reply moved across the arm: ${othersMoved} (H2 predicts 0)`);

    if (restoredState !== wasBypassed) { console.log(`!! RESTORE NOT CONFIRMED for eid 0x${eid.toString(16)} — it should be bypassed=${wasBypassed}. Check the unit.`); return 6; }
    console.log('  restore confirmed; the unit is back as it was.');
    return 0;
  } finally {
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
