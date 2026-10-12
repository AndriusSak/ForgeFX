// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-2e-lever-cable — ROUND 15f. LEVER B (add/remove a routing CABLE) of the head-record
// analysis, pre-registered in review-2026-10-12/ANALYSIS-2E-HEAD-RECORDS.md (d). DRY-RUN by default:
// without `--go` it reads only and prints the plan + the prediction table; NOTHING is written.
//
// ════════════════════════════════════════════════════════════════════════════════════════════════
// PRE-COMMITTED PREDICTION (H_CABLE — copied verbatim from ANALYSIS-2E-HEAD-RECORDS.md (d); written
// before the first frame is sent, and REPRODUCED so this file is self-contained):
//
//   The head keys on grid STATE, not merely on the placed-instance set: a cable is a grid-state
//   change, so **record #3 moves — data 26 (the layer that already proved non-clean under both
//   placement and body-dump) changes value while data 25 holds; data 27 does not move. NO other head
//   record moves (record #3 is the only one that moves).** The TAIL changes in exactly the two cells
//   the cable touches (the `cableInputMask` byte, bits 7-0 of the cell, per `parseFm3GridLayout`).
//
//   FALSIFIED IF: no head record moves (then the head keys on placement only and cables are invisible
//   to it — H_CABLE dies and H_TYPE's framing survives for cables too); OR data 25 moves (then cables
//   and placement share one content carrier, and data 26 is not the wiring layer).
//
// THE DISCRIMINATOR (why this is a test and not a restatement). A cable adds/removes NO block and
// changes no eid set, so the two candidate readings of the head give DIFFERENT values for the exact
// rows about to be set: H_CABLE says head record #3's data 26 MOVES; H_PLACEMENT-ONLY says every one
// of the 44 head records HOLDS. The script prints that table (with the live before-values) BEFORE any
// write and REFUSES TO RUN if the predictions do not differ (§ the DISC-CHECK below). A discriminator
// whose test values already agree under both hypotheses is not a test.
//
// ── RESTORE-PROOF DESIGN (mandatory; the edit buffer holds the owner's UNSAVED PP#23 edit) ─────────
//   * W1 is a DISCONNECT and W2 is its EXACT INVERSE: the same edge (srcRow, route 11) → (route 3,
//     route 12), the same address bytes, only the op flips (ROUTE_OP 0x02 → 0x01). Nothing else is
//     written — no cell, no param, no slot, no preset select, no reload.
//   * The restore is PROVED THROUGH THE EDIT-BUFFER BODY (fn=0x77/0x78/0x79 → decodeRawPatch), a
//     DIFFERENT opcode path than the `fn=0x01 sub=0x2e` reply this arm compares. A read-back of the
//     `0x2e` TAIL on the SAME path is NOT accepted as proof. `bodyBefore` is captured before W1 and the
//     body is re-dumped after W2; it must read byte-identical.
//   * FALLBACK if the body does NOT return byte-identical: reload the CAPTURED before-dump into the
//     edit buffer with `loadPresetBytes` (NO slot written). NEVER a preset select / slot reload: the
//     edit buffer holds the owner's UNSAVED PP#23 edit and a reload DISCARDS it.
//   * A `finally` block reconnects the cable if the run exits with it still disconnected (fail closed).
//
// ── SAFETY (design constraints, not preferences) ────────────────────────────────────────────────────
//   * BREAK A BRANCH, NEVER THE CHAIN. The target is Out 2 at route r3c12 (row 3, col 12). Before any
//     write the script reads the target cell's feed from the `0x2e` TAIL via `cableInputMask` (and
//     cross-checks the dump grid) and VERIFIES the edge feeds a BRANCH; it FAILS CLOSED (exit 2) if it
//     does not. The mechanical branch proof: the destination cell sits in the LAST column (col 12), and
//     a cable never runs right-to-left (dest column is implicit = srcCol+1 ≤ 12), so a col-12 cell has
//     NO successor — removing its incoming edge can only silence that output, it can NEVER disconnect
//     any other block from the input. Belt-and-braces: the destination row must NOT be the main-chain
//     row (row 1), and the source cell (srcRow, route 11) must be an occupied cell.
//   * Mask ONLY the derived per-READ trio data 22/23/24. NEVER mask 25/26/27 — masking them hid the
//     answering record and produced a FALSE NEGATIVE in ROUND 15. Data 24 is EXCLUDED from every
//     record-#3 comparison (it is per-read volatile).
//   * NO preset slot is touched. U0001/U0012 (the owner's "LT TV Mix 7") are never referenced; this arm
//     writes to the EDIT BUFFER only (cable routing is an edit-buffer edit, no `store`).
//   * CONTROLS. `sub 0x99` must come back SILENT (positive control on a negative). A STABILITY control
//     is measured on rows the arm does NOT expect to move: head record #4 (data 32..39) and the row-1
//     chain tail cell route r1c3.
//   * guardFirmwareFamily() is applied by openProbeSession() (probe-device.ts:1021), which wraps
//     transport.request/send — so every frame this script emits (including buildSetGridRouting through
//     driver.cable(), fn=0x01 sub=0x35) can never be fn 0x7d/0x7e/0x7f. 0x79 is the preset-dump FOOTER.
//   * FORGEFX_TAP APPENDS. Name it explicitly AND per run; a re-run into the same path silently
//     concatenates two experiments, so the script REFUSES an existing --tap path unless --tap-append.
//     With no --tap it UNSETS the variable (a leftover export would append into a stale fixture).
//
// ── PRE-FLIGHT (run BEFORE this, read-only) ─────────────────────────────────────────────────────────
//   `npx tsx scripts/probe-grid-baseline.ts` proves: (a) the `sub 0x99` negative control is silent and
//   the standing-read controls are green; (b) the edit-buffer BODY oracle is byte-stable with nothing
//   written between two dumps; (c) the dump grid and the `0x2e` TAIL agree; (d) WHICH cells are empty;
//   (e) whether the edit buffer is IN SYNC with slot 410. The operator confirms the grid baseline by
//   running it and reading `VERDICT: PRE-FLIGHT GREEN`. If it says the edit buffer is NOT IN SYNC, that
//   is expected (the owner's unsaved edit) and it REINFORCES that a reload is destructive — the arm's
//   only restore is W2 plus the loadPresetBytes fallback.
//
// USAGE
//   npx tsx scripts/probe-2e-lever-cable.ts                        # DRY RUN: plan + prediction table
//   npx tsx scripts/probe-2e-lever-cable.ts --go                   # executes (owner's go-ahead required)
//   npx tsx scripts/probe-2e-lever-cable.ts --go --tap <fresh.tap> # global capture (must be a new path)
// Exit 0 green · 2 refused / a control or the restore failed · 3 no device · 4 dry-run (nothing written).
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { standingRead, standingLine, subQuery } from './standing-read.js';
import { parsePresetDump, decodeRawPatch } from 'forgefx-midi/devices/gen3';
import { buildRequestGridLayout, parseGen3GridLayout } from 'forgefx-midi/gen3/axe-fx-iii';

