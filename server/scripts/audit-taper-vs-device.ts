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
// READ-ONLY. The value reads are self-describe view 0x00. The STATE GUARD additionally makes three
// read-only identity reads: the unit's preset name (fn=0x0D), its edit-buffer BODY dump (the same
// 0x77/0x78/0x79 chain the server's own `/preset/body` uses — via the driver's `presetBodyHex`), the
// scene index (fn=0x0C) and the per-block active channel (fn=0x13). No write frames, nothing swept,
// nothing restored.
//
// The snapshot of what the server serves must be taken BEFORE this runs (the server holds the port):
//   GET /preset/blocks/<eid>/params  ->  ~/.hermes/cache/scratch/taper-audit/params-snapshot.json
//
// ── THE HARDENINGS (each taught by a run that lied, 2026-10-13) ──────────────────────────────────
//
// 1. STATE GUARD — a comparison across two different objects is not a measurement, and it must FAIL
//    CLOSED. Identity is checked in four parts; the first three are checked ONCE at the start, the
//    fourth repeatedly during the run:
//
//    (a) NAME — the unit's own preset name is read (fn=0x0D) and parsed by the codec's
//        `parseQueryPatchNameResponse` (imported from the `forgefx-midi/gen3/axe-fx-iii` SUBPATH, not the
//        Node-only barrel). The old code printable-filtered the whole frame body, which can absorb the
//        preset-NUMBER bytes and produce a spurious name mismatch. Case/whitespace are normalised; a
//        mismatch — or a name the unit will not give — makes the run VOID (exit 4) with NO per-param
//        verdicts, and both raw strings are printed.
//
//    (b) BODY — the unit's edit-buffer BODY is hashed (sha256) through the driver's `presetBodyHex()`
//        (reusing the existing dump machinery; no hand-rolled frame). If the snapshot records a
//        `bodyHash`, a mismatch makes the run VOID (exit 4). If the snapshot records NO bodyHash, the
//        body could not be identity-checked: that is printed as a WARNING and the run cannot report a
//        clean pass (exit 6). Both the full-body hash and the hash with a 4-byte prefix removed are
//        tried, because the server's `/preset/body` carries a 4-byte prefix the edit-buffer body lacks.
//
//    (c) SCENE / CHANNEL — the scene index (fn=0x0C) and each block's active channel (fn=0x13) are
//        checked where BOTH the snapshot and the unit supply them. A mismatch is VOID (exit 4): the
//        served params would describe a different scene's (or channel's) parameter values. Where the
//        snapshot records no scene, or the unit cannot report a channel, a WARNING is printed instead of
//        silently passing (exit 6).
//
//    (d) DRIFT — the body hash and the scene index are re-read every N=50 params AND once at the end of
//        the run. If either MOVES during the run the run is VOID with a DISTINCT exit code (5) and NO
//        per-param verdicts, naming the first param after which it moved. N=50 because each body dump is
//        one heavy 0x77/0x78/0x79 round-trip against ~251 light value reads, so ≤6 dumps bound the cost
//        at ~2% of the frames while catching a mid-run move within 50 params.
//
// 2. TOLERANCE FROM THE DISPLAY'S OWN PRECISION — the tolerance was an absolute magnitude ladder, which is
//    a guess about how many digits the unit prints. It is now half of the last printed digit of the
//    device's OWN string: "5.00" → 0.005 (so 5.005 vs 5.00 is a match, which is the true case that
//    motivated this), "5000.1" → 0.05, "10000" → 0.5. A match that only passes because the display is
//    COARSE (|diff| beyond a quarter of the half-ulp) is counted and printed separately, so a coarse
//    display cannot silently hide a real defect.
//
// 3. UNREADABLE rows print the BYTES of the matched frame — a decode-null can be diagnosed from the
//    artifact instead of re-running against the unit. The `hex` helper is actually used for this.
//
// KNOWN UNRESOLVED (reported, not hidden): a few replies decode to null in the codec (a whole class of
// valid 60-byte view-0x00 frames — see review-2026-10-13), and some device strings are parenthesised
// ("(500 ms)") or non-numeric ("LFO1 SYNC"), which `parseDisplayValue` cannot read. Those print as
// UNREADABLE / UNPARSED together with the matched frame's bytes and length.
//
// EXIT: 0 clean · 1 MISMATCH · 2 nothing to check · 3 no device · 4 VOID (identity mismatch) ·
//       5 VOID (body/scene moved during the run) · 6 completed with a WARNING (body/scene not identity-checked).
//
// USAGE  npx tsx scripts/audit-taper-vs-device.ts [--all] [--block 62]
// ────────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { patchNameQuery } from './standing-read.js';
import { adaptRequest } from '../src/services/deviceCache.js';
import type { Transport } from '../src/transport/types.js';
import type { DeviceDriver } from '../src/drivers/types.js';
import { parseQueryPatchNameResponse, isQueryPatchNameResponse } from 'forgefx-midi/gen3/axe-fx-iii';
import { buildValueQuery, decodeReply, parseDisplayValue } from 'forgefx-midi/cache';

