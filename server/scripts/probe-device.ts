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
//   Q5  What is the REAL latency of a 0x64 rejection on the wire? The discrete-write confirm window
//       is 250 ms, inherited from the writer path and never measured.
//
// SAFETY. Default is READ-ONLY. Q3 and Q4 are pure reads. Q1, Q2 and Q5 need a WRITE; all three are
// behind --writes. The mutating probes (Q1, Q2) capture the original value, verify the write, then
// RESTORE the original value and verify the restore, printing loudly what they changed. If a restore
// cannot be verified they print a FAILED-RESTORE block naming the param and its original value so a
// human can fix it by hand. Q5 uses a deliberately INVALID write (a bogus effect id the device should
// refuse) so it changes no real setting; it is still behind --writes.
//
// Each probe prints the RAW observation AND a verdict (`matches the expectation` / `does NOT match` /
// `cannot determine`) — never just a conclusion.
//
// EXIT CODES
//   0  every ELIGIBLE probe (a probe that the current mode could run) produced a definite verdict.
//   2  a device was reachable but an eligible probe could not produce a definite verdict
//      (cannot determine / not supported / no reply) — a silent pass is impossible.
//   3  no device could be opened (nothing was attempted).
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
import type { Transport } from '../src/transport/types.js';
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

export type Verdict = 'matches the expectation' | 'does NOT match' | 'cannot determine';
/** determinate = a definite verdict; indeterminate = eligible but no definite verdict;
 *  skipped = deliberately not run in this mode (read-only). */
export type ProbeStatus = 'determinate' | 'indeterminate' | 'skipped';

export interface RestoreRecord {
  param: string;
  original: string;
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
  /** Write probes only: what was changed and whether the original was verified back. */
  restores: RestoreRecord[];
  /** Set when a restore could not be verified — printed as a FAILED-RESTORE block. */
  restoreFailures: { param: string; original: string }[];
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

/** Q1 — a GLOBAL write, read back, then restored. WRITE. */
async function probeGlobalWrite(s: ProbeSession, log: (l: string) => void): Promise<ProbeResult> {
  const base: Omit<ProbeResult, 'status' | 'verdict' | 'observation' | 'restores' | 'restoreFailures'> = {
    id: 'Q1',
    question: 'FM3 accepts a GLOBAL write and reads back what we wrote (GLOBAL_FS_BRIGHTNESS 7115)',
    kind: 'write'
  };
  const restores: RestoreRecord[] = [];
  const restoreFailures: { param: string; original: string }[] = [];
  const pid = paramId(s.model, 'GLOBAL', 'GLOBAL_FS_BRIGHTNESS') ?? 7115;
  const EID = 1; // the GLOBAL virtual effect
  const name = `GLOBAL_FS_BRIGHTNESS (eid ${EID}, pid ${pid})`;

  const readBack = async (): Promise<number | undefined> => (await s.driver.readParams?.(EID, [pid]))?.[pid];
  const before = await readBack();
  if (before === undefined) {
    return { ...base, status: 'indeterminate', verdict: 'cannot determine', observation: `no reply to the per-pid GET of ${name} (is the GLOBAL effect addressable on this link?)`, restores, restoreFailures };
  }
  // Nudge by 0.1 in the direction that stays inside [0,1]; a continuous param's wire value is 0..1.
  const target = before <= 0.9 ? Math.min(1, before + 0.1) : Math.max(0, before - 0.1);
  log(`  [Q1] WRITE  ${name}: ${fmt(before)} -> ${fmt(target)}  (will restore to ${fmt(before)})`);
  await s.driver.setParam?.(EID, pid, target, true);
  const after = await readBack();
  const accepted = after !== undefined && Math.abs(after - target) < 0.02;

  // ALWAYS restore, then verify.
  await s.driver.setParam?.(EID, pid, before, true);
  const restoredVal = await readBack();
  const restored = restoredVal !== undefined && Math.abs(restoredVal - before) < 0.02;
  restores.push({ param: name, original: fmt(before), restored });
  if (!restored) restoreFailures.push({ param: name, original: fmt(before) });
  log(`  [Q1] RESTORE ${name} -> ${fmt(before)} : ${restored ? 'verified' : 'NOT VERIFIED'}`);

  const observation = `read ${fmt(before)}; wrote ${fmt(target)}; read back ${fmt(after)}; restored ${fmt(before)} (read back ${fmt(restoredVal)})`;
  return { ...base, status: 'determinate', verdict: accepted ? 'matches the expectation' : 'does NOT match', observation, restores, restoreFailures };
}

/** Q2 — a Cab 2 Mute/Solo write, read back, then restored. WRITE. */
async function probeCab2Mute(s: ProbeSession, log: (l: string) => void): Promise<ProbeResult> {
  const base: Omit<ProbeResult, 'status' | 'verdict' | 'observation' | 'restores' | 'restoreFailures'> = {
    id: 'Q2',
    question: 'Cab 2 Mute/Solo write is accepted and reads back (CABINET_MUTE2)',
    kind: 'write'
  };
  const restores: RestoreRecord[] = [];
  const restoreFailures: { param: string; original: string }[] = [];
  const cabEid = eidForSlug('cab');
  const pid = paramId(s.model, 'CABINET', 'CABINET_MUTE2');
  if (cabEid === undefined || pid === undefined) {
    return { ...base, status: 'indeterminate', verdict: 'cannot determine', observation: 'no CABINET family / CABINET_MUTE2 in this profile', restores, restoreFailures };
  }
  const name = `CABINET_MUTE2 (eid ${cabEid}, pid ${pid})`;

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
    return { ...base, status: 'indeterminate', verdict: 'cannot determine', observation: `no reply to the Cab bulk read (is a Cab block placed at eid ${cabEid}?)`, restores, restoreFailures };
  }
  const target = (before + 1) % 3; // 0 -- → 1 MUTE → 2 SOLO → 0 (the MUTE enum's three options)
  log(`  [Q2] WRITE  ${name}: ${before} -> ${target}  (will restore to ${before})`);
  await s.driver.setParam?.(cabEid, pid, target, false); // discrete write
  const after = await readMute();
  const accepted = after === target;

