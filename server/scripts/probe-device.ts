// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-device — ONE command that answers the five open HARDWARE questions about the FM3 with a
// verdict table, safe by default.
//
// The questions (from Axis docs/review-2026-10-07 "Needs the hardware" + NEXT-STEPS):
//   Q1  Does the FM3 accept a GLOBAL write (e.g. GLOBAL_FS_BRIGHTNESS 7115) — i.e. read back what
//       we wrote? (Serving/rendering shipped; the write side was unverified.)
//   Q2  Is a Cab 2 Mute/Solo write accepted (the last handoff's unproven item, 285c11b)?
//   Q3  Does the FM3 ever send a 16-bit-scaled ENUM wire value (the PHASER_ORDER case)? Decides
//       whether the P2.3 decode is live or latent.
//   Q4  Does a COMPLETE block bulk read ever deliver MORE values than the 0x74 head advertises
//       (padding)? A fixed torn-read guard assumes values.length >= itemCount means complete.
//   Q5  How does the FM3 answer a write to an UNKNOWN effect id — a clean refusal (0x64), a
//       non-refusal reply, or NOTHING at all? The discrete-write confirm window is 250 ms, inherited
//       from the writer path and never measured; Q5 must never claim a rejection latency it did not
//       measure. (Observed on real hardware: an unknown eid draws no reply — the FM3 silently
//       ignores it rather than refusing it.)
//
// SAFETY. Default is READ-ONLY. Q3 and Q4 are pure reads. Q1, Q2 and Q5 need a WRITE; all three are
// behind --writes. The mutating probes (Q1, Q2) capture the original value, verify the write, then
// RESTORE the original value and verify the restore, printing loudly what they changed. If a restore
// cannot be verified they print a FAILED-RESTORE block naming the param and its original value so a
// human can fix it by hand. Q5 uses a deliberately INVALID write (a bogus effect id the device should
// refuse) so it changes no real setting; it is still behind --writes.
//
// Each probe prints the RAW observation AND a verdict (`matches the expectation` / `does NOT match` /
// `cannot determine`, plus Q5's distinct `silent (no reply)`) — never just a conclusion. Q5's
// observation is SINGLE-SOURCED: it prints the frames actually seen and the elapsed time to THOSE
// frames, and reports a latency only when a frame — never the poll timeout — was measured.
//
// EXIT CODES
//   0  every ELIGIBLE probe (a probe that the current mode could run) produced a definite verdict.
//   2  a device was reachable but an eligible probe could not produce a definite verdict
//      (cannot determine / not supported / no reply) — a silent pass is impossible.
//   3  nothing was attempted: no device could be opened. The failure names the port + errno and which of
//      three classes it was — no ports enumerated / port present but not openable / openable but
//      unresponsive — so a permission error is never mistaken for an absent device.
//   4  --writes --dry-run: a write plan was printed and NOTHING was written (never a success).
// Read-only mode deliberately SKIPS the write probes (Q1/Q2/Q5); a skipped-by-flag probe is not
// "eligible" and does not by itself fail the run.
//
// USAGE
//   npx tsx scripts/probe-device.ts                 # READ-ONLY against the auto-detected device
//   npx tsx scripts/probe-device.ts --writes        # also run the (self-restoring) write probes
//   npx tsx scripts/probe-device.ts --mock          # run the whole runbook offline, no hardware
//   npx tsx scripts/probe-device.ts --mock --writes # offline including the write probes
//   npx tsx scripts/probe-device.ts --model fm9     # target another gen-3 profile (fm3 default)
//   npx tsx scripts/probe-device.ts --port /dev/ttyACM0
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'node:url';
import { createGen3Driver } from '../src/drivers/gen3.js';
import { cadenceFor } from '../src/drivers/telemetryProfiles.js';
import { PROFILES, SLUG_FAMILY } from '../src/devices.js';
import { resolveConn, openConn } from '../src/transport/connection.js';
import type { Transport, Conn } from '../src/transport/types.js';
import type { DeviceDriver } from '../src/drivers/types.js';
import {
  createModernFractalCodec,
  packValue16,
  pack5Septet32,
  decode5SeptetFloat32,
  describeMultipurposeResultCode,
  type ModernFractalCodec
} from 'forgefx-midi/gen3/axe-fx-iii';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { MockTransport, hex } from '../test/helpers/mock.js';

// ── result shapes ───────────────────────────────────────────────────────────────────────────────

export type Verdict = 'matches the expectation' | 'does NOT match' | 'cannot determine' | 'silent (no reply)';
/** determinate = a definite verdict; indeterminate = eligible but no definite verdict;
 *  skipped = deliberately not run in this mode (read-only). */
export type ProbeStatus = 'determinate' | 'indeterminate' | 'skipped';

/** Q5: how the device answered a write to an UNKNOWN effect id — the three mutually-exclusive wire
 *  outcomes. `refused` = a 0x64 arrived; `accepted` = a (non-0x64) reply arrived; `silent` = nothing. */
export type RejectOutcome = 'refused' | 'accepted' | 'silent';

/** --dry-run only: what a mutating probe WOULD write and restore. Nothing is written in dry-run. */
export interface WritePlan {
  id: string;
  /** e.g. "GLOBAL_FS_BRIGHTNESS (eid 1, pid 7115)". */
  param: string;
  eid: number;
  pid: number;
  /** The value captured by the read half. */
  original: string;
  /** The value the probe would write. */
  wouldWrite: string;
  /** The value the probe would restore (the captured original). */
  wouldRestore: string;
  /** Set when the captured original sits at an off/disabled boundary — a hazard the human should see. */
  hazard?: string;
}

/**
 * A mutating probe's capture/restore record. It records the FULL evidence, not just a boolean: how the
 * original was captured, what was written back, what was read, and — critically — whether the read-back
 * is INDEPENDENT of the write path. A read-back on the SAME path that read the original cannot catch an
 * original that was misread, so it never proves the device was restored.
 */
export interface RestoreRecord {
  param: string;
  /** How/where the original was captured (fresh device read vs cached/layout value), with instance/channel. */
  originalSource: string;
  original: string;
  /** The value written back during the restore. */
  wroteBack: string;
  /** The value the device reported after the restore. */
  readBack: string;
  /** The path the read-back used. Equal to the original read path ⇒ the read-back echoes the write. */
  readPath: string;
  /** Raw: the read-back equals the captured original. Necessary but NOT sufficient to claim a restore. */
  matchesOriginal: boolean;
  /** The read-back was corroborated by a DIFFERENT path than the one that read the original. */
  independentlyConfirmed: boolean;
  /** True ONLY when the device is provably back at its original: matchesOriginal && independentlyConfirmed. */
  restored: boolean;
}

