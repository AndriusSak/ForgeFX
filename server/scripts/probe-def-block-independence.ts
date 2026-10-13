// ⚠ RESULTS FROM THIS TOOL ARE INVALID UNLESS --blocks CARRIES EFFECT IDs (see below).
//
// ────────────────────────────────────────────────────────────────────────────────
// probe-def-block-independence — READ-ONLY: does the VIEW-0x1c definition reply depend on the BLOCK byte?
//
// !! THE BLOCK BYTE IS THE fn-0x01 EFFECT ID, NOT A CACHE SECTION TAG — measured 2026-10-13 by review.
// !! `cache/assign.ts`: in the live self-describe walk "the 'section' is the fn-0x01 block id, which bears
// !! no relation to the cache section tag". An earlier run of this tool passed 11 (CABINET), 13 (DELAY) and
// !! 20 (WAH) — CACHE SECTION TAGS, which are unassigned EFFECT IDs — and the device answered all three from
// !! ONE shared fallback table. Identical records were then read as "the block byte does not select the
// !! family", which was WRONG: it was the query. Correct values: Cab 62, Delay 70, Rotary 86, Wah 94
// !! (`fm3EffectId(family, 1)`); addressed that way the records differ per block and every row's typecode
// !! and bounds agree with our table (28/28, `probe-def-ranges.ts`). The default --blocks below is therefore
// !! EFFECT IDs (plus 0 as an intentional unmapped/fallback address), never a section tag.
//
// WHY: the handover's plan for the nibble-5 range rows was "confirm once against the unit's own definition
// record (view 0x1c), which states min/max directly". Before spending a hardware round on that, the query
// itself has to be shown to address a (BLOCK, PARAM) pair at all. This instrument answers that with an
// artifact instead of a reading: it asks the SAME param ids under SEVERAL block bytes and compares the
// decoded records field-by-field.
//
// PREDICTIONS (stated before the run, so the result cannot be rationalised afterwards), re-stated for the
// CORRECT (effect-id) address space:
//   • "block selects the family/param" → the records for one param id DIFFER between real effect-id
//     blocks (e.g. Cab 62, Delay 70, Rotary 86, Wah 94); the per-block records disagree.
//   • "block is not part of the address (or is ignored)" → the records are IDENTICAL for every block.
// A THIRD outcome is its own named class: an invalid/fallback block (e.g. 0) returning garbage — subnormal
// floats or an all-zero slot. THIRD/FOURTH verdicts also exist for the case where the comparison cannot be
// made at all (see below) — those are named and are NEVER reported as a pass.
//
// ── HOW DEPENDENCE IS DECIDED (2026-10-13, second fix — the previous verdict was INVERTED) ──
// This tool's default `--blocks` is `62,70,86,94,0` and block 0 is the intentional FALLBACK address. An
// earlier revision computed `new Set(keys).size > 1` over EVERY cell (key = class + record), so block 0's
// fallback cell never equalled a real record's cell and `dependent` was true for EVERY param that had any
// real record — the tool could no longer say "no dependence" even when 62/70/86/94 returned byte-identical
// records. It also called a param 'BLOCK-DEPENDENT' when one block's real cell was ABSENT and another's was
// UNDECODED, while its own line said NO DEFINITION RECORD. The rules now are:
//   • A difference counts ONLY between two cells that are BOTH `real-record`. Absent / undecoded /
//     fallback cells are reported per block and MUST NOT manufacture a difference.
//   • Block 0, if given, is the CONTROL: expected fallback-shaped, EXCLUDED from the dependence computation
//     (stated explicitly in the output and the artifact), and reported for whether it really is.
//   • Three outcome classes are distinguished and kept apart:
//       INDEPENDENT                — ≥2 real cells, all equal → a real "no dependence observed".
//       BLOCK-DEPENDENT            — ≥2 real cells, at least one pair differs.
//       NO-COMPARABLE-REAL-CELLS   — fewer than two real cells to compare (e.g. real in one block, absent
//                                    in another). Its OWN verdict, never a pass.
//       FALLBACK-ONLY              — zero real cells and ≥1 fallback-shaped → the address-space question.
//       NO-DEFINITION-RECORD       — zero real cells and no fallback-shaped → nothing came back to compare.
// `--self-test` feeds synthetic cell sets through the SAME pure `evaluateDependence()` the live run uses and
// asserts (a)…(d) below WITHOUT hardware, so the classification/dependence logic is provable offline.
//
// The artifact is written to --out (JSON) with the raw frames, so the claim is re-checkable by anyone
// (and by `inspect-tap`) without re-running the hardware.
//
// NOTHING IS WRITTEN: view 0x1c reads only.
//
// USAGE  npx tsx scripts/probe-def-block-independence.ts [--blocks 62,70,86,94,0] [--params 3,4,10,13,16,24]
//                                                        [--out <path.json>]
//        npx tsx scripts/probe-def-block-independence.ts --self-test      (no device needed)
// ────────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MODEL = 0x11;