const MODEL = 0x11;
const EDIT_BUFFER = 0x3fff;
const CONTENT_BASE = 12;

/** FM3 routing grid: 4 rows × 12 cols (route pair, 1-based — the /preset/grid/cell contract). */
const ROUTE_ROWS = 4;
const ROUTE_COLS = 12;
/** TARGET — Out 2 at route r3c12, the branch the cable feeds. NOT the row-1 main chain. */
const TARGET_ROW = 3;
const TARGET_COL = 12;
/** The destination column is implicit = srcCol + 1, so a cable feeding route r{c} leaves route c-1. */
const SRC_COL = TARGET_COL - 1; // 11

/** The DERIVED per-READ volatile trio ONLY. Never widen this over 25/26/27 (ROUND 15 false negative). */
const MASK = [22, 23, 24];
/** Head record #3 in the differ's `data` space = data 24..31. Data 24 is per-read volatile. */
const REC3_LO = 24;
const REC3_HI = 32;
const REC3_VOLATILE = [24];
/** Stability control: head record #4 (data 32..39), one value across the whole 835-reply corpus. */
const STAB_REC_LO = 32;
const STAB_REC_HI = 40;
/** Stability control on the TAIL: an OCCUPIED main-chain cell far from the write.
 *
 *  MEASURED DEFECT, fixed after the first run (2026-10-12 19:51Z): this was route r1c3, and route row 1 is
 *  EMPTY on this preset, so its mask printed `absent` in baseline/before/noop/during/after — a control that
 *  CANNOT FAIL is not a control ("a discriminator whose test values already agree under both hypotheses is
 *  not a test"). Row 2 is the main chain and holds 12 blocks; c3 (block 0x5e) is far from the r2c11→r3c12
 *  edge under test. The head-side control (record #4) was real and did hold. */
const STAB_ROUTE: { row: number; col: number } = { row: 2, col: 3 };

/** The stage-tap filename slug. ONE definition: the printed follow-up command names these files, and on the
 *  first run it printed `lever-cable-baseline_no_write_.tap` while the file on disk is
 *  `lever-cable-baseline_no-write_.tap` — a printed command that does not run is a defect in the tool. */
const slugify = (s: string): string => s.replace(/[^A-Za-z0-9.-]+/g, '_');

