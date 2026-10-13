// ────────────────────────────────────────────────────────────────────────────────
// audit-taper-vs-device — compare OUR decode against the INSTRUMENT's own display, per parameter.
//
// WHY: the log/linear decision for a float param is `(typecode >> 4) & 0xf ∈ {4,5}` when the range row
// carries no explicit taper (drivers/gen3.ts:1719-1723). That heuristic was derived from the frequency-cut
// typecodes (0x240/0x241 → nibble 4, genuinely log) and produces FALSE POSITIVES elsewhere. MEASURED
// 2026-10-13 by the owner's own reading: CABINET/33 "Drive" (typecode 0x52 → nibble 5) is served
// log 0.01..10 → raw 32768 decodes to 0.316, while the unit's own strings say 0.00 at raw 0 and 5.00 at
// mid (linear 0→10). Frequency and High Cut 1 both match. This audit asks every param that matters, so
// the question "is Drive the only false positive or one of many" gets a measured answer instead of taste.
//
// READ-ONLY: self-describe view 0x00 only. No write frames, nothing swept, nothing restored.
//
// The snapshot of what the server serves must be taken BEFORE this runs (the server holds the port):
//   GET /preset/blocks/<eid>/params  ->  ~/.hermes/cache/scratch/taper-audit/params-snapshot.json
//
// ── TWO HARDENINGS (both taught by a run that lied, 2026-10-13) ─────────────────────────────────
//
// 1. STATE GUARD — a comparison across two different presets is not a measurement. The first run of this
//    audit compared the server's OLD preset body against a unit the owner had moved on from, produced a
//    phantom "the unit reads Cab Drive 0.00", and sent the investigation off into "are view-0x00 replies
//    channel-dependent". The guard reads the DEVICE's own current preset name (fn=0x0D, read-only) and
//    requires it to match the snapshot's; a mismatch — or a name the device will not give — makes the run
//    VOID (exit 4) and NO per-param verdict is reported. Fail closed: a void run must not look like a
//    clean one, and it must not look like a device finding either. Case/padding are normalised because the
//    unit upper-cases its own display, but both raw strings are printed so a human can see what happened.
//
// 2. TOLERANCE FROM THE DISPLAY'S OWN PRECISION — the tolerance was an absolute magnitude ladder, which is
//    a guess about how many digits the unit prints. It is now half of the last printed digit of the
//    device's OWN string: "5.00" → 0.005 (so 5.005 vs 5.00 is a match, which is the true case that
//    motivated this), "5000.1" → 0.05, "10000" → 0.5. A match that only passes because the display is
//    COARSE (|diff| beyond a quarter of the half-ulp) is counted and printed separately, so a coarse
//    display cannot silently hide a real defect.
//
// KNOWN UNRESOLVED (reported, not hidden): a few replies decode to null in the codec (a whole class of
// valid 60-byte view-0x00 frames — see review-2026-10-13), and some device strings are parenthesised
// ("(500 ms)") or non-numeric ("LFO1 SYNC"), which `parseDisplayValue` cannot read. Those print as
// UNREADABLE / UNPARSED with the matched frame length.
//
// USAGE  npx tsx scripts/audit-taper-vs-device.ts [--all] [--block 62]
// ────────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { patchNameQuery } from './standing-read.js';
import { adaptRequest } from '../src/services/deviceCache.js';
import type { Transport } from '../src/transport/types.js';
import { buildValueQuery, decodeReply, parseDisplayValue } from 'forgefx-midi/cache';

/**
 * Read ONE param's formatted display string from the instrument, through the HW-proven reply matcher.
 * Returns the frame (for reporting its length) and the decoded string when the reply is a value view.
 */
async function readFormattedValue(
  transport: Transport,
  eid: number,
  pid: number
): Promise<{ frame: Uint8Array | null; disp: string | null }> {
  const frame = await adaptRequest(transport, buildValueQuery(MODEL, eid, pid));
  if (!frame) return { frame: null, disp: null };
  const dec = decodeReply(frame);
  return { frame, disp: dec && dec.view === 'value' ? dec.value : null };
}