export interface ProbeResult {
  id: string;
  question: string;
  kind: 'read' | 'write';
  status: ProbeStatus;
  verdict: Verdict | 'skipped (read-only — pass --writes)';
  /** The raw observation(s) the verdict is drawn from — printed verbatim, never just the verdict. */
  observation: string;
  /** Mutating probes only: what the human should SEE/HEAR on the unit to confirm the probe left it as
   *  found — the check the probe itself cannot perform. */
  humanCheck?: string;
  /** Write probes only: what was changed and whether the original was provably restored. */
  restores: RestoreRecord[];
  /** Set when a restore's read-back did NOT match the original — printed as a FAILED-RESTORE block. */
  restoreFailures: { param: string; original: string }[];
  /** Set when a restore's read-back matched but its proof is NOT independent of the write path — printed
   *  as an UNPROVEN-RESTORE block. Never silently reported as a success. */
  restoreUnproven?: { param: string; original: string; readPath: string; note: string }[];
  /** Write probes only: set when the probe REFUSED to write because the captured original sat at an
   *  off/disabled range boundary where a misread would be destructive. */
  hazard?: string;
  /** Q5 only: the mutually-exclusive wire outcome behind the verdict. */
  outcome?: RejectOutcome;
  /** Q5 only: the elapsed time to the frame(s) actually seen — set ONLY when a frame was observed,
   *  never for a silent link (a timeout is not a latency). */
  latencyMs?: number;
  /** --dry-run only: what this mutating probe WOULD write and restore — with nothing written. */
  plan?: WritePlan;
}

export interface ProbeReport {
  results: ProbeResult[];
  exitCode: number;
}

export interface ProbeSession {
  model: number;
  label: string;
  transport: Transport;
  driver: DeviceDriver;
  codec: ModernFractalCodec;
  close(): Promise<void>;
}

export interface RunOpts {
  writes: boolean;
  log: (line: string) => void;
  /** --writes --dry-run: run only the READ half of the mutating probes and print the plan. Nothing is
   *  written; the run exits with its own non-success code. */
  dryRun?: boolean;
  /** Why no session could be opened — when set, the "no device" line names the port + errno + class. */
  connFailure?: ConnFailure;
}

// ── profile helpers ─────────────────────────────────────────────────────────────────────────────

/** A param's device-true id from the static profile catalog, by its raw catalog NAME. */
function paramId(model: number, family: string, name: string): number | undefined {
  return PROFILES[model]?.params[family]?.find((p) => p.name === name)?.paramId;
}

/** A param's range row (device-true ranges; the same map the driver serves from). */
function rangeOf(model: number, family: string, pid: number): { kind: string; displayMin: number; displayMax: number; enumCount?: number } | undefined {
  return PROFILES[model]?.ranges[family]?.[pid] as { kind: string; displayMin: number; displayMax: number; enumCount?: number } | undefined;
}

function eidForSlug(slug: string): number | undefined {
  return effectRoster().find((e) => e.slug === slug)?.page;
}

const fmt = (n: number | undefined): string => (n === undefined ? '(none)' : Number.isInteger(n) ? String(n) : n.toFixed(4));

/** Range families whose 0 boundary means "off/disabled" — a misread original here is destructive. */
const HAZARD_NAME = /BRIGHTNESS|LEVEL|VOLUME|LED|RING|LCD|DISPLAY|CONTRAST|COLOR|COLOUR|SCREEN/i;

/**
 * A captured original sitting at the off/disabled boundary of a level/brightness range (e.g. 0 on a
 * 0..100 GLOBAL_FS_BRIGHTNESS, which the FM3 manual defines as "manual brightness … 0 = off") is exactly
 * where a misread is destructive: we would "restore" a misread 0 and turn a real setting OFF. Treat it as
 * a hazard, not as truth. Returns a warning string when the original must not be written from blindly.
 */
function originalHazard(
  name: string,
  range: { kind: string; displayMin: number; displayMax: number } | undefined,
  value: number
): string | undefined {
  if (!range) return undefined;
  if (range.kind !== 'float' && range.kind !== 'enum') return undefined;
  if (!HAZARD_NAME.test(name)) return undefined;
  if (value <= 0 + 1e-6) return `the captured original is ${value} — the off/disabled end of a ${range.displayMin}..${range.displayMax} level range`;
  return undefined;
}

// ── the runbook ─────────────────────────────────────────────────────────────────────────────────

/** Raw fn-0x1F whole-block bulk read through the shared codec (NOT re-implemented framing). */
async function rawBulkRead(s: ProbeSession, eid: number): Promise<{ blockId: number; itemCount: number; values: number[] }> {
  const frames = await s.transport.request(s.codec.buildBlockBulkReadPoll(eid), {
    timeoutMs: 2500,
    quietMs: 120,
    match: (fs) => fs.some((f) => f[5] === 0x76)
  });
  return s.codec.assembleGen3BlockBulkRead(frames);
}

/** Active channel (0..3) of a placed block, or 0 when unknown — used to slice the channel-blocked body. */
async function activeChannel(s: ProbeSession, eid: number): Promise<number> {
  try {
    return (await s.driver.getActiveChannels?.())?.get(eid) ?? 0;
  } catch {
    return 0;
  }
}

/** Q1 — a GLOBAL write, read back, then restored. WRITE. Never claims a restore it cannot prove; with
 *  dryRun it only READS and prints the plan. */