export interface DefRecord {
  id: number;
  tc: number;
  min: number;
  max: number;
  scale: number;
  def: number;
  step: number;
}

/**
 * How ONE (param, block) cell came back — NAMED and counted, never collapsed to a boolean. The old
 * `unusable()` returned true/false and the caller EXCLUDED the "true" cells from the comparison, which was
 * defensible for a garbage fallback address but silently hid the case this probe exists to measure: a
 * record PRESENT under one block and ABSENT under another is block dependence, and dropping the odd cell
 * made it read as "independent".
 *
 *   • 'absent-no-reply'   — No definition frame arrived for that address (adaptRequest matched nothing).
 *   • 'fallback-shaped'   — A frame arrived whose record is degenerate/absurd (non-finite floats, an
 *                           all-zero slot, a scale beyond any real row, max < min, subnormal bounds): the
 *                           shape an UNMAPPED / fallback address returns, NOT a per-param range.
 *   • 'undecoded-reply'   — A frame MATCHED the address but did not decode to a definition record
 *                           (truncated/malformed). Its own class, so a decode null is never counted as
 *                           device silence.
 *   • 'real-record'       — A plausible per-param definition record.
 */
export type CellClass = 'absent-no-reply' | 'fallback-shaped' | 'undecoded-reply' | 'real-record';

/**
 * Is this record the shape an unmapped/fallback address returns (as opposed to a real per-param range)?
 * Measured garbage classes: subnormal floats (`3.0e-41` from block 0), an all-zero slot (id 0, tc 0, every
 * field 0 — the same shape a valid block returns for a param that has no record), absurd scales
 * (-100 / 20000 seen on the same reads), or impossible bounds (max < min).
 */
export function isFallbackShaped(r: DefRecord): boolean {
  if (![r.min, r.max, r.scale, r.def, r.step].every((x) => Number.isFinite(x))) return true;
  if (r.id === 0 && r.tc === 0 && r.scale === 0 && r.min === 0 && r.max === 0 && r.def === 0 && r.step === 0) return true;
  if (Math.abs(r.scale) > 1e4) return true;
  if (r.max < r.min) return true;
  if (r.min !== 0 && Math.abs(r.min) < 1e-30) return true;
  if (Math.abs(r.max) > 1e30) return true;
  return false;
}

export function classify(r: DefRecord | null, hadReply: boolean): CellClass {
  if (!r) return hadReply ? 'undecoded-reply' : 'absent-no-reply';
  return isFallbackShaped(r) ? 'fallback-shaped' : 'real-record';
}

/** A comparison key for one cell: the CLASS plus (when a record exists) its decoded fields. Two cells are
 *  "the same" only when both the class and the record agree. (Dependence still only ever compares two
 *  `real-record` cells — see `evaluateDependence` — this key just makes the equality explicit.) */
export function cellKey(cls: CellClass, r: DefRecord | null): string {
  if (!r) return cls;
  return `${cls}:${r.id}/${r.tc}/${r.min}/${r.max}/${r.scale}/${r.def}/${r.step}`;
}

/** One (param, block) cell for the pure dependence evaluator. */
export interface Cell {
  block: number;
  cls: CellClass;
  rec: DefRecord | null;
}

/**
 * The outcome classes, kept apart on purpose. Only the first two are a definite answer; the last three are
 * NAMED non-answers and must never be rendered as a pass.
 */
export type DependenceVerdict =
  | 'BLOCK-DEPENDENT'
  | 'INDEPENDENT'
  | 'NO-COMPARABLE-REAL-CELLS'
  | 'FALLBACK-ONLY'
  | 'NO-DEFINITION-RECORD';

