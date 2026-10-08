// Offline proof for scripts/probe-device.ts — the one-command runbook for the five open FM3 hardware
// questions. NO hardware: the script's own scripted-device mode (createMockSession) drives a
// MockTransport, and this suite proves the safety properties the runbook must have:
//   (a) the read-only DEFAULT does not write, and reports determinate verdicts for the read probes;
//   (b) the --writes path RESTORES what it changed (Q1 brightness, Q2 cab mute) — and does NOT claim a
//       restore it cannot prove: the read-back shares the write path, so it is reported as UNPROVEN, not
//       "verified" (the defect that darkened a user's footswitch LEDs);
//   (c) a MISSING device exits NON-ZERO rather than reporting success (a silent pass is impossible);
//   (d) a captured original at an off/disabled boundary makes Q1 REFUSE to write (a misread there is
//       destructive) and send zero write frames;
//   (e) --writes --dry-run prints the plan, writes NOTHING, and exits 4 (never mistakable for a run).
// It also pins Q5's three mutually-exclusive outcomes (refused / accepted / silent — never a fabricated
// latency), the connection-failure wording (port + errno + class), that verdicts go BOTH ways, and that a
// silent link is indeterminate.
import {
  createMockSession,
  runDeviceProbes,
  formatReport,
  formatConnFailure,
  classifyOpenError,
  errnoName,
  DEVICE_PROBE_MODEL_DEFAULT,
  type ProbeReport,
  type ConnFailure,
  guardFirmwareFamily
} from '../../scripts/probe-device.js';
import { decode5SeptetFloat32 } from 'forgefx-midi/gen3/axe-fx-iii';
import { assert, assertEqual } from '../helpers/mock.js';

export const DEVICE_PROBE_RUNBOOK_CASE_COUNT = 26;

const MODEL = DEVICE_PROBE_MODEL_DEFAULT;
const noop = (): void => {};

const eidOf = (f: readonly number[]) => (f[8]! | (f[9]! << 7));
const pidOf = (f: readonly number[]) => (f[10]! | (f[11]! << 7));
/** A frame that could mutate the device (a write), as opposed to a read/poll. */
const isWrite = (f: readonly number[]) =>
  f[5] === 0x0a || f[5] === 0x0b || (f[5] === 0x01 && (f[6] === 0x09 || f[6] === 0x52));
const wrote = (f: readonly number[], eid: number, pid: number) =>
  f[5] === 0x01 && (f[6] === 0x09 || f[6] === 0x52) && eidOf(f) === eid && pidOf(f) === pid;
const valueOf = (f: readonly number[]) => decode5SeptetFloat32(f[12]!, f[13]!, f[14]!, f[15]!, f[16]!);

const byId = (report: ProbeReport, id: string) => {
  const r = report.results.find((x) => x.id === id);
  assert(r, `report has a ${id} result`);
  return r!;
};