async function probeGlobalWrite(s: ProbeSession, log: (l: string) => void, dryRun: boolean): Promise<ProbeResult> {
  const base: Omit<ProbeResult, 'status' | 'verdict' | 'observation' | 'restores' | 'restoreFailures'> = {
    id: 'Q1',
    question: 'FM3 accepts a GLOBAL write and reads back what we wrote (GLOBAL_FS_BRIGHTNESS 7115)',
    kind: 'write',
    humanCheck: 'Mini-display + footswitch LED-ring brightness should be back at the level you saw before the run — look at the unit. (0 = off/dark.)'
  };
  const restores: RestoreRecord[] = [];
  const restoreFailures: { param: string; original: string }[] = [];
  const restoreUnproven: { param: string; original: string; readPath: string; note: string }[] = [];
  const pid = paramId(s.model, 'GLOBAL', 'GLOBAL_FS_BRIGHTNESS') ?? 7115;
  const EID = 1; // the GLOBAL virtual effect
  const name = `GLOBAL_FS_BRIGHTNESS (eid ${EID}, pid ${pid})`;
  // The one read path this probe has: a fresh per-pid GET through the driver (fn 0x01 sub 01). The
  // restore read-back uses the SAME path, so it CANNOT catch an original that was itself misread.
  const READ_PATH = `per-pid GET (fn 0x01 sub 01) on eid ${EID}, fresh device read`;

  const readBack = async (): Promise<number | undefined> => (await s.driver.readParams?.(EID, [pid]))?.[pid];
  const before = await readBack();
  if (before === undefined) {
    return { ...base, status: 'indeterminate', verdict: 'cannot determine', observation: `no reply to the per-pid GET of ${name} (is the GLOBAL effect addressable on this link?)`, restores, restoreFailures, restoreUnproven };
  }
  // Nudge by 0.1 in the direction that stays inside [0,1]; a continuous param's wire value is 0..1.
  const target = before <= 0.9 ? Math.min(1, before + 0.1) : Math.max(0, before - 0.1);
  const hazard = originalHazard(name, rangeOf(s.model, 'GLOBAL', pid), before);

  if (dryRun) {
    const plan: WritePlan = { id: 'Q1', param: name, eid: EID, pid, original: fmt(before), wouldWrite: fmt(target), wouldRestore: fmt(before), hazard };
    log(`  [Q1] DRY-RUN  read ${name} = ${fmt(before)}${hazard ? `  ⚠ ${hazard}` : ''}; WOULD write ${fmt(target)}, WOULD restore ${fmt(before)} — nothing written.`);
    return { ...base, status: 'indeterminate', verdict: 'cannot determine', observation: `dry-run: read ${fmt(before)} (${READ_PATH}); would write ${fmt(target)}; would restore ${fmt(before)}${hazard ? `; HAZARD: ${hazard}` : ''}. Nothing was written.`, hazard, plan, restores, restoreFailures, restoreUnproven };
  }

  // HAZARD: an original at the off/disabled boundary of a level range is where a misread is destructive
  // (we would "restore" a misread 0 and turn the setting OFF). We REFUSE to write — the safe choice is to
  // lose the Q1 answer than to risk destroying a real setting. Trade-off: on a unit whose brightness is
  // already 0, Q1 stays indeterminate until the brightness is raised or the original is read independently.
  if (hazard) {
    log(`  [Q1] REFUSED  ${name}: ${hazard} — not writing (a read-back on the same path cannot prove a restore).`);
    return {
      ...base, status: 'indeterminate', verdict: 'cannot determine', hazard,
      observation: `refused to write ${name}: ${hazard}. Writing now risks turning an OFF setting into a "restore" of a misread 0 — destroying a real value — and the read-back (same path) could not tell the difference. Nothing was changed.`,
      restores, restoreFailures, restoreUnproven
    };
  }

  log(`  [Q1] WRITE  ${name}: ${fmt(before)} -> ${fmt(target)}  (will restore to ${fmt(before)})`);
  await s.driver.setParam?.(EID, pid, target, true);
  const after = await readBack();
  const accepted = after !== undefined && Math.abs(after - target) < 0.02;

  // ALWAYS restore, then read back. The read-back proves the device currently reports the original; it
  // does NOT prove the ORIGINAL itself was correct, because it came from the same read path.
  await s.driver.setParam?.(EID, pid, before, true);
  const restoredVal = await readBack();
  const matchesOriginal = restoredVal !== undefined && Math.abs(restoredVal - before) < 0.02;
  const independentlyConfirmed = false; // the only read is the same path that read the original
  const record: RestoreRecord = {
    param: name,
    originalSource: `${READ_PATH} — the fresh read is not a cached/layout value`,
    original: fmt(before),
    wroteBack: fmt(before),
    readBack: fmt(restoredVal),
    readPath: READ_PATH,
    matchesOriginal,
    independentlyConfirmed,
    restored: matchesOriginal && independentlyConfirmed
  };
  restores.push(record);
  if (!matchesOriginal) {
    restoreFailures.push({ param: name, original: fmt(before) });
  } else {
    restoreUnproven.push({ param: name, original: fmt(before), readPath: READ_PATH, note: 'the read-back echoes the write on the SAME read path; independent confirmation NOT established' });
  }
  log(`  [Q1] RESTORE ${name} -> ${fmt(before)} : ${matchesOriginal ? 'read-back matches, but on the SAME read path — independent confirmation NOT established' : 'NOT VERIFIED (read-back differs from the original)'}`);

  const observation = `read ${fmt(before)} (${READ_PATH}); wrote ${fmt(target)}; read back ${fmt(after)}; restored ${fmt(before)} (read back ${fmt(restoredVal)}; proof is the same-path read-back — not independent)`;
  return { ...base, status: 'determinate', verdict: accepted ? 'matches the expectation' : 'does NOT match', observation, restores, restoreFailures, restoreUnproven };
}

/** Q2 — a Cab 2 Mute/Solo write, read back, then restored. WRITE. Never claims a restore it cannot
 *  prove; with dryRun it only READS and prints the plan. */