export interface DependenceEvaluation {
  verdict: DependenceVerdict;
  /** true ONLY for BLOCK-DEPENDENT — never for any non-answer. */
  dependent: boolean;
  /** Blocks whose cell was a real record, among the COMPARABLE (non-control) blocks. */
  realBlocks: number[];
  /** The non-control blocks — block 0 is never in here. */
  comparableBlocks: number[];
  /** The block-0 control, when supplied: its class and whether it really is fallback-shaped. */
  control: { block: number; cls: CellClass; fallbackShaped: boolean } | null;
  /** Block pairs that genuinely differ — only ever two real-record cells. */
  differPairs: Array<[number, number]>;
}

/** Block 0 is the intentional FALLBACK/CONTROL address: always EXCLUDED from the dependence computation. */
export const CONTROL_BLOCK = 0;

/**
 * PURE decision: given the per-block cells for ONE param, decide whether the definition reply depends on
 * the block byte. No transport, no I/O — this is what `--self-test` exercises and what the live run calls.
 */
export function evaluateDependence(cells: Cell[]): DependenceEvaluation {
  // Block 0 (if present) is the CONTROL: reported, never compared.
  const controlCell = cells.find((c) => c.block === CONTROL_BLOCK) ?? null;
  const comparable = cells.filter((c) => c.block !== CONTROL_BLOCK);

  const real = comparable.filter((c) => c.cls === 'real-record');
  const realBlocks = real.map((c) => c.block);

  // A difference counts ONLY between two cells that are BOTH real records. Absent / undecoded / fallback
  // cells are reported per block (see the caller's class lines) and never manufacture a difference.
  const compared = real;
  const differPairs: Array<[number, number]> = [];
  for (let i = 0; i < compared.length; i += 1)
    for (let j = i + 1; j < compared.length; j += 1)
      if (cellKey(compared[i]!.cls, compared[i]!.rec) !== cellKey(compared[j]!.cls, compared[j]!.rec))
        differPairs.push([compared[i]!.block, compared[j]!.block]);

  let verdict: DependenceVerdict;
  if (real.length >= 2) verdict = differPairs.length > 0 ? 'BLOCK-DEPENDENT' : 'INDEPENDENT';
  else if (real.length === 1) verdict = 'NO-COMPARABLE-REAL-CELLS';
  else if (comparable.some((c) => c.cls === 'fallback-shaped')) verdict = 'FALLBACK-ONLY';
  else verdict = 'NO-DEFINITION-RECORD';

  return {
    verdict,
    dependent: verdict === 'BLOCK-DEPENDENT',
    realBlocks,
    comparableBlocks: comparable.map((c) => c.block),
    control: controlCell
      ? { block: CONTROL_BLOCK, cls: controlCell.cls, fallbackShaped: controlCell.cls === 'fallback-shaped' }
      : null,
    differPairs,
  };
}

const VERDICT_LABEL: Record<DependenceVerdict, string> = {
  'BLOCK-DEPENDENT': 'BLOCK-DEPENDENT across blocks',
  INDEPENDENT: 'INDEPENDENT of the block byte',
  'NO-COMPARABLE-REAL-CELLS': 'NO-COMPARABLE-REAL-CELLS (need ≥2)',
  'FALLBACK-ONLY': 'FALLBACK-ONLY — address space is the question',
  'NO-DEFINITION-RECORD': 'NO DEFINITION RECORD for any block',
};

// ── SELF-TEST (no hardware) ──────────────────────────────────────────────────────────────────────────
// Feeds synthetic per-block cell sets through evaluateDependence() and asserts the four cases the defect
// review named. A new assertion is not trusted until it has been seen to FAIL once — each case below has a
// stated one-line break (see the round's report) that turns it red, then it is green again.
const R = (over: Partial<DefRecord> = {}): DefRecord => ({ id: 62, tc: 0x52, min: 0, max: 10, scale: 1, def: 0, step: 0.1, ...over });
const F = (): DefRecord => ({ id: 0, tc: 0, min: 0, max: 0, scale: 0, def: 0, step: 0 }); // fallback-shaped
const real = (block: number, over: Partial<DefRecord> = {}): Cell => ({ block, cls: classify(R(over), true), rec: R(over) });
const fallback = (block: number): Cell => ({ block, cls: classify(F(), true), rec: F() });
const absent = (block: number): Cell => ({ block, cls: classify(null, false), rec: null });