const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── the candidate hypotheses, and what EACH predicts for the exact rows about to be set ──────────
type Move = 'MOVES' | 'HOLDS';
type HypId = 'H_CABLE' | 'H_PLACEMENT_ONLY' | 'H_SHARED';
const HYPS: { id: HypId; text: string }[] = [
  { id: 'H_CABLE', text: 'head keys on grid STATE — a cable is a grid-state change (PRE-COMMITTED)' },
  { id: 'H_PLACEMENT_ONLY', text: 'head keys only on the placed-instance set (a cable adds/removes no block)' },
  { id: 'H_SHARED', text: 'cables and placement share ONE data-25 content carrier' }
];
interface PredRow { row: string; off: string; p: Record<HypId, Move> }
const PRED_ROWS: PredRow[] = [
  { row: 'record #3 · data 25 (placed/model carrier)', off: 'data 25', p: { H_CABLE: 'HOLDS', H_PLACEMENT_ONLY: 'HOLDS', H_SHARED: 'MOVES' } },
  { row: 'record #3 · data 26 (the wiring layer)', off: 'data 26', p: { H_CABLE: 'MOVES', H_PLACEMENT_ONLY: 'HOLDS', H_SHARED: 'MOVES' } },
  { row: 'record #3 · data 27', off: 'data 27', p: { H_CABLE: 'HOLDS', H_PLACEMENT_ONLY: 'HOLDS', H_SHARED: 'HOLDS' } },
  { row: 'the other 42 head records (#0..#2, #4..#43)', off: 'data≠24..31', p: { H_CABLE: 'HOLDS', H_PLACEMENT_ONLY: 'HOLDS', H_SHARED: 'HOLDS' } },
  { row: `TAIL dest cell r${TARGET_ROW}c${TARGET_COL} cableInputMask`, off: 'tail r3c12', p: { H_CABLE: 'MOVES', H_PLACEMENT_ONLY: 'MOVES', H_SHARED: 'MOVES' } },
  { row: `TAIL stability control route r${STAB_ROUTE.row}c${STAB_ROUTE.col} (row-1 chain)`, off: 'tail r1c3', p: { H_CABLE: 'HOLDS', H_PLACEMENT_ONLY: 'HOLDS', H_SHARED: 'HOLDS' } }
];
/** The rows the arm exists to read. The predictions on THESE must differ across hypotheses. */
const DISCRIMINATOR_OFFS = ['data 25', 'data 26'];

function printDecisionTable(beforeRec3: string | null): { ok: boolean; reason: string } {
  console.log(`\n── DECISION TABLE — what each hypothesis PREDICTS for the exact rows about to be set ──`);
  console.log(`   live before-value: head record #3 (data 24..31) = ${beforeRec3 ?? '(read from the device after it connects)'}`);
  const w = 44;
  console.log(`   ${'row'.padEnd(w)} ${HYPS.map((h) => h.id.padEnd(17)).join('')}`);
  for (const r of PRED_ROWS) console.log(`   ${r.row.padEnd(w)} ${HYPS.map((h) => r.p[h.id].padEnd(17)).join('')}`);
  console.log(`   hypotheses:`);
  for (const h of HYPS) console.log(`     ${h.id} — ${h.text}`);
  const keyRows = PRED_ROWS.filter((r) => DISCRIMINATOR_OFFS.includes(r.off));
  const differential = keyRows.filter((r) => new Set(HYPS.map((h) => r.p[h.id])).size > 1);
  console.log(`   discrimination: of the ${keyRows.length} row(s) this arm reads (${DISCRIMINATOR_OFFS.join(', ')}), ${differential.length} carr(y/ies) differing predictions.`);
  if (differential.length === 0) {
    return { ok: false, reason: 'the test rows predict the SAME value under every hypothesis — a discriminator whose test values already agree is NOT a test' };
  }
  const hc = PRED_ROWS.find((r) => r.off === 'data 26')!;
  if (hc.p.H_CABLE === hc.p.H_PLACEMENT_ONLY) return { ok: false, reason: 'data 26 predicts the same under H_CABLE and H_PLACEMENT_ONLY — this arm would produce no information' };
  return { ok: true, reason: `H_CABLE vs H_PLACEMENT_ONLY differ on data 26 (${hc.p.H_CABLE} vs ${hc.p.H_PLACEMENT_ONLY}); H_SHARED is separated on data 25` };
}

interface Cell { row: number; col: number; effectId?: number; isShunt: boolean; cableInputMask: number }
const cellsKey = (r: number, c: number): string => `${r},${c}`; // 0-based