async function probeCab2Mute(s: ProbeSession, log: (l: string) => void, dryRun: boolean): Promise<ProbeResult> {
  const base: Omit<ProbeResult, 'status' | 'verdict' | 'observation' | 'restores' | 'restoreFailures'> = {
    id: 'Q2',
    question: 'Cab 2 Mute/Solo write is accepted and reads back (CABINET_MUTE2)',
    kind: 'write',
    humanCheck: 'Cab 2 Mute/Solo should be back at its original state — check the Cab 2 mute/solo LED on the unit.'
  };
  const restores: RestoreRecord[] = [];
  const restoreFailures: { param: string; original: string }[] = [];
  const restoreUnproven: { param: string; original: string; readPath: string; note: string }[] = [];
  const cabEid = eidForSlug('cab');
  const pid = paramId(s.model, 'CABINET', 'CABINET_MUTE2');
  if (cabEid === undefined || pid === undefined) {
    return { ...base, status: 'indeterminate', verdict: 'cannot determine', observation: 'no CABINET family / CABINET_MUTE2 in this profile', restores, restoreFailures, restoreUnproven };
  }
  const name = `CABINET_MUTE2 (eid ${cabEid}, pid ${pid})`;
  const READ_PATH = `Cab block bulk read (fn 0x1F) on eid ${cabEid}, fresh device read`;

  const readMute = async (): Promise<number | undefined> => {
    try {
      const bp = await s.driver.blockParams?.(cabEid);
      return bp?.enums.find((e) => e.id === pid)?.value;
    } catch {
      return undefined;
    }
  };
  const before = await readMute();
  if (before === undefined) {
    return { ...base, status: 'indeterminate', verdict: 'cannot determine', observation: `no reply to the Cab bulk read (is a Cab block placed at eid ${cabEid}?)`, restores, restoreFailures, restoreUnproven };
  }
  const target = (before + 1) % 3; // 0 -- → 1 MUTE → 2 SOLO → 0 (the MUTE enum's three options)

  if (dryRun) {
    const plan: WritePlan = { id: 'Q2', param: name, eid: cabEid, pid, original: String(before), wouldWrite: String(target), wouldRestore: String(before) };
    log(`  [Q2] DRY-RUN  read ${name} = ${before}; WOULD write ${target}, WOULD restore ${before} — nothing written.`);
    return { ...base, status: 'indeterminate', verdict: 'cannot determine', observation: `dry-run: read ordinal ${before} (${READ_PATH}); would write ${target}; would restore ${before}. Nothing was written.`, plan, restores, restoreFailures, restoreUnproven };
  }

  log(`  [Q2] WRITE  ${name}: ${before} -> ${target}  (will restore to ${before})`);
  await s.driver.setParam?.(cabEid, pid, target, false); // discrete write
  const after = await readMute();
  const accepted = after === target;

  await s.driver.setParam?.(cabEid, pid, before, false);
  const restoredVal = await readMute();
  const matchesOriginal = restoredVal === before;
  const independentlyConfirmed = false; // the only read is the same path that read the original
  const record: RestoreRecord = {
    param: name,
    originalSource: READ_PATH,
    original: String(before),
    wroteBack: String(before),
    readBack: restoredVal === undefined ? '(none)' : String(restoredVal),
    readPath: READ_PATH,
    matchesOriginal,
    independentlyConfirmed,
    restored: matchesOriginal && independentlyConfirmed
  };
  restores.push(record);
  if (!matchesOriginal) {
    restoreFailures.push({ param: name, original: String(before) });
  } else {
    restoreUnproven.push({ param: name, original: String(before), readPath: READ_PATH, note: 'the read-back echoes the write on the SAME read path; independent confirmation NOT established' });
  }
  log(`  [Q2] RESTORE ${name} -> ${before} : ${matchesOriginal ? 'read-back matches, but on the SAME read path — independent confirmation NOT established' : 'NOT VERIFIED (read-back differs from the original)'}`);

  const observation = `read ordinal ${before} (${READ_PATH}); wrote ${target}; read back ${fmt(after)}; restored ${before} (read back ${fmt(restoredVal)}; proof is the same-path read-back — not independent)`;
  return { ...base, status: 'determinate', verdict: accepted ? 'matches the expectation' : 'does NOT match', observation, restores, restoreFailures, restoreUnproven };
}

/** Q3 — does a real FM3 send a 16-bit-scaled enum wire value (PHASER_ORDER)? READ. */
async function probeScaledEnum(s: ProbeSession): Promise<ProbeResult> {
  const base: Omit<ProbeResult, 'status' | 'verdict' | 'observation' | 'restores' | 'restoreFailures'> = {
    id: 'Q3',
    question: 'FM3 sends a 16-bit-scaled ENUM wire value (PHASER_ORDER) rather than a plain ordinal',
    kind: 'read'
  };
  const phEid = eidForSlug('phaser');
  const pid = paramId(s.model, 'PHASER', 'PHASER_ORDER');
  const range = pid !== undefined ? rangeOf(s.model, 'PHASER', pid) : undefined;
  if (phEid === undefined || pid === undefined || !range) {
    return { ...base, status: 'indeterminate', verdict: 'cannot determine', observation: 'no PHASER family / PHASER_ORDER in this profile', restores: [], restoreFailures: [] };
  }
  let bulk: { itemCount: number; values: number[] };
  try {
    bulk = await rawBulkRead(s, phEid);
  } catch {
    return { ...base, status: 'indeterminate', verdict: 'cannot determine', observation: `no bulk read for the Phaser (eid ${phEid}) — is a Phaser block placed?`, restores: [], restoreFailures: [] };
  }
  if (!bulk.itemCount || bulk.values.length === 0) {
    return { ...base, status: 'indeterminate', verdict: 'cannot determine', observation: `empty bulk read for the Phaser (eid ${phEid}) — is a Phaser block placed?`, restores: [], restoreFailures: [] };
  }
  const stride = PROFILES[s.model]?.rangeSections['PHASER']?.stride ?? 1;
  const base0 = (await activeChannel(s, phEid)) * stride;
  const raw = bulk.values[base0 + pid] ?? 0;
  // A scaled enum's display span (`displayMax`) is `scale`× its ORDINAL span; a plain ordinal can
  // never exceed the display span. So raw > displayMax is the scale signature.
  const scaled = raw > range.displayMax;
  const observation = `${pid >= 0 ? 'PHASER_ORDER' : ''} raw wire value ${raw} vs displayMax ${range.displayMax} (enumCount ${range.enumCount ?? '?'}, channel ${base0 / stride})`;
  return { ...base, status: 'determinate', verdict: scaled ? 'matches the expectation' : 'does NOT match', observation, restores: [], restoreFailures: [] };
}

/** Q4 — does a COMPLETE bulk read ever carry MORE values than the 0x74 head advertises? READ. */
async function probePadding(s: ProbeSession): Promise<ProbeResult> {
  const base: Omit<ProbeResult, 'status' | 'verdict' | 'observation' | 'restores' | 'restoreFailures'> = {
    id: 'Q4',
    question: 'A complete block bulk read never delivers more values than the 0x74 head advertises (no padding)',
    kind: 'read'
  };
  const candidates = [['cab', eidForSlug('cab')], ['phaser', eidForSlug('phaser')], ['amp', eidForSlug('amp')]] as const;
  for (const [slug, eid] of candidates) {
    if (eid === undefined) continue;
    let bulk: { itemCount: number; values: number[] };
    try {
      bulk = await rawBulkRead(s, eid);
    } catch {
      continue;
    }
    if (bulk.itemCount > 0 && bulk.values.length > 0) {
      const extra = bulk.values.length - bulk.itemCount;
      const observation = `${slug} (eid ${eid}): 0x74 advertised itemCount ${bulk.itemCount}, assembled ${bulk.values.length} values (extra ${extra})`;
      const verdict: Verdict = extra === 0 ? 'matches the expectation' : extra > 0 ? 'does NOT match' : 'cannot determine';
      const status: ProbeStatus = extra < 0 ? 'indeterminate' : 'determinate';
      const note = extra < 0 ? ' — torn read; retry' : extra > 0 ? ' — PADDING: the torn-read guard needs a tolerance' : '';
      return { ...base, observation: `${observation}${note}`, status, verdict, restores: [], restoreFailures: [] };
    }
  }
  return { ...base, status: 'indeterminate', verdict: 'cannot determine', observation: 'no placed block answered a bulk read (cab/phaser/amp all silent)', restores: [], restoreFailures: [] };
}