export function selfTest(): number {
  let failures = 0;
  const check = (name: string, ok: boolean, detail: string) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
    if (!ok) failures += 1;
  };

  // (a) 62/70/86/94 identical real records + block 0 fallback ⇒ NOT dependent.
  {
    const e = evaluateDependence([real(62), real(70), real(86), real(94), fallback(0)]);
    check(
      '(a) 4 identical real records + block-0 fallback ⇒ INDEPENDENT',
      e.verdict === 'INDEPENDENT' && e.dependent === false && e.realBlocks.length === 4 &&
        e.control?.fallbackShaped === true && e.comparableBlocks.join(',') === '62,70,86,94',
      `verdict=${e.verdict} dependent=${e.dependent} realBlocks=${e.realBlocks.join(',')} control=${e.control?.cls}`
    );
  }

  // (b) one block's real record genuinely differing ⇒ dependent.
  {
    const e = evaluateDependence([real(62), real(70), real(86, { max: 20 }), real(94), fallback(0)]);
    check(
      "(b) one real record differs (86 max 10→20) ⇒ BLOCK-DEPENDENT",
      e.verdict === 'BLOCK-DEPENDENT' && e.dependent === true && e.differPairs.length > 0,
      `verdict=${e.verdict} dependent=${e.dependent} differPairs=${JSON.stringify(e.differPairs)}`
    );
  }

  // (c) real in one block and absent in another ⇒ its OWN verdict, not 'dependent' and not 'no dependence'.
  {
    const e = evaluateDependence([real(62), absent(70)]);
    check(
      '(c) real in 62 + absent in 70 ⇒ NO-COMPARABLE-REAL-CELLS (not dependent, not independent)',
      e.verdict === 'NO-COMPARABLE-REAL-CELLS' && String(e.verdict) !== 'BLOCK-DEPENDENT' && String(e.verdict) !== 'INDEPENDENT' &&
        e.dependent === false && e.realBlocks.join(',') === '62',
      `verdict=${e.verdict} dependent=${e.dependent} realBlocks=${e.realBlocks.join(',')}`
    );
  }

  // (d) all-fallback ⇒ the address-space question, not a pass.
  {
    const e = evaluateDependence([fallback(62), fallback(70), fallback(86)]);
    check(
      '(d) all-fallback ⇒ FALLBACK-ONLY (address-space question, never a pass)',
      e.verdict === 'FALLBACK-ONLY' && String(e.verdict) !== 'INDEPENDENT' && e.dependent === false,
      `verdict=${e.verdict} dependent=${e.dependent}`
    );
  }

  // (e) no real cells and nothing fallback-shaped ⇒ nothing came back to compare.
  {
    const e = evaluateDependence([absent(62), absent(70)]);
    check(
      '(e) all-absent ⇒ NO-DEFINITION-RECORD (never a pass)',
      e.verdict === 'NO-DEFINITION-RECORD' && String(e.verdict) !== 'INDEPENDENT' && e.dependent === false,
      `verdict=${e.verdict} dependent=${e.dependent}`
    );
  }

  console.log(failures === 0 ? '\nself-test: ALL PASS' : `\nself-test: ${failures} FAILED`);
  return failures === 0 ? 0 : 1;
}

