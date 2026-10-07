// Offline proof for scripts/probe-device.ts — the one-command runbook for the five open FM3 hardware
// questions. NO hardware: the script's own scripted-device mode (createMockSession) drives a
// MockTransport, and this suite proves the three safety properties the runbook must have:
//   (a) the read-only DEFAULT does not write, and reports determinate verdicts for the read probes;
//   (b) the --writes path RESTORES what it changed (Q1 brightness, Q2 cab mute) and reads back the
//       original value — a write probe that leaves the device changed is the whole risk of this tool;
//   (c) a MISSING device exits NON-ZERO rather than reporting success (a silent pass is impossible).
// It also pins that verdicts go BOTH ways (a plain-ordinal PHASER_ORDER reads as `does NOT match`) and
// that Q5's deliberate invalid write is refused with a 0x64 whose result code is decoded.
import {
  createMockSession,
  runDeviceProbes,
  DEVICE_PROBE_MODEL_DEFAULT,
  type ProbeReport
} from '../../scripts/probe-device.js';
import { decode5SeptetFloat32 } from 'forgefx-midi/gen3/axe-fx-iii';
import { assert, assertEqual } from '../helpers/mock.js';

export const DEVICE_PROBE_RUNBOOK_CASE_COUNT = 11;

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
    assertEqual(byId(report, 'Q5').status, 'skipped', 'read-only: Q5 (reject latency) is skipped');
    // case 3: an all-determinate eligible set (the two reads) exits 0.
    assertEqual(report.exitCode, 0, 'read-only run of determinate reads exits 0');
  }

  // ── (b) --writes restores what it changed ───────────────────────────────────────────────────────
  {
    const { session, mock } = createMockSession(MODEL);
    const report = await runDeviceProbes(session, { writes: true, log: noop });

    // case 4: every eligible probe gave a definite verdict → exit 0.
    const eligible = report.results.filter((r) => r.status !== 'skipped');
    assert(eligible.every((r) => r.status === 'determinate'), '--writes: every eligible probe is determinate');
    assertEqual(report.exitCode, 0, '--writes run with all verdicts exits 0');

    // case 5: Q1 wrote a nudge AND then wrote the ORIGINAL back — the last brightness write is the original.
    const gPid = byId(report, 'Q1'); // truthiness
    assert(gPid.restores.length === 1 && gPid.restores[0]!.restored, 'Q1 restore verified');
    const brightnessWrites = mock.sent.filter((f) => wrote(f, 1, 7115));
    assert(brightnessWrites.length >= 2, 'Q1 sent at least a write + a restore');
    const firstVal = valueOf(brightnessWrites[0]!);
    const lastVal = valueOf(brightnessWrites[brightnessWrites.length - 1]!);
    assert(Math.abs(firstVal - 0.6) < 0.02, `Q1 first write is the nudge (wrote ${firstVal})`);
    assert(Math.abs(lastVal - 0.5) < 0.02, `Q1 last write RESTORES the original 0.5 (wrote ${lastVal})`);
    // case 6: and the device really is back at the original — nothing left changed.
    const finalGlobal = (await session.driver.readParams!(1, [7115]))[7115];
    assert(Math.abs((finalGlobal ?? -1) - 0.5) < 0.02, 'Q1 left the global brightness at its original value');

    // case 7: Q2 restore verified, and the cab mute is back at its original ordinal.
    const q2 = byId(report, 'Q2');
    assert(q2.restores.length === 1 && q2.restores[0]!.restored, 'Q2 restore verified');
    const muteWrites = mock.sent.filter((f) => wrote(f, 62, 25));
    assert(muteWrites.length >= 2, 'Q2 sent at least a write + a restore');
    assertEqual(Math.round(valueOf(muteWrites[muteWrites.length - 1]!)), 0, 'Q2 last write RESTORES the original ordinal 0');

    // case 8: Q5's deliberate invalid write is refused with 0x64 and the verdict is definite.
    const q5 = byId(report, 'Q5');
    assertEqual(q5.verdict, 'matches the expectation', 'Q5 observed the 0x64 rejection');
  }

  // ── (c) a missing device exits NON-ZERO ─────────────────────────────────────────────────────────
  {
    const report = await runDeviceProbes(null, { writes: true, log: noop });
    // case 9: no silent pass — no device is exit code 3, never 0.
    assert(report.exitCode !== 0, 'a missing device exits non-zero');
    assertEqual(report.exitCode, 3, 'a missing device reports the dedicated "no device" exit code (3)');
    assertEqual(report.results.length, 0, 'a missing device attempts no probe');
  }

  // ── verdicts go both ways: a plain-ordinal PHASER_ORDER reads as does-NOT-match ─────────────────
  {
    const { session } = createMockSession(MODEL, { phaserOrderRaw: 3 }); // ordinal 3 ≤ displayMax 10
    const report = await runDeviceProbes(session, { writes: false, log: noop });
    // case 10: the scaled-enum probe must NOT claim a match when the device sends an ordinal.
    assertEqual(byId(report, 'Q3').verdict, 'does NOT match', 'an ordinal PHASER_ORDER reads as does-NOT-match');
  }

  // ── a silent link is indeterminate, never a pass ────────────────────────────────────────────────
  {
    const { session } = createMockSession(MODEL, { silent: true });
    const report = await runDeviceProbes(session, { writes: false, log: noop });
    // case 11: nothing answered → indeterminate → non-zero exit (a silent pass is impossible).
    assertEqual(byId(report, 'Q3').status, 'indeterminate', 'a silent link makes Q3 indeterminate');
    assert(report.exitCode !== 0, 'an all-indeterminate run exits non-zero');
  }
}