export async function runDeviceProbeRunbookTests(): Promise<void> {
  // ── (a) read-only DEFAULT never writes ─────────────────────────────────────────────────────────
  {
    const { session, mock } = createMockSession(MODEL);
    const report = await runDeviceProbes(session, { writes: false, log: noop });
    // case 1: not a single mutating frame left the host.
    const writes = mock.sent.filter(isWrite);
    assertEqual(writes.length, 0, 'read-only default sends NO write frame');
    // case 2: the read probes still produced definite verdicts; the write probes are marked skipped.
    assertEqual(byId(report, 'Q3').status, 'determinate', 'read-only: Q3 (scaled enum) is attempted');
    assertEqual(byId(report, 'Q4').status, 'determinate', 'read-only: Q4 (padding) is attempted');
    assertEqual(byId(report, 'Q1').status, 'skipped', 'read-only: Q1 (global write) is skipped, not silently passed');
    assertEqual(byId(report, 'Q2').status, 'skipped', 'read-only: Q2 (cab mute write) is skipped');
    assertEqual(byId(report, 'Q5').status, 'skipped', 'read-only: Q5 (reject outcome) is skipped');
    // case 3: an all-determinate eligible set (the two reads) exits 0.
    assertEqual(report.exitCode, 0, 'read-only run of determinate reads exits 0');
  }

  // ── (b) --writes restores what it changed, but words the proof honestly ────────────────────────
  {
    const { session, mock } = createMockSession(MODEL);
    const report = await runDeviceProbes(session, { writes: true, log: noop });

    // case 4: every eligible probe gave a definite verdict → exit 0. Guard the set is non-empty FIRST:
    // `[].every(...)` is true, so without this the write path could report NO probes at all and still
    // pass. --writes attempts all five (Q1-Q5) and skips none, so the eligible set is exactly the results.
    const eligible = report.results.filter((r) => r.status !== 'skipped');
    assert(eligible.length > 0, '--writes attempted at least one probe (an empty set must not pass vacuously)');
    assertEqual(eligible.length, report.results.length, '--writes skips NO probe — every result is eligible');
    assert(eligible.every((r) => r.status === 'determinate'), '--writes: every eligible probe is determinate');
    assertEqual(report.exitCode, 0, '--writes run with all verdicts exits 0');

    // case 5: Q1 wrote a nudge AND then wrote the ORIGINAL back — the last brightness write is the original.
    const gPid = byId(report, 'Q1'); // truthiness
    const brightnessWrites = mock.sent.filter((f) => wrote(f, 1, 7115));
    assert(brightnessWrites.length >= 2, 'Q1 sent at least a write + a restore');
    const firstVal = valueOf(brightnessWrites[0]!);
    const lastVal = valueOf(brightnessWrites[brightnessWrites.length - 1]!);
    assert(Math.abs(firstVal - 0.6) < 0.02, `Q1 first write is the nudge (wrote ${firstVal})`);
    assert(Math.abs(lastVal - 0.5) < 0.02, `Q1 last write RESTORES the original 0.5 (wrote ${lastVal})`);

    // case 6: the restore record carries the FULL evidence and does NOT claim an independent restore —
    // the only read-back shares the write path, so `restored` is false and it is reported UNPROVEN.
    const rec = gPid.restores[0]!;
    assert(rec, 'Q1 recorded a restore');
    assertEqual(rec.matchesOriginal, true, 'Q1 read-back matches the original');
    assertEqual(rec.independentlyConfirmed, false, 'Q1 restore is NOT independently confirmed (same read path)');
    assertEqual(rec.restored, false, 'Q1 restore is NOT claimed as verified');
    assert(rec.readPath.length > 0 && rec.originalSource.length > 0, 'Q1 restore records the read path + source');
    assertEqual(gPid.restoreFailures.length, 0, 'Q1 is UNPROVEN, not a FAILED restore (read-back matched)');
    assert((gPid.restoreUnproven ?? []).length === 1, 'Q1 is flagged in the UNPROVEN-RESTORE list');
    // case 7: and the device really is back at the original — nothing left changed.
    const finalGlobal = (await session.driver.readParams!(1, [7115]))[7115];
    assert(Math.abs((finalGlobal ?? -1) - 0.5) < 0.02, 'Q1 left the global brightness at its original value');

    // case 8: Q2 restore is worded the same honest way, and the cab mute is back at its original ordinal.
    const q2 = byId(report, 'Q2');
    assertEqual(q2.restores[0]!.restored, false, 'Q2 restore is NOT claimed as verified');
    assertEqual(q2.restores[0]!.matchesOriginal, true, 'Q2 read-back matches the original');
    assert((q2.restoreUnproven ?? []).length === 1, 'Q2 is flagged in the UNPROVEN-RESTORE list');
    // Q5 arm 2 writes this same param afterwards (deliberately out of range), so this cannot assert on the
    // LAST cab-mute write any more — it asserts on Q2's own pair: the new ordinal, then the restore.
    const muteWrites = mock.sent.filter((f) => wrote(f, 62, 25)).map((f) => Math.round(valueOf(f)));
    assert(muteWrites.length >= 2, 'Q2 sent at least a write + a restore');
    const wroteNew = muteWrites.indexOf(1);
    assert(wroteNew >= 0, 'Q2 wrote the new ordinal');
    assertEqual(muteWrites[wroteNew + 1], 0, 'Q2 RESTORES the original ordinal 0 right after its write');

    // case 9: the printed report says what it actually established — never a bare "restore verified".
    const text = formatReport(report);
    assert(text.includes('independent confirmation NOT established'), 'report words the same-path read-back honestly');
    assert(text.includes('UNPROVEN-RESTORE'), 'report prints the UNPROVEN-RESTORE block');
    assert(!text.includes('restore VERIFIED'), 'report never claims an independent restore it did not get');
    assert(text.includes('read-back echoes the write on the SAME read path'), 'report names the echo-only proof');
    // case 10: the verdict table states the human-visible check for each mutating probe.
    assert(text.includes('human check: Mini-display + footswitch LED-ring brightness'), 'Q1 lists its human check');
    assert(text.includes('human check: Cab 2 Mute/Solo should be back'), 'Q2 lists its human check');
  }

  // ── Q5: a REFUSED write is answered with a 0x64, and the latency to it is MEASURED ─────────────
  // The question is framed on the refusal the 250 ms write-confirm window must cover, so arm 2 (a real
  // param written out of range) is the arm that answers it — arm 1 (a bogus eid) is kept because "the FM3
  // ignores an unknown eid" is itself a measured fact, and because it is exactly why the framing changed.
  {
    const { session } = createMockSession(MODEL, { rejectDelayMs: 30 });
    const report = await runDeviceProbes(session, { writes: true, log: noop });
    // case 11: a real 0x64 arrives → the refusal outcome, with the latency measured to THAT frame.
    const q5 = byId(report, 'Q5');
    assertEqual(q5.outcome, 'refused', 'Q5 reports the refused outcome');
    assertEqual(q5.verdict, 'matches the expectation', 'Q5 refusal matches the expectation');
    assert(typeof q5.latencyMs === 'number' && q5.latencyMs! >= 25, `Q5 measures the latency to the 0x64 (got ${q5.latencyMs})`);
    // The ARRIVAL is what a confirmation window must cover, and it is measured by the probe: the
    // transport resolves on a quiet gap, so its own timing is when the poll gave up, not when the device
    // answered — reporting the latter as the latency would be exactly the fabrication Q5 guards against.
    assert(/arrived \d+ ms after the write/.test(q5.observation), 'Q5 observation reports the measured ARRIVAL of the 0x64');
    assert(q5.observation.includes('arrival measured by the probe'), 'Q5 says how the arrival was measured');
    assert(q5.observation.includes('arm 1') && q5.observation.includes('arm 2'), 'Q5 observation reports BOTH arms');
    assert(q5.question.includes('250 ms'), 'Q5 asks the question the confirmation window depends on');
  }

  // ── Q5 arm 1 SILENT (the real FM3 behaviour for a bogus eid) — arm 2 still answers the question ──
  {
    const { session } = createMockSession(MODEL, { invalidWrite: 'ignore', rejectDelayMs: 30 });
    const report = await runDeviceProbes(session, { writes: true, log: noop });
    // case 12: arm 1 measures nothing, and is REPORTED as having measured nothing — while arm 2's refusal
    // is the measurement the probe carries.
    const q5 = byId(report, 'Q5');
    assert(q5.observation.includes('arm 1 (unknown eid') && /arm 1 \(unknown eid \d+\) SILENT/.test(q5.observation), 'Q5 reports arm 1 as silent, not as a latency');
    assert(!/arm 1 \(unknown eid \d+\) REFUSED/.test(q5.observation), 'Q5 does not claim arm 1 was refused');
    assertEqual(q5.outcome, 'refused', 'Q5 carries arm 2\'s refusal as THE outcome when arm 1 was silent');
    assert(typeof q5.latencyMs === 'number' && q5.latencyMs! >= 25, 'Q5 latency comes from the arm that produced a frame');
  }

  // ── Q5: BOTH arms silent → the distinct silent outcome, NOT a match and NOT a fabricated latency ──
  {
    const { session } = createMockSession(MODEL, { invalidWrite: 'ignore', outOfRangeWrite: 'ignore' });
    const report = await runDeviceProbes(session, { writes: true, log: noop });
    // case 13: nothing arrived in either arm → silence is a definite finding, and it is not a pass.
    const q5 = byId(report, 'Q5');
    assertEqual(q5.outcome, 'silent', 'Q5 reports the distinct silent outcome');
    assertEqual(q5.verdict, 'silent (no reply)', 'Q5 verdict is the distinct silent verdict, not a match');
    assert(q5.verdict !== 'matches the expectation', 'Q5 silent verdict is not a match');
    assertEqual(q5.latencyMs, undefined, 'Q5 reports NO latency when nothing was measured');
    assert(!/\blatency \d/.test(q5.observation), 'Q5 observation carries no fabricated latency number');
    assertEqual(q5.status, 'determinate', 'Q5 silent is a definite observation');
  }

  // ── Q5 arm 2 CLAMPED: the write SUCCEEDS and the setting changes — the read-back must prove it ────
  {
    const { session } = createMockSession(MODEL, { invalidWrite: 'ignore', outOfRangeWrite: 'clamp' });
    const report = await runDeviceProbes(session, { writes: true, log: noop });
    // case 14: the device stored the out-of-range value instead of refusing → that is NOT a match, the
    // read-back is what says so, and the original is restored (with the restore recorded, not assumed).
    const q5 = byId(report, 'Q5');
    assertEqual(q5.outcome, 'silent', 'Q5 reports the WIRE truth: nothing arrived in arm 2');
    assertEqual(q5.verdict, 'does NOT match', 'the read-back overrides wire silence: a stored value was NOT a refusal');
    assert(q5.observation.includes('stored/clamped'), 'Q5 observation states the value was stored/clamped');
    assert(q5.observation.includes('NOT silence-as-ignored'), 'Q5 says why wire silence is not "ignored" here');
    assertEqual(q5.restores.length, 1, 'Q5 records the restore of the changed real setting');
    assertEqual(q5.restores[0]!.matchesOriginal, true, 'Q5 restores the original value and reads it back');
  }

  // ── Q5: a non-0x64 reply arrives → accepted (the write was NOT refused) ─────────────────────────
  {
    const { session } = createMockSession(MODEL, { invalidWrite: 'accept', outOfRangeWrite: 'clamp' });
    const report = await runDeviceProbes(session, { writes: true, log: noop });
    // case 15: a reply arrived but it was not a refusal, in either arm.
    const q5 = byId(report, 'Q5');
    // "not-refused", never "accepted": no 0x64 says only that the write was not refused, and this repo's
    // own lesson is that the absence of a refusal is not an acceptance.
    assertEqual(q5.outcome, 'not-refused', 'Q5 reports the not-refused (no 0x64) outcome');
    assertEqual(q5.verdict, 'does NOT match', 'Q5 not-refused does NOT match the refusal expectation');
    assert(q5.observation.includes('NOT REFUSED'), 'Q5 observation names the not-refused arm');
    assert(q5.observation.includes('NOT evidence the value was stored'), 'Q5 does not let a non-refusal reply read as acceptance');
  }

  // ── the FIRMWARE-FAMILY guard: a blind probe of this family left the unit in its bootloader ─────
  {
    // case 15a: the guard refuses by DEFAULT. This is the regression test for the 2026-10-08 incident —
    // fn 0x7D/0x7E/0x7F/0x79 are firmware-update opcodes, not runtime ones, and probing them left the unit
    // showing "Updating Firmware / Transfer Error" until it was power-cycled.
    const sent: number[][] = [];
    const fake = {
      label: 'fake', kind: 'serial' as const, slow: false, isOpen: true,
      open: async () => {}, close: async () => {}, sendQueued: async () => {}, onFrame: () => () => {},
      send: (b: readonly number[]) => { sent.push([...b]); },
      request: async (b: readonly number[]) => { sent.push([...b]); return []; }
    };
    guardFirmwareFamily(fake as never, []);
    let refused = false;
    try { await fake.request([0xf0, 0x00, 0x01, 0x74, 0x11, 0x7e, 0x00, 0xf7]); } catch { refused = true; }
    assert(refused, 'the guard REFUSES a firmware-family fn by default');
    assertEqual(sent.length, 0, 'a refused frame is not sent at all');
    let refusedSend = false;
    try { fake.send([0xf0, 0x00, 0x01, 0x74, 0x11, 0x7d, 0x00, 0xf7]); } catch { refusedSend = true; }
    assert(refusedSend, 'the guard also covers the fire-and-forget send path');
    // case 15b: an ordinary runtime function is NOT blocked — the guard must not break normal probing.
    await fake.request([0xf0, 0x00, 0x01, 0x74, 0x11, 0x01, 0x4b, 0x00, 0xf7]);
    assertEqual(sent.length, 1, 'a normal fn=0x01 frame passes the guard untouched');
    // case 15c: the explicit override allows it, and says so out loud.
    const sent2: number[][] = [];
    const fake2 = { ...fake, send: (b: readonly number[]) => { sent2.push([...b]); }, request: async (b: readonly number[]) => { sent2.push([...b]); return []; } };
    guardFirmwareFamily(fake2 as never, ['--allow-firmware-family']);
    await fake2.request([0xf0, 0x00, 0x01, 0x74, 0x11, 0x7e, 0x00, 0xf7]);
    assertEqual(sent2.length, 1, '--allow-firmware-family lets the frame through');
  }

  // ── (c) a missing device exits NON-ZERO ─────────────────────────────────────────────────────────
  {
    const report = await runDeviceProbes(null, { writes: true, log: noop });
    // case 15: no silent pass — no device is exit code 3, never 0.
    assert(report.exitCode !== 0, 'a missing device exits non-zero');
    assertEqual(report.exitCode, 3, 'a missing device reports the dedicated "no device" exit code (3)');
    assertEqual(report.results.length, 0, 'a missing device attempts no probe');
  }

  // ── (connection) the failure NAMES the port + errno + which of the three classes ────────────────
  {
    // case 16: a permission error on a PRESENT port is not-openable, names the port and EACCES.
    const f = classifyOpenError('/dev/ttyACM0', new Error('Permission denied, cannot open /dev/ttyACM0'));
    assertEqual(f.cls, 'not-openable', 'a present-but-unopenable port classifies as not-openable');
    assertEqual(f.port, '/dev/ttyACM0', 'the failure names the port');
    assertEqual(f.errno, 'EACCES', 'the failure names the errno (EACCES from the message)');
    const msg = formatConnFailure(f);
    assert(msg.includes('/dev/ttyACM0'), 'the not-openable message names the port');
    assert(msg.includes('EACCES'), 'the not-openable message names the errno');
    assert(msg.includes('present but could not be opened'), 'the not-openable message states the class');
    // case 17: nothing enumerated → the no-ports class.
    const noPorts: ConnFailure = { cls: 'no-ports', detail: 'none present' };
    assert(formatConnFailure(noPorts).includes('no serial port was enumerated'), 'the no-ports message states the class');
    // case 18: the port opens but the device never answers → the unresponsive class.
    const unresponsive: ConnFailure = { cls: 'unresponsive', port: '/dev/ttyACM0', detail: 'no status-dump reply' };
    const umsg = formatConnFailure(unresponsive);
    assert(umsg.includes('/dev/ttyACM0') && umsg.includes('openable but unresponsive'), 'the unresponsive message names the port + class');
    // case 19: errnoName reads both a numeric errno AND a code string.
    assertEqual(errnoName({ errno: -13 }), 'EACCES', 'errnoName maps a numeric errno');
    assertEqual(errnoName({ code: 'ENOENT' }), 'ENOENT', 'errnoName passes a code string through');
  }

  // ── (d) an off/disabled boundary original makes Q1 REFUSE to write ──────────────────────────────
  {
    const { session, mock } = createMockSession(MODEL, { globalBrightness: 0 });
    const report = await runDeviceProbes(session, { writes: true, log: noop });
    // case 20: the captured original (0 on a 0..100 brightness param) is treated as a hazard, not truth.
    const q1 = byId(report, 'Q1');
    assert(q1.hazard, 'Q1 flags the boundary original as a hazard');
    assertEqual(q1.verdict, 'cannot determine', 'Q1 refuses (indeterminate), it does not guess');
    assert(q1.observation.includes('destroying a real value'), 'Q1 says why it refused');
    // case 21: NO brightness write left the host — a misread 0 could not be written back over a real value.
    assertEqual(mock.sent.filter((f) => wrote(f, 1, 7115)).length, 0, 'Q1 wrote NOTHING for the hazardous param');
    // case 22: and a refusal is not a pass.
    assert(report.exitCode !== 0, 'a refused hazardous write is not a success');
  }

  // ── (e) --dry-run: plan only, zero writes, exit 4 ───────────────────────────────────────────────
  {
    const { session, mock } = createMockSession(MODEL);
    const report = await runDeviceProbes(session, { writes: true, dryRun: true, log: noop });
    // case 23: dry-run sends ZERO write frames of any kind.
    assertEqual(mock.sent.filter(isWrite).length, 0, 'dry-run sends NO write frame at all');
    // case 24: its exit code cannot be mistaken for a completed run.
    assertEqual(report.exitCode, 4, 'dry-run exits 4, distinct from 0/2/3');
    assert(report.exitCode !== 0, 'dry-run is never a success');
    // case 25: each mutating probe carries a plan naming the param + eid/pid + original/write/restore.
    const p1 = byId(report, 'Q1').plan;
    assert(p1, 'Q1 has a dry-run plan');
    assertEqual(p1!.eid, 1, 'Q1 plan names the eid');
    assertEqual(p1!.original, '0.5000', 'Q1 plan names the captured original');
    assertEqual(p1!.wouldWrite, '0.6000', 'Q1 plan names the value that WOULD be written');
    assertEqual(p1!.wouldRestore, '0.5000', 'Q1 plan names the value that WOULD be restored');
    assert(byId(report, 'Q2').plan, 'Q2 has a dry-run plan');
    assert(byId(report, 'Q5').plan, 'Q5 has a dry-run plan');
    const text = formatReport(report);
    assert(text.includes('plan (dry-run):'), 'the report prints the dry-run plan');
    assert(text.includes('DRY-RUN — nothing was written; this is NOT a completed run'), 'the exit note is unmistakable');
  }

  // ── (f) dry-run at a boundary: the plan LOUDLY shows the hazard before anything is written ──────
  {
    const { session } = createMockSession(MODEL, { globalBrightness: 0 });
    const report = await runDeviceProbes(session, { writes: true, dryRun: true, log: noop });
    // case 26: the plan the user would have seen BEFORE the LEDs went dark.
    const p1 = byId(report, 'Q1').plan;
    assert(p1 && /^0(\.0+)?$/.test(p1.original), 'dry-run plan shows the boundary original (0) — the value the user must judge');
    assert(p1!.hazard, 'dry-run plan flags the off/disabled boundary');
    assert(formatReport(report).includes('⚠ HAZARD'), 'the report flags the hazard loudly');
  }

  // ── verdicts go both ways: a plain-ordinal PHASER_ORDER reads as does-NOT-match ─────────────────
  {
    const { session } = createMockSession(MODEL, { phaserOrderRaw: 3 }); // ordinal 3 ≤ displayMax 10
    const report = await runDeviceProbes(session, { writes: false, log: noop });
    assertEqual(byId(report, 'Q3').verdict, 'does NOT match', 'an ordinal PHASER_ORDER reads as does-NOT-match');
  }

  // ── a silent link is indeterminate, never a pass ────────────────────────────────────────────────
  {
    const { session } = createMockSession(MODEL, { silent: true });
    const report = await runDeviceProbes(session, { writes: false, log: noop });
    assertEqual(byId(report, 'Q3').status, 'indeterminate', 'a silent link makes Q3 indeterminate');
    assert(report.exitCode !== 0, 'an all-indeterminate run exits non-zero');
  }
}