const MODEL = 0x11;
const SNAPSHOT = `${process.env.HOME}/.hermes/cache/scratch/taper-audit/params-snapshot.json`;
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');

interface SnapParam {
  id: number;
  name?: string;
  value?: number;
  norm?: number;
  min?: number;
  max?: number;
  log?: boolean;
  unit?: string;
}
interface SnapBlock {
  eid: number;
  name?: string;
  channel?: string;
  params: SnapParam[];
}
interface Snapshot {
  preset?: string;
  /** Optional: a hash of the body the server served, when the snapshotter recorded one. */
  bodyHash?: string;
  at?: string;
  blocks: SnapBlock[];
}

/** Normalise a preset name for comparison: case- and whitespace-insensitive, nothing else. */
function normName(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toUpperCase();
}

/**
 * Tolerance: HALF THE LAST PRINTED DIGIT of the unit's own string — the quantisation the unit itself
 * builds in. Falls back to a relative epsilon when the string carries no digits.
 */
function toleranceFromDisplay(disp: string, ours: number): { tol: number; ulp: number } {
  const m = /-?\d+(?:\.(\d+))?/.exec(disp);
  const decimals = m && m[1] ? m[1].length : 0;
  const ulp = Math.pow(10, -decimals);
  const tol = Math.max(ulp / 2, Math.abs(ours) * 1e-6);
  return { tol, ulp };
}

/** Read the unit's OWN current preset name (fn=0x0D, read-only). Empty string when it will not answer. */
async function devicePresetName(transport: Transport): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const frames = await transport.request(patchNameQuery(), { timeoutMs: 900, quietMs: 60 });
    const f = frames.find((x) => x[5] === 0x0d);
    if (f) {
      const body = f.slice(6, -2).filter((b) => b >= 0x20 && b < 0x7f);
      const name = String.fromCharCode(...body).trim();
      if (name) return name;
    }
  }
  return '';
}