/**
 * Q5 — how the FM3 answers a write to an UNKNOWN effect id, with a deliberately invalid write. WRITE.
 * Three mutually-exclusive outcomes, single-sourced from the frames actually seen:
 *   refused  — a 0x64 arrived → latency measured to THAT frame;
 *   accepted — a non-0x64 reply arrived → the write was NOT refused; elapsed to the reply;
 *   silent   — nothing arrived → the FM3 ignored the unknown eid; NO latency is reported (a timeout is
 *              not a latency). This is the observed real-hardware behaviour.
 */
async function probeRejectLatency(s: ProbeSession, log: (l: string) => void, dryRun: boolean): Promise<ProbeResult> {
  const TIMEOUT_MS = 2000;
  const base: Omit<ProbeResult, 'status' | 'verdict' | 'observation' | 'restores' | 'restoreFailures'> = {
    id: 'Q5',
    question: 'A write to an unknown effect id is refused with a 0x64 rejection (not accepted, not silently ignored)',
    kind: 'write',
    humanCheck: 'Nothing on the unit should change (the bogus eid touches no real setting) — confirm no setting changed.'
  };
  // A write to a bogus effect id — the device must refuse (or ignore) it, so nothing on the unit changes
  // and there is nothing to restore. resultCode 0x05 = invalid effect id.
  const BOGUS_EID = 0x3ffe;
  const frame = s.codec.buildSetParameter(BOGUS_EID, 0, 0);

  if (dryRun) {
    const plan: WritePlan = { id: 'Q5', param: `unknown effect id (eid ${BOGUS_EID}, pid 0)`, eid: BOGUS_EID, pid: 0, original: '(none — a refused write changes nothing)', wouldWrite: `the set-parameter frame ${hex(frame)}`, wouldRestore: '(none — a refused write changes nothing)' };
    log(`  [Q5] DRY-RUN  WOULD send a deliberately invalid write to unknown eid ${BOGUS_EID} (tx ${hex(frame)}); nothing to restore — nothing written.`);
    return { ...base, status: 'indeterminate', verdict: 'cannot determine', observation: `dry-run: would send a deliberately invalid write to unknown eid ${BOGUS_EID} (${hex(frame)}); it changes nothing and there is nothing to restore. Nothing was written.`, plan, restores: [], restoreFailures: [] };
  }

  log(`  [Q5] INVALID WRITE  eid ${BOGUS_EID} (bogus; changes nothing, nothing to restore)  tx ${hex(frame)}`);
  const t0 = Date.now();
  const frames = await s.transport.request(frame, { timeoutMs: TIMEOUT_MS, quietMs: 250, match: (fs) => fs.some((f) => f[5] === 0x64) });
  const elapsed = Date.now() - t0;
  const reject = frames.find((f) => f[5] === 0x64);

  // 1) REFUSED — a 0x64 arrived. The transport resolves the instant a matching frame arrives, so
  //    `elapsed` IS the time to the 0x64 itself (not the poll timeout).
  if (reject) {
    const code = reject[7]; // the 0x64 body is [echoedFn, resultCode] (write-protocol.md) → code is byte 7.
    const codeText = code !== undefined ? describeMultipurposeResultCode(code) : 'unknown result code';
    const observation = `refused: a 0x64 arrived after ${elapsed} ms — ${hex(reject)} (resultCode 0x${(code ?? 0).toString(16).padStart(2, '0')}: ${codeText})`;
    return { ...base, status: 'determinate', verdict: 'matches the expectation', outcome: 'refused', latencyMs: elapsed, observation, restores: [], restoreFailures: [] };
  }

  // 2) SILENT — nothing arrived at all. The elapsed time is the POLL TIMEOUT, not a device latency, so
  //    no latency number is reported.
  if (frames.length === 0) {
    const observation = `silent: no frame arrived within ${TIMEOUT_MS} ms — the FM3 ignored the unknown eid ${BOGUS_EID} (no refusal, no reply); no latency was measured`;
    return { ...base, status: 'determinate', verdict: 'silent (no reply)', outcome: 'silent', observation, restores: [], restoreFailures: [] };
  }

  // 3) ACCEPTED — a reply arrived, but none was a 0x64 → the device did NOT refuse the write.
  const observation = `accepted: no 0x64; ${frames.length} reply frame(s) arrived by ${elapsed} ms — ${frames.map((f) => hex(f)).join(' | ')} (the write was not refused); no rejection to time`;
  return { ...base, status: 'determinate', verdict: 'does NOT match', outcome: 'accepted', latencyMs: elapsed, observation, restores: [], restoreFailures: [] };
}

/**
 * Run the five probes against a session (or report "no device" when session is null). Pure — the CLI
 * and the offline test both call this. Writes the per-probe observations + verdicts through `log`.
 */