/**
 * Read ONE param's formatted display string from the instrument, through the HW-proven reply matcher.
 * Returns the matched frame (for its length AND its bytes) and the decoded string when the reply is a
 * value view.
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
/** Re-read the body + scene this often (see hardenings §1d). */
const DRIFT_CHECK_EVERY = 50;
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const CHANNEL_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const;

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
  /** Optional: the scene index the snapshot was taken on. */
  scene?: number;
  at?: string;
  blocks: SnapBlock[];
}

/** Normalise a preset name for comparison: case- and whitespace-insensitive, nothing else. */
function normName(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toUpperCase();
}

/** sha256 hex of a byte array. */
function sha256(bytes: Uint8Array | number[]): string {
  return createHash('sha256').update(Buffer.from(bytes as Uint8Array)).digest('hex');
}

/**
 * Does a computed body hash match the snapshot's recorded `bodyHash`? The snapshotter may record a full
 * 64-char sha256, a truncated prefix, or a hash of the server's `/preset/body` hex — which carries a
 * 4-byte prefix the edit-buffer body lacks. So: compare the full body hash AND the hash with the first 4
 * bytes dropped, accepting an exact match or a prefix relationship in either direction.
 */
function hashMatches(computed: string[], recorded: string): boolean {
  const r = recorded.trim().toLowerCase().replace(/^0x/, '');
  if (!r) return false;
  return computed.some((c) => {
    const cLow = c.toLowerCase();
    return cLow === r || cLow.startsWith(r) || r.startsWith(cLow);
  });
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

/**
 * Read the unit's OWN current preset name through the codec's proper parser (fn=0x0D, read-only). Using
 * `parseQueryPatchNameResponse` — instead of printable-filtering whole-frame bytes — keeps the preset
 * NUMBER bytes out of the name. Returns the name and the preset number (or empty name) when it answers.
 */
async function devicePresetName(transport: Transport): Promise<{ name: string; number: number | null }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const frames = await transport.request(patchNameQuery(MODEL), { timeoutMs: 900, quietMs: 60 });
    const f = frames.find((x) => isQueryPatchNameResponse(x, MODEL));
    if (f) {
      try {
        const r = parseQueryPatchNameResponse(f, MODEL);
        if (r.name) return { name: r.name, number: r.presetNumber };
      } catch {
        /* not a well-formed 0x0D reply — fall through to a retry */
      }
    }
  }
  return { name: '', number: null };
}

/** The unit's edit-buffer BODY hash, via the driver's existing dump machinery (read-only). */
async function deviceBody(driver: DeviceDriver): Promise<{ sha: string; shaMinus4: string; len: number } | null> {
  try {
    const b = await driver.presetBodyHex?.();
    if (!b || !b.hex) return null;
    const bytes = Buffer.from(b.hex, 'hex');
    return { sha: sha256(bytes), shaMinus4: sha256(bytes.subarray(4)), len: bytes.length };
  } catch {
    return null;
  }
}

/** The unit's current scene index (fn=0x0C, read-only), or null if the driver cannot report it. */
async function deviceScene(driver: DeviceDriver): Promise<number | null> {
  try {
    const r = await driver.getScene?.();
    return r ? r.index : null;
  } catch {
    return null;
  }
}