export async function main(argv: string[]): Promise<number> {
  const all = argv.includes('--all');
  const argOf = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const onlyBlock = argOf('--block') ? Number(argOf('--block')) : undefined;
  const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Snapshot;

  // Every param our tables call LOG (the heuristic's output), plus a few LINEAR ones with non-zero values
  // as CONTROLS: a control that matches shows the pipeline works and isolates the failure to the taper.
  const targets: { b: SnapBlock; p: SnapParam; why: string }[] = [];
  for (const b of snap.blocks) {
    if (onlyBlock !== undefined && b.eid !== onlyBlock) continue;
    for (const p of b.params) {
      if (p.value == null || p.value === 0) continue; // a 0-vs-0 comparison proves nothing
      if (p.log) targets.push({ b, p, why: 'log' });
      else if (all) targets.push({ b, p, why: 'linear(control)' });
    }
  }
  if (!targets.length) {
    console.log('nothing to check — the snapshot has no non-zero params matching the filter');
    return 2;
  }

  const opened = await openProbeSession(MODEL);
  if (!opened.ok) {
    console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`);
    return 3;
  }
  const s = opened.session;
  let match = 0;
  let coarse = 0;
  let mismatch = 0;
  let unreadable = 0;
  const bad: string[] = [];
  try {
    // ── STATE GUARD ────────────────────────────────────────────────────────────────────────────────
    // An oracle must prove both sides describe the SAME object. Nothing below is a measurement until it does.
    const snapName = (snap.preset ?? '').trim();
    const devName = await devicePresetName(s.transport);
    console.log(`identity — snapshot: ${JSON.stringify(snapName)}${snap.at ? ` @ ${snap.at}` : ''}${
      snap.bodyHash ? ` bodyHash ${snap.bodyHash.slice(0, 12)}` : ''
    }`);
    console.log(`identity — device  : ${JSON.stringify(devName)}`);
    if (!devName) {
      console.log('\nVOID RUN — the unit did not report its preset name, so the snapshot and the unit');
      console.log('cannot be shown to be the same object. No per-param verdict is reported. (exit 4)');
      return 4;
    }
    if (normName(devName) !== normName(snapName)) {
      console.log('\nVOID RUN — the unit is on a DIFFERENT preset than the snapshot describes.');
      console.log('Re-anchor: take a fresh server snapshot while the unit sits still, then re-run.');
      console.log('Nothing below would have been a device finding. (exit 4)');
      return 4;
    }

    console.log(`\ntaper audit vs the INSTRUMENT — preset “${snap.preset ?? '?'}”, ${targets.length} params`);
    console.log('READ-ONLY (view 0x00). “ours” = what the server serves; “device” = the unit’s own string.\n');
    console.log('blk ch  pid  name                 ours           device          tol        verdict');
    console.log('--- --  ---  -------------------  -------------  --------------  ---------  -------');
    for (const { b, p, why } of targets) {
      // USE THE HW-PROVEN ADAPTER, do not re-implement matching. `adaptRequest` (services/deviceCache.ts)
      // is the CaptureRig matcher the live-walk uses: it matches on the fn, the VIEW echo (f[6]), the
      // BLOCK-HIGH echo (f[9]) and both PARAM bytes (f[10]/f[11]) — the device does NOT echo block-low
      // (its inner[2] is a constant), and a hand-rolled `f[8] === eid` check is exactly the bug that once
      // wedged the query stream (FORGEFX-32). It returns ONE matched frame, which is what decodeReply wants.
      // Retry a couple of times before believing a silence; a miss is not evidence.
      let disp: string | null = null;
      let lens: number[] = [];
      for (let attempt = 0; attempt < 3 && disp == null && !lens.length; attempt += 1) {
        const decoded = await readFormattedValue(s.transport, b.eid, p.id);
        if (decoded.frame != null) lens = [decoded.frame.length];
        if (decoded.disp != null) disp = decoded.disp;
        else if (decoded.frame == null) lens = [];
      }
      const last = lens.length ? lens : null;
      const dev = disp != null ? parseDisplayValue(disp) : null;
      const ours = p.value as number;
      let verdict: string;
      let tolStr = '—';
      if (dev == null) {
        verdict = disp == null ? 'UNREADABLE' : `UNPARSED (“${disp}”)`;
        unreadable += 1;
        // Report the frame LENGTHS (and how many arrived) rather than a hex blob: a truncated fragment is
        // the failure this probe has actually hit, and its length is what shows it.
        bad.push(
          `${b.name ?? b.eid}/${p.id} ${p.name ?? ''}: ${verdict} — matched frame length ${last ? last.join('/') : 'none (no frame echoed this param)'}`
        );
      } else {
        const { tol, ulp } = toleranceFromDisplay(disp as string, ours);
        tolStr = String(Number(tol.toPrecision(3)));
        const diff = Math.abs(ours - dev);
        if (diff <= tol) {
          match += 1;
          // Passed, but only because the displayed number is coarse — say so rather than banking it.
          const isCoarse = diff > ulp / 4;
          if (isCoarse) coarse += 1;
          verdict = isCoarse ? 'match (coarse display)' : 'match';
        } else {
          verdict = `MISMATCH ${why}`;
          mismatch += 1;
          bad.push(
            `${b.name ?? b.eid}/${p.id} ${p.name ?? ''}: ours ${ours} vs device ${dev} (±${tolStr}) (${why})`
          );
        }
      }
      console.log(
        `${String(b.eid).padStart(3)} ${String(b.channel ?? '?').padStart(2)}  ${String(p.id).padStart(3)}  ${(
          p.name ?? ''
        ).slice(0, 19).padEnd(19)}  ${String(ours).padEnd(13)}  ${String(disp ?? '—').padEnd(14)}  ${tolStr.padEnd(9)}  ${verdict}`
      );
    }
    console.log(`\nsummary: ${match} match (${coarse} only within a coarse display), ${mismatch} MISMATCH, ${unreadable} unreadable`);
    if (bad.length) {
      console.log('\n--- everything that did not match ---');
      for (const line of bad) console.log('  ' + line);
    }
    return mismatch > 0 ? 1 : 0;
  } finally {
    await s.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).then((c) => process.exit(c));