export async function main(argv: string[]): Promise<number> {
  const arg = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const go = argv.includes('--go');
  const reads = Math.max(4, Number(arg('--reads') ?? 8));
  const dwell = Math.max(0, Number(arg('--dwell') ?? 12));
  const outdir = (arg('--outdir') ?? '/home/insn/repos/stack/review-2026-10-12/lever-cable').replace('~', process.env.HOME ?? '');

  // ── FORGEFX_TAP: name it explicitly AND per run; it APPENDS, so refuse an existing path ──
  if (arg('--tap')) {
    const tap = arg('--tap')!;
    if (existsSync(tap) && !argv.includes('--tap-append')) {
      console.log(`REFUSING: tap ${tap} already exists. FORGEFX_TAP APPENDS every frame, so a re-run into the same path would silently concatenate two experiments. Pass a fresh path, or --tap-append if you really mean it.`);
      return 2;
    }
    process.env.FORGEFX_TAP = tap;
  } else {
    delete process.env.FORGEFX_TAP; // a leftover export would append into a stale fixture
  }

  console.log(`══ probe-2e-lever-cable — LEVER B (routing cable) for H_CABLE · ${go ? 'EXECUTING (--go)' : 'DRY RUN (nothing will be written)'} ══`);
  console.log(`tap: ${process.env.FORGEFX_TAP ?? '(none — global capture off; per-stage taps are written by this script)'}`);

  // ── THE PREDICTION TABLE IS PRINTED BEFORE ANY DEVICE IS OPENED, AND BEFORE ANY WRITE ──
  const table = printDecisionTable(null);
  console.log(`   verdict: ${table.ok ? 'the hypotheses DIFFER on the test rows ✔' : 'NOT A TEST ✘'}`);
  if (!table.ok) {
    console.log(`\nREFUSING: ${table.reason}. NOTHING WAS WRITTEN.`);
    return 2;
  }

  const opened = await openProbeSession(MODEL, arg('--port'));
  if (!opened.ok) { console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`); return 3; }
  const { session } = opened;
  const problems: string[] = [];
  let cableDown: { srcRow: number; connect: true } | null = null;
  let bodyBefore = '';
  let beforeSyx: number[] | null = null;

  try {
    console.log(`MASK (derived): ${MASK.join(',')} — NEVER 25/26/27. Data 24 is EXCLUDED from every record-#3 comparison.`);

    if (typeof session.driver.cable !== 'function') { console.log('this driver exposes no cable(); the arm is not runnable.'); return 2; }

    // ── 1. standing read (4 reads + 2 controls; the neg 0x99 control lives here) ──
    const sr = await standingRead(session, { note: 'R15f lever B (cable) — start' });
    console.log(`\n${standingLine(sr)}`);
    console.log(`  control · sub 0x99 (unmapped) → ${sr.controls.negativeSub99}  ${sr.controls.negativeSub99 === 'silent' ? '✔ (positive control on a negative holds)' : '✘ the link answers an unmapped sub — EVERYTHING below is untrustworthy'}`);
    if (sr.verdict !== 'read (controls green)') problems.push('standing read controls not green');
    if (sr.controls.negativeSub99 !== 'silent') problems.push('sub 0x99 was NOT silent (negative control failed)');

    // ── 2. read the target cell's feed from the 0x2e TAIL, cross-checked against the dump grid ──
    const gridReply = (await session.transport.request(buildRequestGridLayout(MODEL), { timeoutMs: 1500, quietMs: 100 }))
      .find((f) => f[5] === 0x01 && f[6] === 0x2e && f.length > 100);
    if (!gridReply) { console.log('no long sub=0x2e reply — cannot read the feed. NOT writing.'); return 2; }
    let liveCells: Cell[] = [];
    try { liveCells = parseGen3GridLayout(gridReply, MODEL); } catch (e) { console.log(`parseFm3GridLayout threw: ${(e as Error).message}. NOT writing.`); return 2; }
    const liveByKey = new Map(liveCells.map((c) => [cellsKey(c.row, c.col), c]));
    const content = gridReply.slice(CONTENT_BASE, gridReply.length - 2);
    const beforeRec3 = hex(content.slice(REC3_LO, REC3_HI));

    const target = liveByKey.get(cellsKey(TARGET_ROW - 1, TARGET_COL - 1));
    const dumpGrid = await session.driver.grid();
    const dumpTarget = dumpGrid.cells.find((c) => c.row === TARGET_ROW - 1 && c.col === TARGET_COL - 1);

    console.log(`\n── 2. the target cell (route r${TARGET_ROW}c${TARGET_COL} = Out 2, the BRANCH) ──`);
    console.log(`   0x2e TAIL  : ${target ? `${target.isShunt ? 'shunt' : `block 0x${target.effectId?.toString(16)}`} cableInputMask=0x${target.cableInputMask.toString(16)}` : 'ABSENT'}`);
    console.log(`   dump grid  : ${dumpTarget ? `${dumpTarget.isShunt ? 'shunt' : `block 0x${dumpTarget.effectId.toString(16)}`} “${dumpTarget.name}” routeFlag=0x${(dumpTarget.routeFlag ?? 0).toString(16)}` : 'ABSENT'}`);

    // ── BRANCH VERIFICATION — fail closed (exit 2) if the edge does NOT feed a branch ──
    let srcRow = -1;
    const mask = target?.cableInputMask ?? 0;
    const setBits = [0, 1, 2, 3].filter((b) => ((mask >> b) & 1) === 1);
    // FM3 packs source rows in bits 4-7 of the 32-bit cell (normalized >>4 here): bit b ⇒ source row b+1.
    const candidates = setBits.map((b) => b + 1).filter((r) => {
      const c = liveByKey.get(cellsKey(r - 1, SRC_COL - 1));
      return c !== undefined; // an occupied source cell (block or shunt) can source a cable
    });
    const forcedSrc = arg('--src-row') !== undefined ? parseInt(arg('--src-row')!, 10) : NaN;
    const branchChecks: { name: string; ok: boolean; detail: string }[] = [
      { name: 'B1 target cell present', ok: target !== undefined, detail: target ? 'present in the 0x2e TAIL' : 'absent from the 0x2e TAIL' },
      { name: 'B2 target is a real block (not a shunt)', ok: !!target && !target.isShunt, detail: target ? (target.isShunt ? 'shunt' : `block 0x${target.effectId?.toString(16)}`) : 'n/a' },
      { name: 'B3 destination is in the LAST column (leaf: no successor cell exists)', ok: TARGET_COL === ROUTE_COLS, detail: `col ${TARGET_COL} of ${ROUTE_COLS}` },
      { name: 'B4 destination is NOT the main-chain row (row 1)', ok: (TARGET_ROW as number) !== 1, detail: `row ${TARGET_ROW}` },
      { name: 'B5 the target has a real inbound feed (cableInputMask ≠ 0)', ok: mask !== 0, detail: `mask 0x${mask.toString(16)}` },
      { name: 'B6 exactly one occupied source cell among the mask bits', ok: candidates.length === 1 || (Number.isFinite(forcedSrc) && candidates.includes(forcedSrc)), detail: `mask bits {${setBits.join(',')}} → occupied source row(s) {${candidates.join(',')}}${Number.isFinite(forcedSrc) ? ` (forced --src-row ${forcedSrc})` : ''}` },
      { name: 'B7 the source cell (srcRow, route 11) is occupied', ok: candidates.length > 0 || Number.isFinite(forcedSrc), detail: candidates.length ? `row ${candidates[0]}` : 'no occupied source' }
    ];
    console.log(`   feed decoded from cableInputMask 0x${mask.toString(16)}: mask bits {${setBits.join(',')}} ⇒ candidate source row(s) {${candidates.join(',')}} (bit b ⇒ source row b+1)`);
    for (const b of branchChecks) console.log(`     ${b.ok ? '✔' : '✘'} ${b.name} — ${b.detail}`);
    const branchOk = branchChecks.every((b) => b.ok);
    if (!branchOk) {
      console.log('\nREFUSING: the chosen cable does NOT verifiably feed a BRANCH (see the ✘ above). Failing closed — NOTHING WAS WRITTEN.');
      return 2;
    }
    srcRow = Number.isFinite(forcedSrc) ? forcedSrc : candidates[0]!;
    console.log(`   ⇒ the cable to break feeds a BRANCH: route r${srcRow}c${SRC_COL} → route r${TARGET_ROW}c${TARGET_COL}. The row-1 main chain is untouched by construction.`);

    // ── 3. the live before-value the decision table's rows compare against (the table itself was
    //       printed BEFORE the device was opened, and its refuse-to-run guard already passed) ──
    console.log(`\n── 3. live before-value for the decision table ──`);
    console.log(`   head record #3 (data 24..31) = ${beforeRec3}  (compare against the PREDICTIONS printed above)`);

    // ── 4. plan ──
    const bit = 1 << (srcRow - 1);
    console.log(`\nPLAN (one edge, self-restoring, NO slot written, NO preset select):`);
    console.log(`  W1  cable(${srcRow}, ${SRC_COL}, ${TARGET_ROW}, connect=false)   ← DISCONNECT the branch feed (op 0x02)`);
    console.log(`  W2  cable(${srcRow}, ${SRC_COL}, ${TARGET_ROW}, connect=true)    ← the EXACT INVERSE (op 0x01); same edge, same address bytes`);
    console.log(`  expect: destination cableInputMask 0x${mask.toString(16)} → 0x${(mask & ~bit).toString(16)} (bit ${srcRow - 1} cleared) → back to 0x${mask.toString(16)}`);
    console.log(`  proof: the fn=0x77/0x78/0x79 EDIT-BUFFER BODY must read byte-identical before W1 and after W2 (a same-path 0x2e read-back is NOT proof).`);
    console.log(`  fallback if it does not: reload the captured before-dump via loadPresetBytes (NO slot written) — NEVER a preset select (the edit buffer holds the owner's unsaved PP#23 edit).`);
    console.log(`  stability control (rows NOT expected to move): head record #4 (data ${STAB_REC_LO}..${STAB_REC_HI - 1}) and tail route r${STAB_ROUTE.row}c${STAB_ROUTE.col}.`);
    if (!go) {
      console.log('\nDRY RUN — the plan above is what --go would execute. NOTHING WAS WRITTEN.');
      return 4;
    }

    // ── helpers ──
    const dumpRaw = async (): Promise<{ hex: string; syx: number[]; len: number }> => {
      const frames = await session.transport.request(session.codec.buildRequestPresetDump(EDIT_BUFFER), {
        timeoutMs: 8000, quietMs: 300, match: (fs) => fs.some((f) => f[5] === 0x79)
      });
      if (!frames.some((f) => f[5] === 0x79)) throw new Error(`incomplete dump (${frames.length} frames, no 0x79)`);
      const parsed = parsePresetDump(Uint8Array.from(frames.flat()), 0, MODEL);
      const { body } = decodeRawPatch(parsed.chunkPayloads);
      return { hex: Buffer.from(body).toString('hex'), syx: frames.flat(), len: body.length };
    };
    const settle = async (n = 4): Promise<void> => { for (let i = 0; i < n; i++) { await session.transport.request(subQuery(0x2e, [0, 0, 0, 0, 0]), { timeoutMs: 1200, quietMs: 80 }); await sleep(45); } };

    // ── 5. the no-write BASELINE + BEFORE (same rows, same connection, immediately before the arm) ──
    const d0 = await dumpRaw();
    bodyBefore = d0.hex; beforeSyx = d0.syx;
    console.log(`\nedit buffer before: ${d0.len} B  sha ${createHash('sha256').update(Buffer.from(d0.hex, 'hex')).digest('hex').slice(0, 16)}`);
    await settle(); // let the body-dump transient over 25/26/27 decay before measuring

    interface StageResult { label: string; rec3: Set<string>; rec3Stable: Set<string>; offs: Map<string, Set<string>>; replies: number; frames: number[][] }
    const stage = async (label: string, withDwell = false): Promise<StageResult> => {
      const frames: number[][] = [];
      const rec3 = new Set<string>(); const rec3Stable = new Set<string>();
      const offs = new Map<string, Set<string>>();
      const record = (f: number[]): void => {
        frames.push(f);
        const c = f.slice(CONTENT_BASE, f.length - 2);
        const r3 = c.slice(REC3_LO, REC3_HI);
        rec3.add(hex(r3));
        rec3Stable.add(hex(r3.map((b, i) => (REC3_VOLATILE.includes(REC3_LO + i) ? 0 : b))));
        const add = (k: string, v: string) => { if (!offs.has(k)) offs.set(k, new Set()); offs.get(k)!.add(v); };
        add('stabRec4(data32..39)', hex(c.slice(STAB_REC_LO, STAB_REC_HI)));
        try {
          const cells = parseGen3GridLayout(f, MODEL);
          const m = new Map(cells.map((x) => [cellsKey(x.row, x.col), x]));
          const cellMask = (r: number, c: number): string => {
            const cell = m.get(cellsKey(r - 1, c - 1));
            return cell === undefined ? 'absent' : `0x${cell.cableInputMask.toString(16)}`;
          };
          add(`targetMask(r${TARGET_ROW}c${TARGET_COL})`, cellMask(TARGET_ROW, TARGET_COL));
          add(`sourceMask(r${srcRow}c${SRC_COL})`, cellMask(srcRow, SRC_COL));
          add(`stabMask(r${STAB_ROUTE.row}c${STAB_ROUTE.col})`, cellMask(STAB_ROUTE.row, STAB_ROUTE.col));
        } catch { add('parse', 'THREW'); }
      };
      for (let i = 0; i < reads; i++) {
        const heard = await session.transport.request(buildRequestGridLayout(MODEL), { timeoutMs: 1500, quietMs: 100 });
        const f = heard.find((x) => x[5] === 0x01 && x[6] === 0x2e && x.length > 100);
        if (f) record(f);
        await sleep(45);
      }
      if (withDwell) for (let i = 0; i < dwell; i++) {
        const heard = await session.transport.request(buildRequestGridLayout(MODEL), { timeoutMs: 1500, quietMs: 100 });
        const f = heard.find((x) => x[5] === 0x01 && x[6] === 0x2e && x.length > 100);
        if (f) record(f);
        await sleep(250);
      }
      mkdirSync(outdir, { recursive: true });
      const slug = slugify(label);
      writeFileSync(join(outdir, `lever-cable-${slug}.tap`), frames.map((f) => `${Date.now()} RX ${hex(f)}`).join('\n') + '\n');
      const one = (s: Set<string>) => [...s].join(' | ');
      console.log(`  ${label.padEnd(24)} record#3(data24..31)=${one(rec3)}  stable[25..31]=${one(rec3Stable)}`);
      for (const [k, v] of offs) console.log(`      ${k.padEnd(28)} ${v.size === 1 ? v.values().next().value : one(v)}${v.size > 1 ? '  ✘ DRIFT' : ''}`);
      if (frames.length < reads) problems.push(`stage ${label} got ${frames.length}/${reads} replies`);
      for (const [k, v] of offs) if (k.startsWith('stab') && v.size > 1) problems.push(`STABILITY CONTROL moved in stage ${label}: ${k} = ${one(v)}`);
      return { label, rec3, rec3Stable, offs, replies: frames.length, frames };
    };

    console.log('\n── BASELINE (no-write, measured on the exact rows below, same connection, immediately before the arm) ──');
    const baseline = await stage('baseline(no-write)');
    console.log('\n── BEFORE (still no write; confirms the pre-write state is stable) ──');
    const before = await stage('before');

    /** The destination cell's cableInputMask as a stage read it — ONE definition, shared by the no-op check
     *  and by the pre-committed reading below (a second copy of this key string is exactly the drift that
     *  bites: the cell key must be built the same way in both places). */
    const maskOf = (s: StageResult): string => [...(s.offs.get(`targetMask(r${TARGET_ROW}c${TARGET_COL})`) ?? new Set(['<none>']))].join('|');

    // ── 5b. WRITE 0 — the FIRST-EVER CABLE FRAME, sent as a NO-OP ────────────────────────────────
    // MEASURED before this arm was written: NO tap in the corpus contains a `fn=01 sub=35` frame, so a
    // cable write has never been exercised on this unit and `buildSetGridRouting` is unproven here. So
    // before breaking anything, assert the state that ALREADY holds — connect=true on an edge that is
    // already connected — and require BOTH the edit-buffer BODY and the destination's cableInputMask to be
    // unchanged. If either moves, the frame does not mean what the codec says it means: stop, put the buffer
    // back, and report, having changed nothing. (The frame sent here is the same one W2 must send anyway,
    // so this adds detection, not exposure.)
    console.log(`\nWRITE 0 (no-op probe) — cable(${srcRow}, ${SRC_COL}, ${TARGET_ROW}, connect=true): assert the state that ALREADY exists (first fn=01 sub=35 frame this project has ever sent)`);
    const w0 = await session.driver.cable!(srcRow, SRC_COL, TARGET_ROW, true);
    await sleep(500);
    await settle();
    console.log('── NO-OP CHECK (nothing may move) ──');
    const noop = await stage('noop');
    const dNoop = await dumpRaw();
    const noopBodySame = dNoop.hex === bodyBefore;
    const noopMaskSame = maskOf(noop) === maskOf(baseline);
    console.log(`  edit-buffer BODY after the no-op: ${noopBodySame ? 'byte-identical ✔' : 'CHANGED ✘'}`);
    console.log(`  destination cableInputMask      : ${maskOf(noop)} ${noopMaskSame ? '(unchanged ✔)' : `✘ CHANGED (was ${maskOf(baseline)})`}`);
    console.log(`  write result: ${JSON.stringify(w0)}`);
    if (!noopBodySame || !noopMaskSame) {
      problems.push('the NO-OP cable write was NOT a no-op — the frame does not mean what the codec says; aborted BEFORE the disconnect');
      console.log('  → ABORT: reloading the captured before-dump into the edit buffer (loadPresetBytes; NO slot written) and stopping.');
      await session.driver.loadPresetBytes?.(Uint8Array.from(beforeSyx!));
      await sleep(900);
      const dBack = await dumpRaw();
      console.log(`  after the reload: ${dBack.hex === bodyBefore ? 'BYTE-IDENTICAL ✔ the edit buffer is back' : 'STILL DIFFERS ✘ — the unit needs attention'}`);
      if (dBack.hex !== bodyBefore) problems.push('even the loadPresetBytes reload did not restore the edit buffer');
      for (const p of problems) console.log(`  • ${p}`);
      return 2;
    }

    console.log(`\nWRITE 1 — cable(${srcRow}, ${SRC_COL}, ${TARGET_ROW}, connect=false)`);
    const w1 = await session.driver.cable!(srcRow, SRC_COL, TARGET_ROW, false);
    cableDown = { srcRow, connect: true };
    await sleep(500);
    await settle();
    console.log('── DURING (cable removed) ──');
    const during = await stage('during', true);
    cableDown = null;

    console.log(`\nRESTORE — cable(${srcRow}, ${SRC_COL}, ${TARGET_ROW}, connect=true)  (the exact inverse of W1)`);
    const w2 = await session.driver.cable!(srcRow, SRC_COL, TARGET_ROW, true);
    await sleep(500);
    await settle();
    console.log('── AFTER (cable restored) ──');
    const after = await stage('after', true);

    // ── 6. the independent restore proof: the edit-buffer BODY ──
    const d1 = await dumpRaw();
    const same = d1.hex === bodyBefore;
    console.log(`\nRESTORE PROOF (independent path: the edit-buffer BODY, fn=0x77/0x78/0x79): ${same ? 'BYTE-IDENTICAL to before ✔' : 'DIFFERS ✘'}`);
    if (!same) {
      problems.push('the edit buffer did NOT return byte-identical — the restore is not proven');
      const n = Math.min(bodyBefore.length, d1.hex.length) / 2;
      const at: number[] = [];
      for (let i = 0; i < n; i++) if (bodyBefore.slice(i * 2, i * 2 + 2) !== d1.hex.slice(i * 2, i * 2 + 2)) at.push(i);
      console.log(`  ${at.length} differing body byte(s)${at.length ? `, first ${at.slice(0, 12).join(', ')}` : ''}`);
      console.log('  → FALLBACK: reloading the captured before-dump into the edit buffer (loadPresetBytes; NO slot written).');
      await session.driver.loadPresetBytes?.(Uint8Array.from(beforeSyx!));
      await sleep(900);
      const d2 = await dumpRaw();
      console.log(`  after the reload: ${d2.hex === bodyBefore ? 'BYTE-IDENTICAL ✔ the edit buffer is back' : 'STILL DIFFERS ✘ — the unit needs attention'}`);
      if (d2.hex !== bodyBefore) problems.push('even the loadPresetBytes reload did not restore the edit buffer');
    }

    // ── 7. the pre-committed reading ──
    const targetOf = maskOf; // ONE definition (see 5b) — a second copy of the cell-key string is how drift starts
    const rec3StableOf = (s: StageResult) => [...s.rec3Stable].join('|');
    const baseMask = targetOf(baseline), duringMask = targetOf(during), afterMask = targetOf(after);
    const d25 = (s: StageResult) => { const all = [...s.rec3].map((r) => r.split(' ')[1]); return [...new Set(all)].join('/'); };
    const d26 = (s: StageResult) => { const all = [...s.rec3].map((r) => r.split(' ')[2]); return [...new Set(all)].join('/'); };
    const moved = (a: string, b: string) => a !== b;
    console.log(`\n── the pre-committed reading ──`);
    console.log(`  TAIL dest cableInputMask : baseline ${baseMask}  during ${duringMask}  after ${afterMask}   (${moved(baseMask, duringMask) ? 'MOVED as predicted on W1' : 'DID NOT MOVE — W1 may not have landed'})`);
    console.log(`  head record #3 · data 25 : baseline ${d25(baseline)}  during ${d25(during)}  after ${d25(after)}   → ${moved(d25(baseline), d25(during)) ? 'MOVED (H_SHARED branch)' : 'HELD'}`);
    console.log(`  head record #3 · data 26 : baseline ${d26(baseline)}  during ${d26(during)}  after ${d26(after)}   → ${moved(d26(baseline), d26(during)) ? 'MOVED (supports H_CABLE)' : 'HELD (supports H_PLACEMENT_ONLY)'}`);
    console.log(`  record #3 stable[25..31] : baseline ${rec3StableOf(baseline)}  during ${rec3StableOf(during)}  after ${rec3StableOf(after)}`);
    console.log(`  edit-buffer BODY revert  : ${same ? 'byte-identical ✔' : 'NOT byte-identical ✘ (see restore proof)'}`);
    console.log(`  stability control (must HOLD everywhere): head record #4 + tail r${STAB_ROUTE.row}c${STAB_ROUTE.col}`);

    const destMoved = moved(baseMask, duringMask);
    const holdsAgain = afterMask === baseMask;
    const verdict = !same ? 'ARM INCOMPLETE — the restore is not proven; read NOTHING above as a result'
      : !destMoved ? 'W1 did not move the destination mask — the disconnect did not land; no reading'
      : !holdsAgain ? 'the destination mask did not return on W2 — restore questionable'
      : moved(d25(baseline), d25(during)) ? 'H_SHARED — data 25 moved: cables and placement share the data-25 carrier (H_CABLE falsified)'
      : moved(d26(baseline), d26(during)) ? 'H_CABLE holds on this arm — record #3 moved through data 26 while data 25 held (confirm no other head record moved and exactly the touched tail cells moved via diff-2e-head-vs-grid.ts)'
      : 'H_PLACEMENT_ONLY — the head did NOT move for a cable: it ignores cabling (H_CABLE falsified)';
    console.log(`\nVERDICT (pre-committed): ${verdict}`);

    console.log(`\nwrite results: ${JSON.stringify(w1)} / ${JSON.stringify(w2)}`);
    console.log(`\nNEXT (offline): npx tsx scripts/diff-2e-head-vs-grid.ts ${outdir}/lever-cable-${slugify('baseline(no-write)')}.tap ${outdir}/lever-cable-during.tap ${outdir}/lever-cable-after.tap --mask ${MASK.join(',')}`);
    console.log('  NOTE: this arm touches TWO tail cells, so the differ\'s generic one-record/one-cell verdict line is NOT the pre-committed one — read the raw HEAD/TAIL deltas, not the verdict word.');
    for (const p of problems) console.log(`  • ${p}`);
    return problems.length === 0 ? 0 : 2;
  } finally {
    // FAIL-CLOSED: if the run exits with the cable still disconnected, reconnect it.
    if (cableDown) {
      try { console.log(`finally: reconnecting the cable (r${cableDown.srcRow}c${SRC_COL} → r${TARGET_ROW}c${TARGET_COL})`); await session.driver.cable?.(cableDown.srcRow, SRC_COL, TARGET_ROW, true); await sleep(500); } catch { /* reported above */ }
    }
    await sleep(50);
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