export async function main(argv: string[]): Promise<number> {
  if (argv.includes('--self-test')) return selfTest();

  const argOf = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  // EFFECT IDs by default (Cab 62, Delay 70, Rotary 86, Wah 94) plus 0 as an intentional unmapped/fallback
  // address — see the header. NEVER the cache section tags 11/13/20.
  const blocks = (argOf('--blocks') ?? '62,70,86,94,0').split(',').map(Number);
  const params = (argOf('--params') ?? '3,4,10,13,16,24').split(',').map(Number);
  const out = argOf('--out') ?? '';

  // Dynamic imports so the pure classify/dependence path (and --self-test) never loads driver/serial code.
  const { openProbeSession } = await import('./probe-device.js');
  const { adaptRequest } = await import('../src/services/deviceCache.js');
  const { buildDefQuery, decodeReply } = await import('forgefx-midi/cache');

  const opened = await openProbeSession(MODEL);
  if (!opened.ok) {
    console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`);
    return 3;
  }
  const s = opened.session;
  const artifact: {
    at: string;
    model: string;
    readOnly: string;
    addressSpace: string;
    controlBlock: number;
    blocks: number[];
    params: number[];
    raw: Record<string, string[]>;
    records: Record<string, Record<string, DefRecord | null>>;
    /** Per param, the CellClass of each block (aligned with `blocks`) — the explicit classification. */
    classes: Record<string, CellClass[]>;
    /** Per param, the number of cells in each class, so none is ever silently dropped. */
    classCounts: Record<string, Record<CellClass, number>>;
    /** Per param, the dependence verdict (see DependenceVerdict). blockDependent is true ONLY for
     *  'BLOCK-DEPENDENT' — the three non-answer verdicts are never a pass. */
    dependenceVerdict: Record<string, DependenceVerdict>;
    blockDependent: Record<string, boolean>;
    /** Per param, the blocks whose cell was a real record among the comparable (non-control) blocks. */
    realBlocks: Record<string, number[]>;
    /** Per param, block 0's control class (or null when block 0 was not requested). */
    controlClass: Record<string, CellClass | null>;
    /** Totals over every (param, block) cell in the run. */
    cellClassTotals: Record<CellClass, number>;
  } = {
    at: new Date().toISOString(),
    model: s.label,
    readOnly: 'view 0x1c definition reads only — no writes, nothing swept',
    addressSpace: 'block byte = fn-0x01 EFFECT ID (Cab 62, Delay 70, Rotary 86, Wah 94, …) — NOT the cache section tag',
    controlBlock: CONTROL_BLOCK,
    blocks,
    params,
    raw: {},
    records: {},
    classes: {},
    classCounts: {},
    dependenceVerdict: {},
    blockDependent: {},
    realBlocks: {},
    controlClass: {},
    cellClassTotals: { 'absent-no-reply': 0, 'fallback-shaped': 0, 'undecoded-reply': 0, 'real-record': 0 },
  };

  const hasControl = blocks.includes(CONTROL_BLOCK);
  const verdictCounts: Record<DependenceVerdict, number> = {
    'BLOCK-DEPENDENT': 0,
    INDEPENDENT: 0,
    'NO-COMPARABLE-REAL-CELLS': 0,
    'FALLBACK-ONLY': 0,
    'NO-DEFINITION-RECORD': 0,
  };

  try {
    console.log(`device: ${s.label} · READ-ONLY (view 0x1c) · blocks ${blocks.join(',')} · params ${params.join(',')}\n`);
    console.log('(block bytes are fn-0x01 EFFECT IDs — Cab 62, Delay 70, Rotary 86, Wah 94 — plus 0 as an unmapped address)\n');
    if (hasControl) console.log(`block 0 is the CONTROL (expected fallback-shaped) — EXCLUDED from the dependence computation.\n`);
    for (const pid of params) {
      const perBlock: Record<string, DefRecord | null> = {};
      const raws: string[] = [];
      const classes: CellClass[] = [];
      for (const blk of blocks) {
        let rec: DefRecord | null = null;
        let raw = '';
        for (let attempt = 0; attempt < 3 && rec == null && !raw; attempt += 1) {
          // HW-PROVEN MATCHER, not `frames[frames.length - 1]`. `adaptRequest`
          // (`../src/services/deviceCache.js`, the CaptureRig matcher the live-walk uses) matches on the fn,
          // the VIEW echo (f[6]), the BLOCK-HIGH echo (f[9]) and BOTH param bytes (f[10]/f[11]). The device
          // does NOT echo block-low the way an `f[8] === eid` check assumes — adaptRequest deliberately does
          // NOT use f[8] — so a bare `frames[last]` pick can latch a stale fn-0x01 frame from an earlier
          // query (the FORGEFX-32 wedge). adaptRequest returns ONE matched frame; decodeReply wants exactly that.
          const frame = await adaptRequest(s.transport, buildDefQuery(MODEL, blk, pid));
          if (!frame) continue; // no matched reply yet — retry
          raw = Array.from(frame).map((b) => b.toString(16).padStart(2, '0')).join(' ');
          const dec = decodeReply(frame);
          if (dec && dec.view === 'definition') {
            rec = { id: dec.id, tc: dec.tc, min: dec.min, max: dec.max, scale: dec.scale, def: dec.def, step: dec.step };
          }
          // A matched frame that does NOT decode to a definition stops the retry: a frame DID arrive, so
          // re-asking would not turn it into one. It is classified 'undecoded-reply', not 'absent-no-reply'.
        }
        perBlock[String(blk)] = rec;
        raws.push(raw || '<no reply>');
        const cls = classify(rec, raw !== '');
        classes.push(cls);
        artifact.cellClassTotals[cls] += 1;
      }
      artifact.records[String(pid)] = perBlock;
      artifact.raw[String(pid)] = raws;
      artifact.classes[String(pid)] = classes;

      const classCounts = { 'absent-no-reply': 0, 'fallback-shaped': 0, 'undecoded-reply': 0, 'real-record': 0 } as Record<CellClass, number>;
      for (const c of classes) classCounts[c] += 1;
      artifact.classCounts[String(pid)] = classCounts;

      // The dependence decision — over REAL-record cells only, block 0 excluded as the control.
      const cells: Cell[] = blocks.map((b, i) => ({ block: b, cls: classes[i]!, rec: perBlock[String(b)] ?? null }));
      const ev = evaluateDependence(cells);
      artifact.dependenceVerdict[String(pid)] = ev.verdict;
      artifact.blockDependent[String(pid)] = ev.dependent;
      artifact.realBlocks[String(pid)] = ev.realBlocks;
      artifact.controlClass[String(pid)] = ev.control?.cls ?? null;
      verdictCounts[ev.verdict] += 1;

      const recs = blocks.map((b) => perBlock[String(b)]);
      const cellStr = blocks
        .map((b, i) => `${b}=${classes[i] === 'real-record' ? `tc 0x${(recs[i]!.tc).toString(16)} ${recs[i]!.min}..${recs[i]!.max}` : classes[i]}`)
        .join('  |  ');
      const counts = (Object.entries(classCounts) as [CellClass, number][])
        .filter(([, n]) => n > 0)
        .map(([c, n]) => `${c}:${n}`)
        .join(' ');
      const controlNote = ev.control
        ? `  [control 0: ${ev.control.cls}${ev.control.fallbackShaped ? ' ✓ expected' : ' ⚠ NOT fallback-shaped'}]`
        : '';
      console.log(`param ${String(pid).padStart(3)}  ${VERDICT_LABEL[ev.verdict].padEnd(43)}  [${counts}]${controlNote}\n             ${cellStr}`);
      if (ev.differPairs.length) console.log(`             differing real pairs: ${ev.differPairs.map(([a, b]) => `${a}↔${b}`).join(' ')}`);
    }

    const concluded = verdictCounts['BLOCK-DEPENDENT'] + verdictCounts['INDEPENDENT'];
    const inconclusive = params.length - concluded;
    const anyDependent = verdictCounts['BLOCK-DEPENDENT'] > 0;
    const cells = artifact.cellClassTotals;
    console.log(
      `\nverdict: over ${params.length} param(s), ${verdictCounts['BLOCK-DEPENDENT']} BLOCK-DEPENDENT, ` +
        `${verdictCounts['INDEPENDENT']} INDEPENDENT, ${inconclusive} inconclusive ` +
        `(NO-COMPARABLE-REAL-CELLS ${verdictCounts['NO-COMPARABLE-REAL-CELLS']}, ` +
        `FALLBACK-ONLY ${verdictCounts['FALLBACK-ONLY']}, NO-DEFINITION-RECORD ${verdictCounts['NO-DEFINITION-RECORD']}).`
    );
    console.log(
      anyDependent
        ? '  The block byte selects the record — view 0x1c DOES address a (family, param) pair, and the nibble-5 rows can be confirmed this way.'
        : '  No two real cells disagreed across blocks.'
    );
    if (verdictCounts['FALLBACK-ONLY'] > 0 || verdictCounts['NO-DEFINITION-RECORD'] > 0)
      console.log('  Some params had no two real cells to compare — that is NOT "independent". If every cell is fallback-shaped the address space itself is the question: check --blocks carries EFFECT IDs, not cache section tags.');
    console.log(
      `  cells: ${cells['real-record']} real-record, ${cells['fallback-shaped']} fallback-shaped, ` +
        `${cells['absent-no-reply']} absent-no-reply, ${cells['undecoded-reply']} undecoded-reply ` +
        '(every cell counted as its own class — none dropped).'
    );
    if (out) {
      mkdirSync(dirname(resolve(out)), { recursive: true });
      writeFileSync(resolve(out), JSON.stringify(artifact, null, 2));
      console.log(`artifact: ${resolve(out)}`);
    }
    return anyDependent ? 0 : 1;
  } finally {
    await s.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).then((c) => process.exit(c));
