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
// ── THE HARDENINGS (each taught by a run that lied, 2026-10-13; broadened 2026-10-13 after a review) ──
//
// 1. STATE GUARD — a comparison across two different objects is not a measurement, and it must FAIL
//    CLOSED. Identity is checked in four parts; the first three are checked ONCE at the start, the
//    fourth repeatedly during the run:
//
//    (a) NAME — the unit's own preset name is read (fn=0x0D) and parsed by the codec's
//        `parseQueryPatchNameResponse` (imported from the `forgefx-midi/gen3/axe-fx-iii` SUBPATH, not the
//        Node-only barrel). Case/whitespace are normalised; a mismatch — or a name the unit will not give
//        — makes the run VOID (exit 4) with NO per-param verdicts, and both raw strings are printed.
//
//    (b) BODY — the unit's edit-buffer BODY is hashed (sha256) through the driver's `presetBodyHex()`
//        (reusing the existing dump machinery; no hand-rolled frame). The comparison is presented under
//        BOTH hash conventions and BOTH byte prefixes (see HASH CONVENTIONS below); exact equality is
//        preferred, and a mere prefix relationship is only honoured when the recorded hash is at least
//        MIN_HASH_MATCH_LEN (16) hex chars — a 1-char recorded hash can no longer pass by chance. If the
//        snapshot records a `bodyHash`, a mismatch makes the run VOID (exit 4). If the snapshot records
//        NO bodyHash, the body could not be identity-checked: that is printed as an UNPROVEN-identity
//        WARNING and the run cannot report a clean pass (exit 6). The OBSERVED body hash is written to an
//        artifact beside the snapshot so the NEXT run can be pointed at it as a baseline.
//
//    (c) SCENE / CHANNEL — the scene index (fn=0x0C) and each block's active channel (fn=0x13) are
//        checked where BOTH the snapshot and the unit supply them. A mismatch is VOID (exit 4). Where the
//        snapshot records no scene, or the unit cannot report a channel, a WARNING is printed instead of
//        silently passing (exit 6). Channel COVERAGE is reported explicitly (how many blocks with a
//        snapshot channel were actually checked): ZERO coverage and PARTIAL coverage are printed as
//        DIFFERENT lines — "0 checked" and "1 of 5 checked" do not look alike.
//
//    (d) DRIFT — the body hash, the scene index AND the per-block channels are re-read every N=50 params
//        AND once at the end of the run, and the channels are re-checked at the end too. If any of them
//        MOVES during the run the run is VOID with a DISTINCT exit code (5), naming the first param after
//        which it moved. If a guard that was readable at the start can no longer be READ mid-run (body,
//        scene or channel) that is UNKNOWN, not "unchanged", and the run is VOID FAIL-CLOSED (exit 7).
//        N=50 because each body dump is one heavy 0x77/0x78/0x79 round-trip against ~251 light value
//        reads, so ≤6 dumps bound the cost at ~2% of the frames while catching a mid-run move within 50.
//
// 2. VERDICTS ARE BUFFERED UNTIL THE LAST GUARD HAS PASSED. Every per-param line (and the table header)
//    is buffered and printed only AFTER the final drift/identity check has passed. A VOID run therefore
//    prints ONLY the void reason, and the code's own claim ("no per-param verdict is reported on a VOID
//    run") is true of the LOG, not just of the exit code — before this fix a move detected at the FINAL
//    check exited 5 after every per-param line had already been printed.
//
// 3. TOLERANCE FROM THE DISPLAY'S OWN PRECISION — half of the last printed digit of the device's OWN
//    string: "5.00" → 0.005 (so 5.005 vs 5.00 is a match), "5000.1" → 0.05, "10000" → 0.5. A match that
//    only passes because the display is COARSE (|diff| beyond a quarter of the half-ulp) is counted and
//    printed separately, so a coarse display cannot silently hide a real defect.
//
// 4. UNREADABLE rows print the BYTES of the matched frame — a decode-null can be diagnosed from the
//    artifact instead of re-running against the unit. The `hex` helper is actually used for this.
//
// ── HASH CONVENTIONS (do not silently pick one) ──────────────────────────────────────────────────
// The snapshot's `bodyHash` may have been produced by ANY of these, and they are NOT interchangeable:
//   bytes        sha256 over the edit-buffer body BYTES, full.
//   bytes-minus4 sha256 over the body bytes with the FIRST 4 BYTES dropped.
//   hexstr       sha256 over the ASCII HEX STRING of the body (this is the Axis/e2e-hil/proof.mjs
//                convention — `createHash('sha256').update(hexString)`).
//   hexstr-minus4 the same, over the hex string with its first 8 characters (4 bytes) dropped.
// Axis/e2e-hil/proof.mjs hashes the /api/preset/body HEX STRING, which carries a 4-byte prefix the
// edit-buffer dump this tool reads does not — so a hash copied straight out of proof.json will only
// match through the hexstr / hexstr-minus4 candidates. Every comparison prints WHICH convention and
// which byte prefix it assumed, plus both raw hashes, so a mismatch is diagnosable rather than opaque.
//
// KNOWN UNRESOLVED (reported, not hidden): a few replies decode to null in the codec (a whole class of
// valid 60-byte view-0x00 frames — see review-2026-10-13), and some device strings are parenthesised
// ("(500 ms)") or non-numeric ("LFO1 SYNC"), which `parseDisplayValue` cannot read. Those print as
// UNREADABLE / UNPARSED together with the matched frame's bytes and length.
//
// EXIT: 0 clean · 1 MISMATCH · 2 nothing to check · 3 no device · 4 VOID (identity mismatch) ·
//       5 VOID (body/scene/channel moved during the run) · 6 completed with a WARNING (an identity
//       was not fully checkable) · 7 VOID (a guard readable at the start could not be RE-READ mid-run —
//       UNKNOWN, fail closed) · 70 transport/run CRASH (a throw is never a device finding) ·
//       78 --self-test failure.
//
// USAGE  npx tsx scripts/audit-taper-vs-device.ts [--all] [--block 62]
//        npx tsx scripts/audit-taper-vs-device.ts --self-test   # offline, no hardware, no serial port
// ────────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
/** Where the OBSERVED body hash is written so the next run can use it as a baseline. */
const OBSERVED_BODY_ARTIFACT = `${process.env.HOME}/.hermes/cache/scratch/taper-audit/observed-body.json`;
/** Re-read the body + scene + channels this often (see hardenings §1d). */
const DRIFT_CHECK_EVERY = 50;
/**
 * Minimum length (hex chars) for a PREFIX relationship to count as a body-hash match. Exact equality is
 * always preferred; below this floor only an exact equality passes, so a 1-char recorded hash cannot
 * pass by chance. 16 hex chars = 64 bits — the reviewer's stated reasonable floor.
 */