/** The unit's live active channel per placed block (effectId → 0..n), or null when unavailable. */
async function deviceChannels(driver: DeviceDriver): Promise<Map<number, number> | null> {
  try {
    const m = await driver.getActiveChannels?.();
    return m ?? null;
  } catch {
    return null;
  }
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
  /** A WARNING (not a VOID, not a pass): the identity could not be fully checked, so no clean exit. */
  let warning = false;
  let match = 0;
  let coarse = 0;
  let mismatch = 0;
  let unreadable = 0;
  const bad: string[] = [];
  const unreadableFrames: string[] = [];
  try {
    // ── STATE GUARD (a)(b)(c) — identity at the START of the run ────────────────────────────────────
    // An oracle must prove both sides describe the SAME object. Nothing below is a measurement until it does.
    const snapName = (snap.preset ?? '').trim();
    const dev = await devicePresetName(s.transport);
    const devName = dev.name;
    console.log(`identity — snapshot: ${JSON.stringify(snapName)}${snap.at ? ` @ ${snap.at}` : ''}${
      snap.bodyHash ? ` bodyHash ${snap.bodyHash.slice(0, 12)}` : ' (no bodyHash recorded)'
    }${snap.scene != null ? ` scene ${snap.scene}` : ' (no scene recorded)'}`);
    console.log(`identity — device  : ${JSON.stringify(devName)}${
      dev.number != null ? ` (preset #${dev.number})` : ''
    }`);
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

    // (b) BODY identity — required-match when the snapshot records a hash, else a WARNING (never a pass).
    const body0 = await deviceBody(s.driver);
    if (snap.bodyHash) {
      if (!body0) {
        console.log('\nVOID RUN — the snapshot records a bodyHash, but the unit\'s body could NOT be read');
        console.log('(presetBodyHex returned nothing). The two objects cannot be shown to match. (exit 4)');
        return 4;
      }
      if (!hashMatches([body0.sha, body0.shaMinus4], snap.bodyHash)) {
        console.log('\nVOID RUN — the unit\'s BODY does not match the snapshot\'s bodyHash.');
        console.log(`  snapshot bodyHash ${snap.bodyHash}`);
        console.log(`  unit body  ${body0.len} B  sha256 ${body0.sha}`);
        console.log('The preset NAME matches but the body under it has changed (a same-name body change).');
        console.log('Nothing below would have been a device finding. (exit 4)');
        return 4;
      }
      console.log(`identity — device body ${body0.len} B  sha256 ${body0.sha}  MATCHES the snapshot bodyHash`);
    } else if (!body0) {
      console.log('\nWARNING — the snapshot records NO bodyHash and the unit\'s body could not be read, so');
      console.log('the body could NOT be identity-checked. This run is NOT a clean pass. (exit 6)');
      warning = true;
    } else {
      console.log(`\nWARNING — the snapshot records NO bodyHash, so the unit's body could NOT be identity-`);
      console.log(`checked (the NAME matches; the body reads ${body0.len} B sha256 ${body0.sha}).`);
      console.log('A same-name body change before this run would be invisible here. NOT a clean pass. (exit 6)');
      warning = true;
    }

    // (c) SCENE identity — checked when the snapshot records one; otherwise a WARNING.
    const scene0 = await deviceScene(s.driver);
    if (snap.scene != null) {
      if (scene0 == null) {
        console.log('\nVOID RUN — the snapshot records scene ' + snap.scene + ' but the unit will not report');
        console.log('a scene index, so the two cannot be shown to be the same scene. (exit 4)');
        return 4;
      }
      if (scene0 !== snap.scene) {
        console.log(`\nVOID RUN — the unit is on SCENE ${scene0} but the snapshot describes scene ${snap.scene}.`);
        console.log('Per-channel parameter values differ per scene. Nothing below is a measurement. (exit 4)');
        return 4;
      }
      console.log(`identity — device scene ${scene0}  MATCHES the snapshot scene`);
    } else if (scene0 == null) {
      console.log('identity — scene: NOT recorded in the snapshot and the unit would not report one → the');
      console.log('scene could not be identity-checked. Not a clean pass. (exit 6)');
      warning = true;
    } else {
      console.log(`identity — device scene ${scene0}; the snapshot records NO scene, so the scene could not`);
      console.log('be identity-checked. Not a clean pass. (exit 6)');
      warning = true;
    }

    // (c) CHANNEL identity — each block's active channel, where both sides give it.
    const channels0 = await deviceChannels(s.driver);
    if (!channels0 || channels0.size === 0) {
      console.log('identity — channel: the unit did not report per-block channels (fn=0x13 empty) → the');
      console.log('block channels could not be identity-checked. Not a clean pass. (exit 6)');
      warning = true;
    } else {
      let checked = 0;
      const chanMismatch: string[] = [];
      for (const b of snap.blocks) {
        if (onlyBlock !== undefined && b.eid !== onlyBlock) continue;
        const live = channels0.get(b.eid);
        if (live == null || !b.channel) continue;
        const liveLetter = CHANNEL_LETTERS[live];
        if (!liveLetter) continue;
        checked += 1;
        if (liveLetter !== b.channel.trim().toUpperCase()) {
          chanMismatch.push(`${b.name ?? b.eid}: snapshot channel ${b.channel} vs unit channel ${liveLetter}`);
        }
      }
      if (chanMismatch.length) {
        console.log('\nVOID RUN — the unit\'s active CHANNEL differs from the snapshot\'s on:');
        for (const m of chanMismatch) console.log(`  ${m}`);
        console.log('The served params describe a different channel\'s values. Nothing below is a measurement. (exit 4)');
        return 4;
      }
      console.log(`identity — channel: ${checked}/${snap.blocks.length} block(s) checked against the unit, all match`);
      if (checked === 0) {
        console.log('  (no block carried BOTH a snapshot channel and a unit channel → channel unverified)');
        warning = true;
      }
    }

    console.log(`\ntaper audit vs the INSTRUMENT — preset “${snap.preset ?? '?'}”, ${targets.length} params`);
    console.log('READ-ONLY (view 0x00). “ours” = what the server serves; “device” = the unit’s own string.');
    console.log(`body+scene drift re-checked every ${DRIFT_CHECK_EVERY} params and once at the end.\n`);
    console.log('blk ch  pid  name                 ours           device          tol        verdict');
    console.log('--- --  ---  -------------------  -------------  --------------  ---------  -------');

    /** Re-read body + scene; return a drift verdict (or a lost-guard warning). */
    const checkDrift = async (afterParam: string): Promise<'ok' | 'moved' | 'lost'> => {
      const b = await deviceBody(s.driver);
      const sc = await deviceScene(s.driver);
      if (body0 && (!b || b.sha !== body0.sha)) {
        if (!b) {
          console.log(`\nWARNING — body drift guard lost: presetBodyHex returned nothing after ${afterParam}.`);
          warning = true;
          return 'lost';
        }
        console.log(`\nVOID RUN — the unit's BODY moved DURING the run, after ${afterParam}.`);
        console.log(`  start body ${body0.len} B sha256 ${body0.sha}`);
        console.log(`  now   body ${b.len} B sha256 ${b.sha}`);
        console.log('A same-name body change makes every comparison below a lie. No per-param verdict. (exit 5)');
        return 'moved';
      }
      if (scene0 != null && sc != null && sc !== scene0) {
        console.log(`\nVOID RUN — the unit's SCENE moved DURING the run (${scene0} → ${sc}), after ${afterParam}.`);
        console.log('Per-channel values differ per scene. No per-param verdict is reported. (exit 5)');
        return 'moved';
      }
      return 'ok';
    };

    for (let i = 0; i < targets.length; i += 1) {
      const { b, p, why } = targets[i]!;
      // (d) DRIFT — re-read the body + scene every N params, BEFORE processing this one.
      if (i > 0 && i % DRIFT_CHECK_EVERY === 0) {
        const prev = targets[i - 1]!;
        const d = await checkDrift(`${prev.b.name ?? prev.b.eid}/${prev.p.id} (${prev.p.name ?? ''})`);
        if (d === 'moved') return 5;
      }
      // USE THE HW-PROVEN ADAPTER, do not re-implement matching. `adaptRequest` (services/deviceCache.ts)
      // is the CaptureRig matcher the live-walk uses: it matches on the fn, the VIEW echo (f[6]), the
      // BLOCK-HIGH echo (f[9]) and both PARAM bytes (f[10]/f[11]) — the device does NOT echo block-low
      // (its inner[2] is a constant), and a hand-rolled `f[8] === eid` check is exactly the bug that once
      // wedged the query stream (FORGEFX-32). It returns ONE matched frame, which is what decodeReply wants.
      // Retry a couple of times before believing a silence; a miss is not evidence.
      let frame: Uint8Array | null = null;
      let disp: string | null = null;
      for (let attempt = 0; attempt < 3 && disp == null && frame == null; attempt += 1) {
        const decoded = await readFormattedValue(s.transport, b.eid, p.id);
        if (decoded.frame) frame = decoded.frame;
        if (decoded.disp != null) disp = decoded.disp;
      }
      const dev2 = disp != null ? parseDisplayValue(disp) : null;
      const ours = p.value as number;
      let verdict: string;
      let tolStr = '—';
      if (dev2 == null) {
        verdict = disp == null ? 'UNREADABLE' : `UNPARSED (“${disp}”)`;
        unreadable += 1;
        // Report the matched frame's BYTES (and length): a truncated fragment OR a codec decode-null is
        // diagnosed from this artifact rather than by re-running against the unit.
        const lenText = frame ? `${frame.length} B` : 'none (no frame echoed this param)';
        const hexText = frame ? hex(Array.from(frame)) : '—';
        bad.push(
          `${b.name ?? b.eid}/${p.id} ${p.name ?? ''}: ${verdict} — matched frame ${lenText} ${hexText}`
        );
        unreadableFrames.push(
          `${b.name ?? b.eid}/${p.id} ${p.name ?? ''}  ${verdict}  ${lenText}\n    ${hexText}`
        );
      } else {
        const { tol, ulp } = toleranceFromDisplay(disp as string, ours);
        tolStr = String(Number(tol.toPrecision(3)));
        const diff = Math.abs(ours - dev2);
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
            `${b.name ?? b.eid}/${p.id} ${p.name ?? ''}: ours ${ours} vs device ${dev2} (±${tolStr}) (${why})`
          );
        }
      }
      console.log(
        `${String(b.eid).padStart(3)} ${String(b.channel ?? '?').padStart(2)}  ${String(p.id).padStart(3)}  ${(
          p.name ?? ''
        ).slice(0, 19).padEnd(19)}  ${String(ours).padEnd(13)}  ${String(disp ?? '—').padEnd(14)}  ${tolStr.padEnd(9)}  ${verdict}`
      );
    }

    // (d) DRIFT — final re-check after the last param, so a move in the tail is still caught.
    const lastTarget = targets[targets.length - 1]!;
    const finalDrift = await checkDrift(
      `${lastTarget.b.name ?? lastTarget.b.eid}/${lastTarget.p.id} (${lastTarget.p.name ?? ''}) [end of run]`
    );
    if (finalDrift === 'moved') return 5;

    console.log(`\nsummary: ${match} match (${coarse} only within a coarse display), ${mismatch} MISMATCH, ${unreadable} unreadable`);
    if (unreadableFrames.length) {
      console.log('\n--- UNREADABLE / UNPARSED — matched FRAME BYTES (diagnose the decode-null from this) ---');
      for (const blk of unreadableFrames) console.log('  ' + blk);
    }
    if (bad.length) {
      console.log('\n--- everything that did not match ---');
      for (const line of bad) console.log('  ' + line);
    }
    if (warning) {
      console.log('\nWARNING: the body and/or the scene could NOT be fully identity-checked this run —');
      console.log('the NAME matched but the body was not comparable to a recorded hash. NOT a clean pass. (exit 6)');
      return 6;
    }
    return mismatch > 0 ? 1 : 0;
  } finally {
    await s.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).then((c) => process.exit(c));