export async function runDeviceProbes(session: ProbeSession | null, opts: RunOpts): Promise<ProbeReport> {
  const { log } = opts;
  if (!session) {
    log(opts.connFailure ? formatConnFailure(opts.connFailure) : 'no device: could not open a connection — nothing was attempted.');
    return { results: [], exitCode: 3 };
  }
  const dryRun = opts.dryRun === true;
  const mode = dryRun ? 'DRY-RUN (read-only plan)' : opts.writes ? 'WRITES ENABLED' : 'READ-ONLY';
  log(`device: ${session.label} (model 0x${session.model.toString(16)}), mode: ${mode}`);
  if (dryRun) log('DRY-RUN — the read half of every probe runs, the mutating probes PRINT what they would write/restore, and NOTHING is written. This is NOT a completed run.');
  else if (opts.writes) log('WRITES ENABLED — Q1/Q2 will change one value, verify it, and restore it; Q5 sends a refused frame.');

  const results: ProbeResult[] = [];
  const skipped = (id: string, question: string, kind: 'read' | 'write'): ProbeResult => ({
    id, question, kind, status: 'skipped', verdict: 'skipped (read-only — pass --writes)', observation: 'not attempted in read-only mode', restores: [], restoreFailures: []
  });

  // READ probes — always eligible.
  results.push(await probeScaledEnum(session));
  results.push(await probePadding(session));
  // WRITE probes — the plan (dry-run) or the real writes (--writes).
  if (dryRun) {
    results.push(await probeGlobalWrite(session, log, true));
    results.push(await probeCab2Mute(session, log, true));
    results.push(await probeRejectLatency(session, log, true));
  } else if (opts.writes) {
    results.push(await probeGlobalWrite(session, log, false));
    results.push(await probeCab2Mute(session, log, false));
    results.push(await probeRejectLatency(session, log, false));
  } else {
    results.push(skipped('Q1', 'FM3 accepts a GLOBAL write and reads back what we wrote (GLOBAL_FS_BRIGHTNESS 7115)', 'write'));
    results.push(skipped('Q2', 'Cab 2 Mute/Solo write is accepted and reads back (CABINET_MUTE2)', 'write'));
    results.push(skipped('Q5', 'A write to an unknown effect id is refused with a 0x64 rejection (not accepted, not silently ignored)', 'write'));
  }

  // Dry-run is emphatically NOT a completed run: nothing was written, so it must never report success.
  // Exit 4 is distinct from 0 (all verdicts) / 2 (a probe was inconclusive) / 3 (no device).
  if (dryRun) return { results, exitCode: 4 };

  // Exit 0 only when every ELIGIBLE (non-skipped) probe produced a definite verdict, and at least one
  // did — an all-cannot-determine run must never look like a pass.
  const eligible = results.filter((r) => r.status !== 'skipped');
  const anyDeterminate = eligible.some((r) => r.status === 'determinate');
  const allDefinite = eligible.every((r) => r.status === 'determinate');
  const exitCode = anyDeterminate && allDefinite ? 0 : 2;
  return { results, exitCode };
}

/** Human-readable report: the verdict table, then loud change/restore + FAILED-/UNPROVEN-RESTORE blocks. */
export function formatReport(report: ProbeReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('── probe verdicts ─────────────────────────────────────────────────────────────────────────────');
  lines.push('ID   KIND   STATUS         VERDICT');
  for (const r of report.results) {
    lines.push(`${r.id.padEnd(4)} ${r.kind.padEnd(6)} ${r.status.padEnd(14)} ${r.verdict}`);
    lines.push(`     ${r.question}`);
    lines.push(`     observation: ${r.observation}`);
    if (r.hazard) lines.push(`     ⚠ HAZARD: ${r.hazard}`);
    if (r.humanCheck) lines.push(`     human check: ${r.humanCheck}`);
    if (r.plan) lines.push(`     plan (dry-run): ${r.plan.param} [eid ${r.plan.eid} pid ${r.plan.pid}] original ${r.plan.original} → would write ${r.plan.wouldWrite}, would restore ${r.plan.wouldRestore}${r.plan.hazard ? ` — ⚠ ${r.plan.hazard}` : ''}`);
    for (const c of r.restores) {
      const proof = c.restored
        ? 'restore VERIFIED (independently confirmed)'
        : c.matchesOriginal
          ? `read-back echoes the write on the SAME read path (${c.readPath}) — independent confirmation NOT established`
          : 'NOT VERIFIED (read-back differs from the original)';
      lines.push(`     changed ${c.param}: original ${c.original} (${c.originalSource}); wrote back ${c.wroteBack}; read back ${c.readBack} — ${proof}`);
    }
  }
  const failures = report.results.flatMap((r) => r.restoreFailures.map((f) => ({ id: r.id, ...f })));
  if (failures.length) {
    lines.push('');
    lines.push('======================= FAILED-RESTORE — FIX BY HAND =======================');
    for (const f of failures) lines.push(`  ${f.id}: ${f.param} was left at a non-original value — restore it to ${f.original} by hand.`);
    lines.push('============================================================================');
  }
  const unproven = report.results.flatMap((r) => (r.restoreUnproven ?? []).map((u) => ({ id: r.id, ...u })));
  if (unproven.length) {
    lines.push('');
    lines.push('=============== UNPROVEN-RESTORE — CONFIRM VISUALLY ON THE UNIT ===============');
    for (const u of unproven) lines.push(`  ${u.id}: ${u.param} read back as the original (${u.original}), but ${u.note}.`);
    lines.push('  The read-back used the SAME path that read the original, so it CANNOT prove the original was correct.');
    lines.push('  This is not a claim that the restore failed — it is a claim that the probe cannot prove it worked.');
    lines.push('==============================================================================');
  }
  if (!report.results.length) lines.push('(no probes ran)');
  const exitNote =
    report.exitCode === 0
      ? ' (all eligible probes gave a definite verdict)'
      : report.exitCode === 3
        ? ' (nothing was attempted — no device)'
        : report.exitCode === 4
          ? ' (DRY-RUN — nothing was written; this is NOT a completed run)'
          : ' (an eligible probe could not determine — not a pass)';
  lines.push(`exit code: ${report.exitCode}${exitNote}`);
  return lines.join('\n');
}

// ── mock (offline) device ───────────────────────────────────────────────────────────────────────

function sysex(model: number, fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, model, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}
const enc14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];

export interface MockOptions {
  /** GLOBAL_FS_BRIGHTNESS as a normalized 0..1 wire value (default 0.5). */
  globalBrightness?: number;
  /** CABINET_MUTE2 ordinal 0..2 (default 0 = "--"). */
  cabMute2?: number;
  /** PHASER_ORDER raw wire value (default a 16-bit-SCALED value for display 6). */
  phaserOrderRaw?: number;
  /** When true the mock sends no replies at all (simulates a dead link). */
  silent?: boolean;
  /** How the scripted device answers a write to an UNKNOWN effect id: 'refuse' (a 0x64, default),
   *  'ignore' (no reply at all — the real FM3 behaviour), or 'accept' (a non-0x64 reply/echo). */
  invalidWrite?: 'refuse' | 'ignore' | 'accept';
  /** Delay (ms) before a scripted 0x64 refusal, so the measured latency is non-zero (default 0). */
  rejectDelayMs?: number;
}

/**
 * A scripted FM3 over MockTransport: answers the reads each probe needs, reflects writes back, and
 * refuses writes to an unknown effect id with a 0x64 — enough to run the whole runbook with no
 * hardware. Returns the transport so a test can assert what was sent.
 */