  await s.driver.setParam?.(cabEid, pid, before, false);
  const restoredVal = await readMute();
  const restored = restoredVal === before;
  restores.push({ param: name, original: String(before), restored });
  if (!restored) restoreFailures.push({ param: name, original: String(before) });
  log(`  [Q2] RESTORE ${name} -> ${before} : ${restored ? 'verified' : 'NOT VERIFIED'}`);

  const observation = `read ordinal ${before}; wrote ${target}; read back ${fmt(after)}; restored ${before} (read back ${fmt(restoredVal)})`;
  return { ...base, status: 'determinate', verdict: accepted ? 'matches the expectation' : 'does NOT match', observation, restores, restoreFailures };
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

/** Q5 — the real latency of a 0x64 rejection, using a deliberately invalid write. WRITE (refused). */
async function probeRejectLatency(s: ProbeSession, log: (l: string) => void): Promise<ProbeResult> {
  const base: Omit<ProbeResult, 'status' | 'verdict' | 'observation' | 'restores' | 'restoreFailures'> = {
    id: 'Q5',
    question: 'Measure the real wire latency of a 0x64 rejection (deliberate invalid write)',
    kind: 'write'
  };
  // A write to a bogus effect id — the device must refuse it, so nothing on the unit changes and
  // there is nothing to restore. resultCode 0x05 = invalid effect id.
  const BOGUS_EID = 0x3ffe;
  const frame = s.codec.buildSetParameter(BOGUS_EID, 0, 0);
  log(`  [Q5] INVALID WRITE  eid ${BOGUS_EID} (should be refused; changes nothing, nothing to restore)  tx ${hex(frame)}`);
  const t0 = Date.now();
  const frames = await s.transport.request(frame, { timeoutMs: 2000, quietMs: 250, match: (fs) => fs.some((f) => f[5] === 0x64) });
  const ms = Date.now() - t0;
  const reject = frames.find((f) => f[5] === 0x64);
  // The 0x64 body is [echoedFn, resultCode] (write-protocol.md) → resultCode is byte 7.
  const code = reject?.[7];
  const detail = reject ? `0x64 body ${hex(reject.slice(6, -2))} (${code !== undefined ? describeMultipurposeResultCode(code) : 'unknown result code'})` : 'no 0x64 arrived within 2000 ms';
  const observation = `${detail}; latency ${ms} ms`;
  const verdict: Verdict = reject ? 'matches the expectation' : 'does NOT match';
  return { ...base, status: 'determinate', verdict, observation, restores: [], restoreFailures: [] };
}

/**
 * Run the five probes against a session (or report "no device" when session is null). Pure — the CLI
 * and the offline test both call this. Writes the per-probe observations + verdicts through `log`.
 */
export async function runDeviceProbes(session: ProbeSession | null, opts: RunOpts): Promise<ProbeReport> {
  const { log } = opts;
  if (!session) {
    log('no device: could not open a connection — nothing was attempted.');
    return { results: [], exitCode: 3 };
  }
  log(`device: ${session.label} (model 0x${session.model.toString(16)}), mode: ${opts.writes ? 'WRITES ENABLED' : 'READ-ONLY'}`);
  if (opts.writes) log('WRITES ENABLED — Q1/Q2 will change one value, verify it, and restore it; Q5 sends a refused frame.');

  const results: ProbeResult[] = [];
  const skipped = (id: string, question: string, kind: 'read' | 'write'): ProbeResult => ({
    id, question, kind, status: 'skipped', verdict: 'skipped (read-only — pass --writes)', observation: 'not attempted in read-only mode', restores: [], restoreFailures: []
  });

  // READ probes — always eligible.
  results.push(await probeScaledEnum(session));
  results.push(await probePadding(session));
  // WRITE probes — only when --writes.
  if (opts.writes) {
    results.push(await probeGlobalWrite(session, log));
    results.push(await probeCab2Mute(session, log));
    results.push(await probeRejectLatency(session, log));
  } else {
    results.push(skipped('Q1', 'FM3 accepts a GLOBAL write and reads back what we wrote (GLOBAL_FS_BRIGHTNESS 7115)', 'write'));
    results.push(skipped('Q2', 'Cab 2 Mute/Solo write is accepted and reads back (CABINET_MUTE2)', 'write'));
    results.push(skipped('Q5', 'Measure the real wire latency of a 0x64 rejection', 'write'));
  }

  // Exit 0 only when every ELIGIBLE (non-skipped) probe produced a definite verdict, and at least one
  // did — an all-cannot-determine run must never look like a pass.
  const eligible = results.filter((r) => r.status !== 'skipped');
  const anyDeterminate = eligible.some((r) => r.status === 'determinate');
  const allDefinite = eligible.every((r) => r.status === 'determinate');
  const exitCode = anyDeterminate && allDefinite ? 0 : 2;
  return { results, exitCode };
}

/** Human-readable report: the verdict table, then loud change/restore + FAILED-RESTORE blocks. */
export function formatReport(report: ProbeReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('── probe verdicts ─────────────────────────────────────────────────────────────────────────────');
  lines.push('ID   KIND   STATUS         VERDICT');
  for (const r of report.results) {
    lines.push(`${r.id.padEnd(4)} ${r.kind.padEnd(6)} ${r.status.padEnd(14)} ${r.verdict}`);
    lines.push(`     ${r.question}`);
    lines.push(`     observation: ${r.observation}`);
    for (const c of r.restores) lines.push(`     changed ${c.param}: original ${c.original} — restore ${c.restored ? 'verified' : 'NOT VERIFIED'}`);
  }
  const failures = report.results.flatMap((r) => r.restoreFailures.map((f) => ({ id: r.id, ...f })));
  if (failures.length) {
    lines.push('');
    lines.push('======================= FAILED-RESTORE — FIX BY HAND =======================');
    for (const f of failures) lines.push(`  ${f.id}: ${f.param} was left at a non-original value — restore it to ${f.original} by hand.`);
    lines.push('============================================================================');
  }
  if (!report.results.length) lines.push('(no probes ran)');
  lines.push(`exit code: ${report.exitCode}${report.exitCode === 0 ? ' (all eligible probes gave a definite verdict)' : report.exitCode === 3 ? ' (no device — nothing attempted)' : ' (an eligible probe could not determine — not a pass)'}`);
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
        if (!VALID_EIDS.has(eid)) return [sysex(model, 0x64, [0x01, 0x05])]; // invalid effect id → refuse
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

// ── real device session ──────────────────────────────────────────────────────────────────────────

/** Open the auto-detected (or --port-forced) device and bind a gen-3 driver to it. */
export async function openRealSession(model: number, port?: string): Promise<ProbeSession | null> {
  const conn = port ? ({ transport: 'serial' as const, id: port }) : await resolveConn();
  if (!conn) return null;
  const transport = openConn(conn);
  await transport.open();
  const profile = PROFILES[model]!;
  const driver = createGen3Driver(profile, {
    transport: async () => transport,
    emit: () => {},
    getCadence: () => cadenceFor(model, 'balanced')
  });
  return {
    model,
    label: transport.label,
    transport,
    driver,
    codec: createModernFractalCodec(model),
    close: async () => { await transport.close(); }
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────

const MODEL_BY_KEY: Record<string, number> = { fm3: 0x11, fm9: 0x12, axe3: 0x10, '0x10': 0x10, '0x11': 0x11, '0x12': 0x12 };
/** Default target model byte (FM3) — the device every one of these questions is about. */
export const DEVICE_PROBE_MODEL_DEFAULT = 0x11;

const USAGE = `probe-device — one-command runbook for the open FM3 hardware questions (READ-ONLY by default)

  --writes        enable the mutating probes (Q1/Q2 restore what they change; Q5 is a refused frame)
  --mock          run the whole runbook against a built-in scripted FM3 (no hardware)
  --model <key>   target profile: fm3 (default) | fm9 | axe3
  --port <path>   force a serial port (else auto-detect)

exit 0 = every eligible probe gave a definite verdict; 2 = an eligible probe could not determine;
3 = no device (nothing attempted).`;

/** Parse argv and run. Returns the process exit code; never throws for a missing device. */
export async function main(argv: string[], log: (l: string) => void = console.log): Promise<number> {
  let writes = false;
  let useMock = false;
  let model = 0x11;
  let port: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--writes') writes = true;
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
  if (useMock) {
    session = createMockSession(model).session;
    log('[mock] driving a built-in scripted FM3 over the MockTransport — no hardware involved.');
  } else {
    try {
      session = await openRealSession(model, port);
    } catch (e) {
      log(`could not open the device: ${(e as Error).message}`);
      session = null;
    }
  }

  const report = await runDeviceProbes(session, { writes, log });
  log(formatReport(report));
  try { await session?.close(); } catch { /* best effort */ }
  return report.exitCode;
}

// Auto-run only when executed as the entry script (not when imported by the test).
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (entry && import.meta.url === entry) {
  process.exit(await main(process.argv.slice(2)));
}
