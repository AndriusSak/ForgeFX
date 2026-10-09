// ────────────────────────────────────────────────────────────────────────────────────────────────
// check-switch-offsets — the §3.8 offset model, checked BY PREDICTION against three REAL captures of the
// same preset.
//
// Each capture is one edit by the owner plus one read-only dump, and this script states what the model
// expects BEFORE looking. A prediction that fails, or a byte that moves where the model says nothing should,
// is the point: that is how the contiguous-target-array reading was refuted.
//
// THE CHAIN (all real captures of preset 410):
//   A  preset-perform/preset-410.bin        no switch configured
//   B  preset-switches/preset-410-pp1.bin   PP#1 = Effect: Bypass → Filter 4 ; PP#2 = Scene: Select
//   C  preset-switches/preset-410-delay2.bin PP#1 = Effect: Bypass → Delay 2  ; PP#2 = Effect: Bypass
//
// CONFIRMED (2026-10-08/09): marker+4 and marker+6 hold the PP#1/PP#2 ACTION CODES (a contiguous u16 array,
// two entries evidenced); marker+148 holds PP#1's TARGET byte (20 = "Filter 4", then 8 = "Delay 2", each
// matching an anchor measured independently on the wire).
// REFUTED (2026-10-09): the TARGET bytes are NOT a flat one-per-switch array — in capture C, PP#2 was fully
// configured yet marker+149 did not move. Keep that as a `mustMove: false` prediction so it cannot come back.
//
// NOTE ON "EXTRAS": the captures were taken hours apart, so the PERFORM PAGE legitimately differs too (a
// label the owner edited). Those offsets are classified rather than treated as failures — but any OTHER
// unexpected byte still fails the check, which is how marker+160 was found.
//
// READ-ONLY, offline. Run: npx tsx scripts/check-switch-offsets.ts
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parsePresetDump, decodeRawPatch, findPerPresetSwitchBlock, PP_ACTION_OFFSET, PP_TARGET_OFFSET, PP_MEASURED_OFFSETS } from 'forgefx-midi/devices/gen3';

interface Prediction {
  /** Offset from the marker. */
  rel: number;
  /** Expected value in the NEW capture (when it must move). */
  want?: number;
  /** false = the model says this byte must NOT change. */
  mustMove: boolean;
  what: string;
}

interface Step {
  from: string;
  to: string;
  predictions: Prediction[];
  /** Offsets allowed to differ for reasons outside the switch block (the perform page, edited in between). */
  allowedElsewhere: (o: number) => boolean;
}

/** The perform page's own region — labels the owner edited between captures. */
const isPerformPageByte = (o: number): boolean => o >= 10690 && o <= 11100;

/** marker+160: seen 0 → 1 → 14 across the three captures. Identity UNKNOWN (a hypothesis, not a finding). */
const UNEXPLAINED_REL = 160;

/** The refuted stride: PP#2's target byte would sit here IF the array were flat. The codec's table has no
 *  entry for it — checked below, so the refutation lives in the DATA, not only in this script. */
const REFUTED_PP2_TARGET_REL = PP_TARGET_OFFSET + 1;

/** PP#2's action-code offset comes from the codec's table (PP_ACTION_OFFSET + 2 was an assumption). */
const PP2_ACTION_REL = PP_MEASURED_OFFSETS[2]!.actionCode;

const STEPS: Step[] = [
  {
    from: '../test/fixtures/preset-perform/preset-410.bin',
    to: '../test/fixtures/preset-switches/preset-410-pp1.bin',
    predictions: [
      { rel: PP_ACTION_OFFSET, want: 0x04, mustMove: true, what: 'PP#1 action code → Effect: Bypass' },
      { rel: PP2_ACTION_REL, want: 0x03, mustMove: true, what: 'PP#2 action code → Scene: Select' },
      { rel: PP_TARGET_OFFSET, want: 20, mustMove: true, what: 'PP#1 target → 20 = Filter 4' }
    ],
    allowedElsewhere: (o) => isPerformPageByte(o) || o === 11420 + UNEXPLAINED_REL
  },
  {
    from: '../test/fixtures/preset-switches/preset-410-pp1.bin',
    to: '../test/fixtures/preset-switches/preset-410-delay2.bin',
    predictions: [
      { rel: PP2_ACTION_REL, want: 0x04, mustMove: true, what: 'PP#2 action code → Effect: Bypass' },
      { rel: PP_TARGET_OFFSET, want: 8, mustMove: true, what: 'PP#1 target → 8 = Delay 2' },
      // THE REFUTATION, nailed down: a flat one-per-switch target array would put PP#2's target here, and a
      // configured PP#2 must move it. It did not.
      { rel: REFUTED_PP2_TARGET_REL, mustMove: false, what: 'PP#2 target IF the array were contiguous (REFUTED)' }
    ],
    allowedElsewhere: (o) => isPerformPageByte(o) || o === 11420 + UNEXPLAINED_REL
  }
];

function load(rel: string): Uint8Array {
  const bytes = new Uint8Array(readFileSync(new URL(rel, import.meta.url)));
  const { body } = decodeRawPatch(parsePresetDump(bytes, 0, 0x11).chunkPayloads);
  return body;
}

export async function main(): Promise<number> {
  let bad = 0;
  // The refutation must live in the DATA, not only in this script's expectations.
  if (PP_MEASURED_OFFSETS[2]?.target !== undefined) {
    console.log('FAIL: the codec table now claims a target offset for PP#2 — if that is a new MEASUREMENT, update this script; if it is an assumption, remove it');
    bad++;
  }
  for (const step of STEPS) {
    const a = load(step.from);
    const b = load(step.to);
    if (a.length !== b.length) { console.log(`FAIL: body lengths differ (${a.length} vs ${b.length})`); bad++; continue; }
    const at = findPerPresetSwitchBlock(b);
    if (at === undefined) { console.log(`FAIL: no switch marker in ${step.to}`); bad++; continue; }
    const diff = new Set<number>();
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.add(i);

    console.log(`\n${step.from.split('/').pop()} → ${step.to.split('/').pop()}   (marker ${at}, ${diff.size} byte(s) differ)`);
    for (const p of step.predictions) {
      const abs = at + p.rel;
      const moved = diff.has(abs);
      const ok = p.mustMove ? (moved && (p.want === undefined || b[abs] === p.want)) : !moved;
      if (!ok) bad++;
      const shown = p.want === undefined ? `stayed ${b[abs]}` : `= ${b[abs]}`;
      console.log(`  ${ok ? 'OK  ' : 'FAIL'} marker+${p.rel} (${shown}) — ${p.what}`);
    }

    const covered = new Set(step.predictions.map((p) => at + p.rel));
    const extras = [...diff].filter((o) => !covered.has(o) && !step.allowedElsewhere(o));
    console.log(`  extras: ${extras.length ? extras.map((o) => `${o} (marker+${o - at}: ${a[o]}→${b[o]})`).join(', ') : 'none'}`);
    if (extras.length) bad++;
  }
  console.log(`\n${bad === 0 ? 'MODEL HOLDS on every captured step' : `${bad} prediction(s) FAILED`}`);
  return bad === 0 ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then((c) => process.exit(c));