export function createMockSession(model = 0x11, mockOpts: MockOptions = {}): { session: ProbeSession; mock: MockTransport } {
  const profile = PROFILES[model]!;
  const codec = createModernFractalCodec(model);
  const mock = new MockTransport('serial', 'mock-probe-fm3');
  mock.isOpen = true;

  let globalNorm = mockOpts.globalBrightness ?? 0.5;
  let cabMute = mockOpts.cabMute2 ?? 0;
  // display 6 on a scale-2 enum → raw = 6/10·65534 ≈ 39320 > displayMax 10 → the scale signature.
  const phaserRaw = mockOpts.phaserOrderRaw ?? Math.round((6 / 10) * 65534);
  const cabEid = eidForSlug('cab') ?? 62;
  const phaserEid = eidForSlug('phaser') ?? 90;
  const globalPid = paramId(model, 'GLOBAL', 'GLOBAL_FS_BRIGHTNESS') ?? 7115;
  const cabMutePid = paramId(model, 'CABINET', 'CABINET_MUTE2') ?? 25;
  const VALID_EIDS = new Set([1, cabEid, phaserEid, eidForSlug('amp') ?? 58].filter((x): x is number => x !== undefined));

  /** A 0x74/0x75/0x76 burst with `itemCount === values.length` (no padding). */
  const burst = (eid: number, values: number[]): number[][] => {
    const body: number[] = [0x00, 0x02];
    for (const v of values) body.push(...packValue16(v));
    return [
      sysex(model, 0x74, [...enc14(eid), ...enc14(values.length), 0x07]),
      sysex(model, 0x75, body),
      sysex(model, 0x76, [])
    ];
  };
  /** A per-pid GET reply carrying a 5-septet float32 at bytes 12-16 (the shape readParams unpacks). */
  const getReply = (req: readonly number[], value: number): number[] => {
    const f = new Float32Array([value]);
    const bits = new Uint32Array(f.buffer)[0]!;
    return [...req.slice(0, 12), ...pack5Septet32(bits), 0x00, 0x00, 0x00, 0x00, 0xf7];
  };

  mock.reply = (req) => {
    if (mockOpts.silent) return [];
    const fn = req[5];
    // fn=0x1F bulk-read poll carries ONLY the effect id (bytes 6-7); fn=0x01 carries sub+eid+pid.
    const bulkEid = (req[6]! | (req[7]! << 7));
    const eid = (req[8]! | (req[9]! << 7));
    const pid = (req[10]! | (req[11]! << 7));
    if (fn === 0x13) return []; // status dump (optional for the driver)
    if (fn === 0x1f) {
      if (bulkEid === cabEid) {
        const stride = profile.rangeSections['CABINET']?.stride ?? 106;
        const values = new Array<number>(stride * 4).fill(0);
        values[cabMutePid] = cabMute;
        return burst(eid, values);
      }
      if (bulkEid === phaserEid) {
        const stride = profile.rangeSections['PHASER']?.stride ?? 35;
        const values = new Array<number>(stride * 4).fill(0);
        values[paramId(model, 'PHASER', 'PHASER_ORDER') ?? 1] = phaserRaw;
        return burst(eid, values);
      }
      return [];
    }
    if (fn === 0x01) {
      const sub = req[6];
      if (sub === 0x01) { // per-pid GET (sub 01 00)
        if (eid === 1 && pid === globalPid) return [getReply(req, globalNorm)];
        return [];
      }
      if (sub === 0x09 || sub === 0x52) { // a write
        const value = decode5SeptetFloat32(req[12]!, req[13]!, req[14]!, req[15]!, req[16]!);
        if (!VALID_EIDS.has(eid)) {
          // An unknown effect id: 'ignore' = SILENT (the real FM3 ignores it), 'accept' = a non-0x64
          // reply (an echo — a reply arrived, but not a refusal), 'refuse' = a 0x64 rejection.
          const mode = mockOpts.invalidWrite ?? 'refuse';
          if (mode === 'ignore') return [];
          if (mode === 'accept') return [[...req]];
          const refusal = sysex(model, 0x64, [0x01, 0x05]); // 0x05 = invalid effect id
          return mockOpts.rejectDelayMs ? new Promise<number[][]>((res) => setTimeout(() => res([refusal]), mockOpts.rejectDelayMs)) : [refusal];
        }
        if (eid === 1 && pid === globalPid) { globalNorm = Math.max(0, Math.min(1, value)); return []; }
        if (eid === cabEid && pid === cabMutePid) { cabMute = Math.round(value); return []; }
        return [];
      }
      return [];
    }
    return [];
  };

  // The driver's CONTINUOUS write path is fire-and-forget via sendQueued() (not request()), and
  // MockTransport.sendQueued records but does not dispatch to reply(). Patch it so the scripted device
  // still SEES the write and updates its state (a real device is silent on accept, so reply() returns
  // no frames for a write — only the side effect matters).
  mock.sendQueued = async (bytes: readonly number[]) => {
    mock.sent.push([...bytes]);
    mock.reply(bytes);
  };

  const driver = createGen3Driver(profile, {
    transport: async () => mock,
    emit: () => {},
    getCadence: () => cadenceFor(model, 'balanced')
  });
  const session: ProbeSession = {
    model,
    label: mock.label,
    transport: mock,
    driver,
    codec,
    close: async () => { mock.isOpen = false; }
  };
  return { session, mock };
}

// ── connection diagnostics ───────────────────────────────────────────────────────────────────────

/** The three distinct ways a connection can fail to yield a usable device. */
export type ConnFailureClass = 'no-ports' | 'not-openable' | 'unresponsive';

export interface ConnFailure {
  cls: ConnFailureClass;
  /** The serial path involved, when one was resolved/detected. */
  port?: string;
  /** A symbolic errno (EACCES, ENOENT, EBUSY, …) when the OS reported one. */
  errno?: string;
  /** The raw system/binding message. */
  detail: string;
}

const ERRNO_BY_NUMBER: Record<number, string> = { [-1]: 'EPERM', [-2]: 'ENOENT', [-5]: 'EIO', [-6]: 'ENXIO', [-11]: 'EAGAIN', [-13]: 'EACCES', [-16]: 'EBUSY', [-19]: 'ENODEV' };

