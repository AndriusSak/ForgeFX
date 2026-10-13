// ────────────────────────────────────────────────────────────────────────────────────────────────
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
// USAGE  npx tsx scripts/audit-taper-vs-device.ts [--all] [--block 62]
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
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

/** Tolerance: the unit prints a limited number of digits, and our step adds quantisation. */
function tolerance(p: SnapParam): number {
  const mag = Math.max(Math.abs(p.value ?? 0), Math.abs(p.max ?? 0), 1e-9);
  const digits = mag >= 10000 ? 1 : mag >= 1000 ? 0.5 : mag >= 100 ? 0.05 : mag >= 10 ? 0.05 : 0.005;
  return Math.max(digits, 1e-9);
}

export async function main(argv: string[]): Promise<number> {
  const all = argv.includes('--all');
  const argOf = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const onlyBlock = argOf('--block') ? Number(argOf('--block')) : undefined;
  const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as { preset?: string; blocks: SnapBlock[] };

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
  let mismatch = 0;
  let unreadable = 0;
  const bad: string[] = [];
  try {
    console.log(`taper audit vs the INSTRUMENT — preset “${snap.preset ?? '?'}”, ${targets.length} params`);
    console.log('READ-ONLY (view 0x00). “ours” = what the server serves; “device” = the unit’s own string.\n');
    console.log('blk ch  pid  name                 ours           device          verdict');
    console.log('--- --  ---  -------------------  -------------  --------------  -------');
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
      if (dev == null) {
        verdict = disp == null ? 'UNREADABLE' : `UNPARSED (“${disp}”)`;
        unreadable += 1;
        // Report the frame LENGTHS (and how many arrived) rather than a hex blob: a truncated fragment is
        // the failure this probe has actually hit, and its length is what shows it.
        bad.push(
          `${b.name ?? b.eid}/${p.id} ${p.name ?? ''}: ${verdict} — matched frame length ${last ? last.join('/') : 'none (no frame echoed this param)'}`
        );
      } else if (Math.abs(ours - dev) <= tolerance(p)) {
        verdict = 'match';
        match += 1;
      } else {
        verdict = `MISMATCH ${why}`;
        mismatch += 1;
        bad.push(`${b.name ?? b.eid}/${p.id} ${p.name ?? ''}: ours ${ours} vs device ${dev} (${why})`);
      }
      console.log(
        `${String(b.eid).padStart(3)} ${String(b.channel ?? '?').padStart(2)}  ${String(p.id).padStart(3)}  ${(
          p.name ?? ''
        ).slice(0, 19).padEnd(19)}  ${String(ours).padEnd(13)}  ${String(disp ?? '—').padEnd(14)}  ${verdict}`
      );
    }
    console.log(`\nsummary: ${match} match, ${mismatch} MISMATCH, ${unreadable} unreadable`);
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
