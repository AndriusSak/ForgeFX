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
// floats or an all-zero slot. That cell is CLASSIFIED and counted, never dropped: a real record under one
// block and an absent/fallback cell under another is itself block dependence, which this tool must REPORT.
//
// The artifact is written to --out (JSON) with the raw frames, so the claim is re-checkable by anyone
// (and by `inspect-tap`) without re-running the hardware.
//
// NOTHING IS WRITTEN: view 0x1c reads only.
//
// USAGE  npx tsx scripts/probe-def-block-independence.ts [--blocks 62,70,86,94,0] [--params 3,4,10,13,16,24]
//                                                        [--out <path.json>]
// ────────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { adaptRequest } from '../src/services/deviceCache.js';
import { buildDefQuery, decodeReply } from 'forgefx-midi/cache';

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
function isFallbackShaped(r: DefRecord): boolean {
  if (![r.min, r.max, r.scale, r.def, r.step].every((x) => Number.isFinite(x))) return true;
  if (r.id === 0 && r.tc === 0 && r.scale === 0 && r.min === 0 && r.max === 0 && r.def === 0 && r.step === 0) return true;
  if (Math.abs(r.scale) > 1e4) return true;
  if (r.max < r.min) return true;
  if (r.min !== 0 && Math.abs(r.min) < 1e-30) return true;
  if (Math.abs(r.max) > 1e30) return true;
  return false;
}

function classify(r: DefRecord | null, hadReply: boolean): CellClass {
  if (!r) return hadReply ? 'undecoded-reply' : 'absent-no-reply';
  return isFallbackShaped(r) ? 'fallback-shaped' : 'real-record';
}

/** A comparison key for one cell: the CLASS plus (when a record exists) its decoded fields. Two cells are
 *  "the same" only when both the class and the record agree — so a real record vs an absent cell differ. */
function cellKey(cls: CellClass, r: DefRecord | null): string {
  if (!r) return cls;
  return `${cls}:${r.id}/${r.tc}/${r.min}/${r.max}/${r.scale}/${r.def}/${r.step}`;
}

export async function main(argv: string[]): Promise<number> {
  const argOf = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  // EFFECT IDs by default (Cab 62, Delay 70, Rotary 86, Wah 94) plus 0 as an intentional unmapped/fallback
  // address — see the header. NEVER the cache section tags 11/13/20.
  const blocks = (argOf('--blocks') ?? '62,70,86,94,0').split(',').map(Number);
  const params = (argOf('--params') ?? '3,4,10,13,16,24').split(',').map(Number);
  const out = argOf('--out') ?? '';

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
    blocks: number[];
    params: number[];
    raw: Record<string, string[]>;
    records: Record<string, Record<string, DefRecord | null>>;
    /** Per param, the CellClass of each block (aligned with `blocks`) — the explicit classification. */
    classes: Record<string, CellClass[]>;
    /** Per param, the number of cells in each class, so none is ever silently dropped. */
    classCounts: Record<string, Record<CellClass, number>>;
    /** Per param: do the usable cells disagree across blocks (any differing class or record)? */
    blockDependent: Record<string, boolean>;
    /** Totals over every (param, block) cell in the run. */
    cellClassTotals: Record<CellClass, number>;
  } = {
    at: new Date().toISOString(),
    model: s.label,
    readOnly: 'view 0x1c definition reads only — no writes, nothing swept',
    addressSpace: 'block byte = fn-0x01 EFFECT ID (Cab 62, Delay 70, Rotary 86, Wah 94, …) — NOT the cache section tag',
    blocks,
    params,
    raw: {},
    records: {},
    classes: {},
    classCounts: {},
    blockDependent: {},
    cellClassTotals: { 'absent-no-reply': 0, 'fallback-shaped': 0, 'undecoded-reply': 0, 'real-record': 0 },
  };

  try {
    console.log(`device: ${s.label} · READ-ONLY (view 0x1c) · blocks ${blocks.join(',')} · params ${params.join(',')}\n`);
    console.log('(block bytes are fn-0x01 EFFECT IDs — Cab 62, Delay 70, Rotary 86, Wah 94 — plus 0 as an unmapped address)\n');
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

      // Block dependence = the cells do not all agree (differing class AND/OR differing record). A cell
      // PRESENT under one block and ABSENT (or fallback-shaped) under another is REPORTED here — it is the
      // very thing this tool measures, and the old boolean hid it by excluding the odd cell.
      const keys = blocks.map((b, i) => cellKey(classes[i]!, perBlock[String(b)] ?? null));
      const dependent = new Set(keys).size > 1;
      artifact.blockDependent[String(pid)] = dependent;

      const recs = blocks.map((b) => perBlock[String(b)]);
      const cellStr = blocks
        .map((b, i) => `${b}=${classes[i] === 'real-record' ? `tc 0x${(recs[i]!.tc).toString(16)} ${recs[i]!.min}..${recs[i]!.max}` : classes[i]}`)
        .join('  |  ');
      const noData = classes.every((c) => c !== 'real-record' && c !== 'fallback-shaped');
      const verdict = noData
        ? 'NO DEFINITION RECORD for any block'
        : dependent
          ? 'BLOCK-DEPENDENT across blocks'
          : 'INDEPENDENT of the block byte';
      const counts = (Object.entries(classCounts) as [CellClass, number][])
        .filter(([, n]) => n > 0)
        .map(([c, n]) => `${c}:${n}`)
        .join(' ');
      console.log(`param ${String(pid).padStart(3)}  ${verdict.padEnd(31)}  [${counts}]\n             ${cellStr}`);
    }

    const anyDependent = params.some((p) => artifact.blockDependent[String(p)]);
    const cells = artifact.cellClassTotals;
    console.log(
      `\nverdict: the definition reply is ${anyDependent ? 'DEPENDENT on' : 'INDEPENDENT of'} the block byte ` +
        `(addressed by EFFECT ID).`
    );
    console.log(
      anyDependent
        ? '  The block byte selects the record — view 0x1c DOES address a (family, param) pair, and the nibble-5 rows can be confirmed this way.'
        : '  No cell disagreed across blocks. If every cell is fallback-shaped the address space itself is the question — check --blocks carries EFFECT IDs, not cache section tags.'
    );
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