const MIN_HASH_MATCH_LEN = 16;
/** Exit code for a transport/run crash — never the same as "MISMATCH found" (1). */
const EXIT_CRASH: number = 70;
/** Exit code for a failed --self-test. */
const EXIT_SELF_TEST_FAIL: number = 78;
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

/** sha256 hex of a STRING (utf8) — the Axis/e2e-hil/proof.mjs convention for a hex body string. */
function sha256String(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

interface HashCandidate {
  label: string;
  value: string;
}

/**
 * Every hash a snapshot's `bodyHash` might legitimately be, under BOTH conventions and BOTH byte
 * prefixes. The tool never picks one silently — all four are offered to `hashMatches` and printed.
 */
function hashCandidatesFromBytes(bytes: Uint8Array): HashCandidate[] {
  const buf = Buffer.from(bytes);
  const minus4 = buf.subarray(4);
  const hexFull = buf.toString('hex');
  const hexMinus4 = hexFull.slice(8); // drop the first 8 hex chars = 4 bytes
  return [
    { label: 'bytes', value: sha256(buf) },
    { label: 'bytes-minus4', value: sha256(minus4) },
    { label: 'hexstr', value: sha256String(hexFull) },
    { label: 'hexstr-minus4', value: sha256String(hexMinus4) },
  ];
}

interface HashMatch {
  ok: boolean;
  how: string;
}

/**
 * Does a computed body hash match the snapshot's recorded `bodyHash`?
 *
 * EXACT equality is preferred (any convention). A PREFIX relationship in either direction is only
 * honoured when the recorded hash is at least `minLen` hex chars — with no minimum a 1-character
 * recorded hash passed by chance. The return value names WHICH convention matched (or why none did).
 */
function hashMatches(candidates: HashCandidate[], recorded: string, minLen = MIN_HASH_MATCH_LEN): HashMatch {
  const r = recorded.trim().toLowerCase().replace(/^0x/, '');
  if (!r) return { ok: false, how: 'recorded hash is empty' };
  // 1. exact equality across every candidate convention.
  for (const c of candidates) {
    if (c.value.toLowerCase() === r) return { ok: true, how: `exact (${c.label})` };
  }
  // 2. prefix relationship, only with a real minimum length on the recorded side.
  if (r.length < minLen) {
    return { ok: false, how: `no exact match; recorded hash is ${r.length} hex char(s) < min ${minLen} — a prefix this short is not accepted` };
  }
  for (const c of candidates) {
    const cLow = c.value.toLowerCase();
    if (cLow.startsWith(r)) return { ok: true, how: `prefix — recorded ${r.length}/${cLow.length} hex of ${c.label}` };
    if (r.startsWith(cLow) && cLow.length >= minLen) {
      return { ok: true, how: `prefix — ${c.label} ${cLow.length} hex is a prefix of the recorded ${r.length} hex` };
    }
  }
  return { ok: false, how: 'no candidate convention matches (exact or prefix)' };
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

interface ObservedBody {
  len: number;
  candidates: HashCandidate[];
}

/** The unit's edit-buffer BODY, via the driver's existing dump machinery (read-only). */
async function deviceBody(driver: DeviceDriver): Promise<ObservedBody | null> {
  try {
    const b = await driver.presetBodyHex?.();
    if (!b || !b.hex) return null;
    const bytes = Buffer.from(b.hex, 'hex');
    return { len: bytes.length, candidates: hashCandidatesFromBytes(bytes) };
  } catch {
    return null;
  }
}

/** Write the OBSERVED body hash to an artifact beside the snapshot, so the next run has a baseline. */
function writeObservedBody(snap: Snapshot, body: ObservedBody): string | null {
  try {
    mkdirSync(dirname(OBSERVED_BODY_ARTIFACT), { recursive: true });
    const payload = {
      at: new Date().toISOString(),
      preset: snap.preset ?? null,
      len: body.len,
      candidates: Object.fromEntries(body.candidates.map((c) => [c.label, c.value])),
      note: 'bodyHash candidates under BOTH conventions (bytes / hex string) and BOTH prefixes (full / minus4). Copy the matching one into the snapshot as `bodyHash` so the next run can identity-check the body.',
    };
    writeFileSync(OBSERVED_BODY_ARTIFACT, JSON.stringify(payload, null, 2) + '\n');
    return OBSERVED_BODY_ARTIFACT;
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

/** The exit code for a completed run, in ONE place so a crash can never read as a device finding. */
function exitCodeFor(o: { mismatch: number; warning: boolean }): number {
  if (o.warning) return 6;
  return o.mismatch > 0 ? 1 : 0;
}

/**
 * A buffer for the human-readable table. Per-param lines are PUSHED here and printed only by `flush()`.
 * A run that returns VOID before flushing prints nothing from the table — so no per-param verdict can
 * appear on a VOID run.
 */
function makeTableBuffer() {
  const lines: string[] = [];
  let voided = false;
  return {
    push(line: string) {
      lines.push(line);
    },
    /** Mark the run VOID: nothing buffered may ever be printed. */
    markVoid() {
      voided = true;
    },
    get buffered(): number {
      return lines.length;
    },
    flush(out: (s: string) => void) {
      if (voided) return;
      for (const l of lines) out(l);
    },
  };
}

type DriftResult = { kind: 'ok' } | { kind: 'moved' } | { kind: 'unknown'; what: string };

type ChanEndResult = 'ok' | 'moved' | 'unknown';

// ── OFFLINE SELF-TEST ────────────────────────────────────────────────────────────────────────────
// Exercises the pieces whose control flow is checkable WITHOUT the serial port: the hash matcher (both
// conventions, the minimum-length floor), the verdict buffer, and the exit-code mapping. Run with
// `--self-test`; needs no device and does not touch /dev/ttyACM0.
function runSelfTest(): number {
  const results: string[] = [];
  let failures = 0;
  const check = (name: string, ok: boolean, detail = '') => {
    results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures += 1;
  };

  const sample = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 0xff);
  const cands = hashCandidatesFromBytes(sample);
  const byLabel = (l: string) => cands.find((c) => c.label === l)!.value;

  // hash matcher — exact equality under each convention.
  for (const l of ['bytes', 'bytes-minus4', 'hexstr', 'hexstr-minus4']) {
    const m = hashMatches(cands, byLabel(l));
    check(`hash: exact ${l}`, m.ok && m.how.startsWith('exact'), m.how);
  }
  // The proof.mjs convention (sha256 of the HEX STRING) must be reachable.
  check(
    'hash: proof.mjs hex-string convention matches',
    hashMatches(cands, sha256String(Buffer.from(sample).toString('hex'))).ok
  );
  // A 1-char recorded hash must NOT pass by chance (the old code accepted it).
  const oneChar = byLabel('bytes').slice(0, 1);
  check('hash: 1-char recorded hash is rejected', !hashMatches(cands, oneChar).ok);
  // A prefix shorter than the 16-char floor is rejected; at/above the floor it is accepted.
  check('hash: 8-char prefix rejected', !hashMatches(cands, byLabel('bytes').slice(0, 8)).ok);
  check('hash: 20-char prefix accepted', hashMatches(cands, byLabel('bytes').slice(0, 20)).ok);
  // A wrong hash is rejected.
  check('hash: unrelated hash rejected', !hashMatches(cands, 'deadbeef'.repeat(8)).ok);

  // verdict buffer — a run that does not flush prints NOTHING; a flushed run prints every line.
  const emitted: string[] = [];
  const voidBuf = makeTableBuffer();
  voidBuf.push('header');
  voidBuf.push('row 1');
  voidBuf.markVoid();
  voidBuf.flush((s) => emitted.push(s));
  check('buffer: VOID run emits no per-param lines', emitted.length === 0, `emitted ${emitted.length}`);

  const cleanBuf = makeTableBuffer();
  cleanBuf.push('header');
  cleanBuf.push('row 1');
  cleanBuf.flush((s) => emitted.push(s));
  check('buffer: clean run emits header + rows in order', emitted.length === 2 && emitted[0] === 'header' && emitted[1] === 'row 1');

  // Likewise, a run that simply never flushes (returns VOID before the end) prints nothing.
  const noFlush: string[] = [];
  const unflushed = makeTableBuffer();
  unflushed.push('row 1');
  check('buffer: unflushed buffer emits nothing', noFlush.length === 0 && unflushed.buffered === 1);

  // exit-code mapping.
  check('exit: clean → 0', exitCodeFor({ mismatch: 0, warning: false }) === 0);
  check('exit: mismatch → 1', exitCodeFor({ mismatch: 3, warning: false }) === 1);
  check('exit: warning beats mismatch → 6', exitCodeFor({ mismatch: 3, warning: true }) === 6);
  // A crash must be distinguishable from "MISMATCH found".
  check('exit: crash code is 70', EXIT_CRASH === 70);
  check('exit: crash code differs from mismatch 1', EXIT_CRASH !== 1);

  for (const l of results) console.log(l);
  console.log(`\nself-test: ${results.length - failures}/${results.length} passed${failures ? ` — ${failures} FAILED` : ' — OK'}`);
  return failures ? EXIT_SELF_TEST_FAIL : 0;
}

export async function main(argv: string[]): Promise<number> {
  if (argv.includes('--self-test')) return runSelfTest();

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
  /** Per-param lines are buffered here and printed ONLY after the final guard passes (hardenings §2). */
  const table = makeTableBuffer();
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

    // (b) BODY identity — required-match when the snapshot records a hash, else an UNPROVEN warning.
    const body0 = await deviceBody(s.driver);
    if (body0) {
      const artifact = writeObservedBody(snap, body0);
      console.log(`identity — observed body ${body0.len} B; both hash conventions (${
        body0.candidates.map((c) => c.label).join(', ')
      })${artifact ? ` written to ${artifact}` : ' (artifact write failed)'}`);
      console.log(
        '  convention: sha256 over BOTH the raw BYTES and the ASCII HEX STRING, each full AND with the\n' +
          '  first 4 bytes / 8 hex chars dropped — proof.mjs hashes the /preset/body HEX STRING, which\n' +
          '  carries a 4-byte prefix the edit-buffer dump does not; the snapshot hash is assumed to be one\n' +
          '  of these and every convention is tried (exact match preferred).'
      );
    }
    if (snap.bodyHash) {
      if (!body0) {
        console.log('\nVOID RUN — the snapshot records a bodyHash, but the unit\'s body could NOT be read');
        console.log('(presetBodyHex returned nothing). The two objects cannot be shown to match. (exit 4)');
        return 4;
      }
      const hm = hashMatches(body0.candidates, snap.bodyHash);
      if (!hm.ok) {
        console.log('\nVOID RUN — the unit\'s BODY does not match the snapshot\'s bodyHash.');
        console.log(`  snapshot bodyHash ${snap.bodyHash}`);
        console.log(`  unit body ${body0.len} B, candidates:`);
        for (const c of body0.candidates) console.log(`    ${c.label.padEnd(13)} ${c.value}`);
        console.log(`  match attempt: ${hm.how}`);
        console.log('The preset NAME matches but the body under it has changed (a same-name body change),');
        console.log('or the snapshot hash used a convention/prefix none of the four above reproduces.');
        console.log('Nothing below would have been a device finding. (exit 4)');
        return 4;
      }
      console.log(`identity — device body ${body0.len} B  MATCHES the snapshot bodyHash (${hm.how})`);
    } else if (!body0) {
      console.log('\nWARNING — UNPROVEN body identity: the snapshot records NO bodyHash and the unit\'s body');
      console.log('could not be read, so the body could NOT be identity-checked. This run is NOT a clean');
      console.log('pass. (exit 6)');
      warning = true;
    } else {
      console.log('\nWARNING — UNPROVEN body identity: the snapshot records NO bodyHash, so the unit\'s body');
      console.log(`could NOT be identity-checked (the NAME matches; the body reads ${body0.len} B,`);
      console.log(`candidates ${body0.candidates.map((c) => `${c.label}=${c.value.slice(0, 12)}`).join(' ')}).`);
      console.log('A same-name body change before this run would be invisible here. Point the next snapshot');
      console.log(`at the observed artifact${writeObservedBody(snap, body0) ? '' : ' (write failed)'} as a baseline. NOT a clean pass. (exit 6)`);
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

    // (c) CHANNEL identity — each block's active channel, where both sides give it, WITH coverage count.
    const channels0 = await deviceChannels(s.driver);
    const chanScope = snap.blocks.filter((b) => onlyBlock === undefined || b.eid === onlyBlock);
    const chanCandidates = chanScope.filter((b) => !!b.channel);
    if (!channels0 || channels0.size === 0) {
      console.log('identity — channel: the unit did not report per-block channels (fn=0x13 empty) → the');
      console.log('block channels could not be identity-checked. Not a clean pass. (exit 6)');
      warning = true;
    } else {
      let checked = 0;
      const chanMismatch: string[] = [];
      const chanUncovered: string[] = [];
      for (const b of chanCandidates) {
        const live = channels0.get(b.eid);
        const liveLetter = live == null ? undefined : CHANNEL_LETTERS[live];
        if (live == null || !liveLetter) {
          chanUncovered.push(b.name ?? String(b.eid));
          continue;
        }
        checked += 1;
        if (liveLetter !== b.channel!.trim().toUpperCase()) {
          chanMismatch.push(`${b.name ?? b.eid}: snapshot channel ${b.channel} vs unit channel ${liveLetter}`);
        }
      }
      if (chanMismatch.length) {
        console.log('\nVOID RUN — the unit\'s active CHANNEL differs from the snapshot\'s on:');
        for (const m of chanMismatch) console.log(`  ${m}`);
        console.log('The served params describe a different channel\'s values. Nothing below is a measurement. (exit 4)');
        return 4;
      }
      const denom = chanCandidates.length;
      console.log(`identity — channel coverage: ${checked}/${denom} block(s) carrying a snapshot channel were checked against the unit (of ${chanScope.length} in scope, ${snap.blocks.length} in the snapshot)`);
      if (checked === 0) {
        console.log('  COVERAGE ZERO — no block carried BOTH a snapshot channel AND a unit channel → channel UNVERIFIED. Not a clean pass. (exit 6)');
        warning = true;
      } else if (checked < denom) {
        console.log(`  PARTIAL COVERAGE — ${denom - checked} block(s) had no unit channel and were NOT checked: ${chanUncovered.join(', ')} → channel only partially verified. Not a clean pass. (exit 6)`);
        warning = true;
      }
    }

    // ── The table (header + every per-param line) is BUFFERED, never printed here. ──────────────────
    table.push(`\ntaper audit vs the INSTRUMENT — preset “${snap.preset ?? '?'}”, ${targets.length} params`);
    table.push('READ-ONLY (view 0x00). “ours” = what the server serves; “device” = the unit’s own string.');
    table.push(`body+scene+channels drift re-checked every ${DRIFT_CHECK_EVERY} params and once at the end.\n`);
    table.push('blk ch  pid  name                 ours           device          tol        verdict');
    table.push('--- --  ---  -------------------  -------------  --------------  ---------  -------');

    /**
     * Re-read body + scene; return a drift verdict. An UNREADABLE guard that was readable at the start is
     * UNKNOWN (fail closed), not "unchanged" — the reviewer's defect 2.
     */
    const checkDrift = async (afterParam: string): Promise<DriftResult> => {
      const b = await deviceBody(s.driver);
      const sc = await deviceScene(s.driver);
      if (body0 && !b) {
        console.log(`\nVOID RUN — the body drift guard could not be RE-READ after ${afterParam}.`);
        console.log('A guard readable at the start that reads nothing mid-run is UNKNOWN, not unchanged.');
        console.log('Fail closed. No per-param verdict. (exit 7)');
        return { kind: 'unknown', what: 'body' };
      }
      if (body0 && b) {
        const m = bodyHashMatchesObserved(body0, b);
        if (!m) {
          console.log(`\nVOID RUN — the unit's BODY moved DURING the run, after ${afterParam}.`);
          console.log(`  start body ${body0.len} B  bytes sha256 ${byLabelOf(body0, 'bytes')}`);
          console.log(`  now   body ${b.len} B  bytes sha256 ${byLabelOf(b, 'bytes')}`);
          console.log('A same-name body change makes every comparison below a lie. No per-param verdict. (exit 5)');
          return { kind: 'moved' };
        }
      }
      if (scene0 != null && sc == null) {
        console.log(`\nVOID RUN — the scene guard could not be RE-READ after ${afterParam} (start scene ${scene0}).`);
        console.log('An unreadable scene mid-run is UNKNOWN, not unchanged. Fail closed. No per-param');
        console.log('verdict is reported. (exit 7)');
        return { kind: 'unknown', what: 'scene' };
      }
      if (scene0 != null && sc != null && sc !== scene0) {
        console.log(`\nVOID RUN — the unit's SCENE moved DURING the run (${scene0} → ${sc}), after ${afterParam}.`);
        console.log('Per-channel values differ per scene. No per-param verdict is reported. (exit 5)');
        return { kind: 'moved' };
      }
      return { kind: 'ok' };
    };

    for (let i = 0; i < targets.length; i += 1) {
      const { b, p, why } = targets[i]!;
      // (d) DRIFT — re-read the body + scene every N params, BEFORE processing this one.
      if (i > 0 && i % DRIFT_CHECK_EVERY === 0) {
        const prev = targets[i - 1]!;
        const d = await checkDrift(`${prev.b.name ?? prev.b.eid}/${prev.p.id} (${prev.p.name ?? ''})`);
        if (d.kind === 'moved') return 5;
        if (d.kind === 'unknown') return 7;
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
      // BUFFER the line — it is printed only after the FINAL guard passes (hardenings §2).
      table.push(
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
    if (finalDrift.kind === 'moved') return 5;
    if (finalDrift.kind === 'unknown') return 7;

    // (d) CHANNEL — re-check the per-block channels at the END as well (they were never re-checked before).
    const chEndRes = await recheckChannels();
    if (chEndRes === 'moved') return 5;
    if (chEndRes === 'unknown') return 7;

    // ── Every guard has passed: now (and only now) emit the buffered per-param table. ────────────────
    table.flush((line) => console.log(line));

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
      console.log('\nWARNING: a body/scene/channel identity could NOT be fully checked this run —');
      console.log('the NAME matched but the body was not comparable to a recorded hash, or coverage was');
      console.log('partial. NOT a clean pass. (exit 6)');
      return 6;
    }
    return exitCodeFor({ mismatch, warning });

    /**
     * Re-read the per-block channels at the END and compare to the start. A channel that MOVED is VOID
     * (5); one that was readable at the start and is not re-readable now is UNKNOWN, fail closed (7).
     */
    async function recheckChannels(): Promise<ChanEndResult> {
      if (!channels0 || channels0.size === 0) return 'ok';
      const chEnd = await deviceChannels(s.driver);
      if (!chEnd || chEnd.size === 0) {
        console.log('\nVOID RUN — the per-block channel guard could not be RE-READ at the end of the run.');
        console.log('A guard readable at the start that reads nothing now is UNKNOWN. Fail closed. (exit 7)');
        return 'unknown';
      }
      const moved: string[] = [];
      let missing = 0;
      for (const [eid, ch] of channels0) {
        const now = chEnd.get(eid);
        if (now == null) {
          missing += 1;
          continue;
        }
        if (now !== ch) moved.push(`${eid}: ${CHANNEL_LETTERS[ch] ?? ch} → ${CHANNEL_LETTERS[now] ?? now}`);
      }
      if (moved.length) {
        console.log('\nVOID RUN — the unit\'s active CHANNEL moved DURING the run:');
        for (const m of moved) console.log(`  ${m}`);
        console.log('Per-channel values differ per channel. No per-param verdict is reported. (exit 5)');
        return 'moved';
      }
      if (missing > 0) {
        console.log(`\nVOID RUN — ${missing} block channel(s) readable at the start could not be RE-READ at the`);
        console.log('end of the run. UNKNOWN is not "unchanged". Fail closed. (exit 7)');
        return 'unknown';
      }
      return 'ok';
    }
  } finally {
    await s.close();
  }
}

/** True when two body reads carry the same bytes-hash (the drift guard's baseline comparison). */
function bodyHashMatchesObserved(a: ObservedBody, b: ObservedBody): boolean {
  return byLabelOf(a, 'bytes') === byLabelOf(b, 'bytes');
}
function byLabelOf(body: ObservedBody, label: string): string {
  return body.candidates.find((c) => c.label === label)?.value ?? '';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2))
    .then((c) => process.exit(c))
    // Defect 4: a transport/run THROW must never exit with the MISMATCH code (1). Exit 70 instead, with
    // a one-line reason, so a crash can never be read as a device finding.
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`audit-taper-vs-device: transport/run CRASH (exit ${EXIT_CRASH}) — ${msg}`);
      process.exit(EXIT_CRASH);
    });