/** Map a Node/serialport error to a symbolic errno name (EACCES, ENOENT, …), best-effort. */
export function errnoName(err: unknown): string | undefined {
  const e = (err ?? {}) as { code?: unknown; errno?: unknown; message?: unknown };
  if (typeof e.code === 'string' && /^E[A-Z0-9]+$/.test(e.code)) return e.code;
  const num = typeof e.errno === 'number' ? e.errno : undefined;
  if (num !== undefined && ERRNO_BY_NUMBER[num]) return ERRNO_BY_NUMBER[num];
  const msg = String(e.message ?? err ?? '');
  const token = msg.match(/\bE[A-Z]{3,}\b/);
  if (token) return token[0];
  if (/permission denied/i.test(msg)) return 'EACCES';
  if (/no such file|not found/i.test(msg)) return 'ENOENT';
  if (/device or resource busy|resource busy|\bbusy\b/i.test(msg)) return 'EBUSY';
  if (/input\/output error/i.test(msg)) return 'EIO';
  if (/no such device/i.test(msg)) return 'ENODEV';
  return undefined;
}

/**
 * Classify an error thrown while OPENING a resolved port: names the port and, when the OS reported one,
 * the errno — so a permission error (EACCES on a present /dev/ttyACM0) can never be confusable with an
 * absent device.
 */
export function classifyOpenError(port: string | undefined, err: unknown): ConnFailure {
  return { cls: 'not-openable', port, errno: errnoName(err), detail: (err as Error)?.message ?? String(err) };
}

/** The loud, class-specific "no device" line — the ONE place the three failure classes are worded. */
export function formatConnFailure(f: ConnFailure): string {
  switch (f.cls) {
    case 'no-ports':
      return `no device: no serial port was enumerated or detected — nothing was attempted (${f.detail}).`;
    case 'not-openable':
      return `no device: serial port ${f.port ?? '(unknown)'} is present but could not be opened — ${f.errno ?? 'errno unknown'}: ${f.detail} — nothing was attempted.`;
    case 'unresponsive':
      return `no device: serial port ${f.port ?? '(unknown)'} opened but the device never answered a status-dump handshake (openable but unresponsive) — nothing was attempted.`;
  }
}

export type OpenResult = { ok: true; session: ProbeSession } | { ok: false; failure: ConnFailure };

/**
 * Resolve + open the device and verify it actually answers, distinguishing the three failure classes:
 *   no-ports     — nothing was enumerated or detected (nothing to open);
 *   not-openable — a port was resolved but open() failed (names the port + errno);
 *   unresponsive — the port opened but the device never answered a handshake.
 */
export async function openProbeSession(model: number, port?: string): Promise<OpenResult> {
  let conn: Conn | null;
  try {
    conn = port ? { transport: 'serial', id: port } : await resolveConn();
  } catch (e) {
    return { ok: false, failure: { cls: 'no-ports', detail: `port enumeration failed: ${(e as Error)?.message ?? String(e)}` } };
  }
  if (!conn) {
    return { ok: false, failure: { cls: 'no-ports', detail: 'looked for FORGEFX_SERIAL, a Fractal by-id if03 node, then /dev/ttyACM0 — none present' } };
  }
  let transport: Transport;
  try {
    transport = openConn(conn);
    await transport.open();
  } catch (e) {
    return { ok: false, failure: classifyOpenError(conn.id, e) };
  }

  const codec = createModernFractalCodec(model);
  // Responsiveness handshake (fn-0x13 status dump). A port that opens but never answers this is not a
  // device we can probe — name it "openable but unresponsive" rather than a generic "no device".
  let responsive = false;
  try {
    const frames = await transport.request(codec.buildStatusDump(), { timeoutMs: 1500, quietMs: 90 });
    responsive = frames.length > 0;
  } catch {
    responsive = false;
  }
  if (!responsive) {
    try { await transport.close(); } catch { /* best effort */ }
    return { ok: false, failure: { cls: 'unresponsive', port: conn.id, detail: `${conn.id} opened but gave no reply to a fn-0x13 status dump within 1500 ms` } };
  }

  const profile = PROFILES[model]!;
  const driver = createGen3Driver(profile, {
    transport: async () => transport,
    emit: () => {},
    getCadence: () => cadenceFor(model, 'balanced')
  });
  return { ok: true, session: { model, label: transport.label, transport, driver, codec, close: async () => { await transport.close(); } } };
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────

const MODEL_BY_KEY: Record<string, number> = { fm3: 0x11, fm9: 0x12, axe3: 0x10, '0x10': 0x10, '0x11': 0x11, '0x12': 0x12 };
/** Default target model byte (FM3) — the device every one of these questions is about. */
export const DEVICE_PROBE_MODEL_DEFAULT = 0x11;

const USAGE = `probe-device — one-command runbook for the open FM3 hardware questions (READ-ONLY by default)

  --writes        enable the mutating probes (Q1/Q2 restore what they change; Q5 is a refused frame)
  --dry-run       with the mutating probes: READ only and PRINT what would be written/restored; writes
                  nothing and exits 4 (never a success)
  --mock          run the whole runbook against a built-in scripted FM3 (no hardware)
  --model <key>   target profile: fm3 (default) | fm9 | axe3
  --port <path>   force a serial port (else auto-detect)

exit 0 = every eligible probe gave a definite verdict; 2 = an eligible probe could not determine;
3 = no device (nothing attempted); 4 = --dry-run (a plan was printed, nothing was written).`;

/** Parse argv and run. Returns the process exit code; never throws for a missing device. */
export async function main(argv: string[], log: (l: string) => void = console.log): Promise<number> {
  let writes = false;
  let dryRun = false;
  let useMock = false;
  let model = 0x11;
  let port: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--writes') writes = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--mock') useMock = true;
    else if (a === '--help' || a === '-h') { log(USAGE); return 0; }
    else if (a === '--model') {
      const key = argv[++i] ?? '';
      if (!(key in MODEL_BY_KEY)) { log(`unknown --model ${key}\n${USAGE}`); return 1; }
      model = MODEL_BY_KEY[key]!;
    } else if (a === '--port') port = argv[++i];
    else { log(`unknown argument ${a}\n${USAGE}`); return 1; }
  }

  let session: ProbeSession | null;
  let connFailure: ConnFailure | undefined;
  if (useMock) {
    session = createMockSession(model).session;
    log('[mock] driving a built-in scripted FM3 over the MockTransport — no hardware involved.');
  } else {
    const res = await openProbeSession(model, port);
    if (res.ok) {
      session = res.session;
    } else {
      session = null;
      connFailure = res.failure;
    }
  }

  const report = await runDeviceProbes(session, { writes, dryRun, log, connFailure });
  log(formatReport(report));
  try { await session?.close(); } catch { /* best effort */ }
  return report.exitCode;
}

// Auto-run only when executed as the entry script (not when imported by the test).
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (entry && import.meta.url === entry) {
  process.exit(await main(process.argv.slice(2)));
}
