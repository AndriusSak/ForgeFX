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
//   C  preset-switches/preset-410-delay2.bin PP#1 = Effect: Bypass → Delay 2  ; PP#2 = Effect: Bypass, target FB Rtn 2
//   D  preset-switches/preset-410-pp2-reverb1.bin          PP#2 target → Reverb 1 (the PREDICTION that settled 160)
//   E  preset-switches/preset-410-pp2-fbrtn2-pp3-chorus1.bin PP#2 target → FB Rtn 2 ; PP#3 = Effect: Bypass → Chorus 1
//   F  preset-switches/preset-410-pp4-delay2-pp5-reverb1.bin PP#4 → Delay 2 ; PP#5 → Reverb 1 (the stride over
//      indices 4 and 5: 184 and 196 both stated in advance and both read exactly)
//
// CONFIRMED (2026-10-08/09): marker+4/6/8/10/12 hold the PP#1..PP#5 ACTION CODES (u16, stride 2);
// marker+148/160/172/184/196 hold the PP#1..PP#5 TARGET bytes (stride 12). PP#1's came from reading back a
// known anchor; indices 2-5 were CONFIRMED BY PREDICTION — each value was stated before the capture and read
// exactly (51 = "Reverb 1" at 160, 2 = "Chorus 1" at 172, 8 = "Delay 2" at 184, 51 = "Reverb 1" at 196). An
// earlier unexplained 14 at marker+160 is explained by the same model: PP#2's target with "FB Rtn 2" (14).
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

/** The refuted stride: PP#2's target byte would sit here IF the array were flat. The codec's table has no
 *  entry for it — checked below, so the refutation lives in the DATA, not only in this script. */
const REFUTED_PP2_TARGET_REL = PP_TARGET_OFFSET + 1;

/** Every offset past PP#1's comes from the codec's table (arithmetic off PP#1's was an assumption). */
const PP2_ACTION_REL = PP_MEASURED_OFFSETS[2]!.actionCode;
const PP2_TARGET_REL = PP_MEASURED_OFFSETS[2]!.target!;
const PP3_ACTION_REL = PP_MEASURED_OFFSETS[3]!.actionCode;
const PP3_TARGET_REL = PP_MEASURED_OFFSETS[3]!.target!;
const PP4_ACTION_REL = PP_MEASURED_OFFSETS[4]!.actionCode;
const PP4_TARGET_REL = PP_MEASURED_OFFSETS[4]!.target!;
const PP5_ACTION_REL = PP_MEASURED_OFFSETS[5]!.actionCode;
const PP5_TARGET_REL = PP_MEASURED_OFFSETS[5]!.target!;

const STEPS: Step[] = [
  {
    from: '../test/fixtures/preset-perform/preset-410.bin',
    to: '../test/fixtures/preset-switches/preset-410-pp1.bin',
    predictions: [
      { rel: PP_ACTION_OFFSET, want: 0x04, mustMove: true, what: 'PP#1 action code → Effect: Bypass' },
      { rel: PP2_ACTION_REL, want: 0x03, mustMove: true, what: 'PP#2 action code → Scene: Select' },
      { rel: PP_TARGET_OFFSET, want: 20, mustMove: true, what: 'PP#1 target → 20 = Filter 4' },
      // PP#2's target byte moved 0 → 1 here while its action was Scene: Select. Under the model that is its
      // target field, whose MEANING depends on the action (a scene number here — the FX-slot anchors were all
      // measured with Effect: Bypass), so it is asserted as a byte, not as a slot name.
      { rel: PP2_TARGET_REL, want: 1, mustMove: true, what: 'PP#2 target byte → 1 (Scene: Select is set: a scene number, not an FX slot)' }
    ],
    allowedElsewhere: (o) => isPerformPageByte(o)
  },
  {
    from: '../test/fixtures/preset-switches/preset-410-pp1.bin',
    to: '../test/fixtures/preset-switches/preset-410-delay2.bin',
    predictions: [
      { rel: PP2_ACTION_REL, want: 0x04, mustMove: true, what: 'PP#2 action code → Effect: Bypass' },
      { rel: PP_TARGET_OFFSET, want: 8, mustMove: true, what: 'PP#1 target → 8 = Delay 2' },
      // The previously UNEXPLAINED 1 → 14. Under the model this is PP#2's target byte with the owner's
      // "FB Rtn 2" selected, which capture E re-measures at exactly the same value from a different direction.
      { rel: PP2_TARGET_REL, want: 14, mustMove: true, what: 'PP#2 target → 14 = FB Rtn 2' },
      // THE REFUTATION, nailed down: a flat one-per-switch target array would put PP#2's target here, and a
      // configured PP#2 must move it. It did not.
      { rel: REFUTED_PP2_TARGET_REL, mustMove: false, what: 'PP#2 target IF the array were contiguous (REFUTED)' }
    ],
    allowedElsewhere: (o) => isPerformPageByte(o)
  },
  {
    // The PREDICTION that settled marker+160: PP#2's target was set to a KNOWN anchor (Reverb 1) and the model
    // said 51 must appear there. It did — and adding PP#3 to the same capture then confirmed 172 by the same
    // method (want 2 = Chorus 1), i.e. a second index, not a single lucky byte.
    from: '../test/fixtures/preset-switches/preset-410-delay2.bin',
    to: '../test/fixtures/preset-switches/preset-410-pp2-reverb1.bin',
    predictions: [
      { rel: PP_TARGET_OFFSET, want: 20, mustMove: true, what: 'PP#1 target → back to 20 = Filter 4' },
      { rel: PP2_TARGET_REL, want: 51, mustMove: true, what: 'PP#2 target → 51 = Reverb 1 (PREDICTED before the capture)' }
    ],
    allowedElsewhere: (o) => isPerformPageByte(o)
  },
  {
    from: '../test/fixtures/preset-switches/preset-410-pp2-reverb1.bin',
    to: '../test/fixtures/preset-switches/preset-410-pp2-fbrtn2-pp3-chorus1.bin',
    predictions: [
      { rel: PP2_TARGET_REL, want: 14, mustMove: true, what: 'PP#2 target → 14 = FB Rtn 2 (the earlier unexplained value, reproduced)' },
      { rel: PP3_ACTION_REL, want: 0x04, mustMove: true, what: 'PP#3 action code → Effect: Bypass (a THIRD action-code slot: stride 2 holds)' },
      { rel: PP3_TARGET_REL, want: 2, mustMove: true, what: 'PP#3 target → 2 = Chorus 1 (PREDICTED before the capture: stride 12 holds)' }
    ],
    allowedElsewhere: (o) => isPerformPageByte(o)
  },
  {
    // The stride over TWO more indices, both stated in advance: 184 (PP#4 targets Delay 2 = 8) and 196
    // (PP#5 targets Reverb 1 = 51), with their action codes at marker+10 and marker+12.
    from: '../test/fixtures/preset-switches/preset-410-pp2-fbrtn2-pp3-chorus1.bin',
    to: '../test/fixtures/preset-switches/preset-410-pp4-delay2-pp5-reverb1.bin',
    predictions: [
      { rel: PP4_ACTION_REL, want: 0x04, mustMove: true, what: 'PP#4 action code → Effect: Bypass (marker+10)' },
      { rel: PP4_TARGET_REL, want: 8, mustMove: true, what: 'PP#4 target → 8 = Delay 2 (PREDICTED at marker+184)' },
      { rel: PP5_ACTION_REL, want: 0x04, mustMove: true, what: 'PP#5 action code → Effect: Bypass (marker+12)' },
      { rel: PP5_TARGET_REL, want: 51, mustMove: true, what: 'PP#5 target → 51 = Reverb 1 (PREDICTED at marker+196)' }
    ],
    allowedElsewhere: (o) => isPerformPageByte(o)
  }
];

function load(rel: string): Uint8Array {
  const bytes = new Uint8Array(readFileSync(new URL(rel, import.meta.url)));
  const { body } = decodeRawPatch(parsePresetDump(bytes, 0, 0x11).chunkPayloads);
  return body;
}

export async function main(): Promise<number> {
  let bad = 0;
  // The offsets must live in the DATA, and this script must not drift from them: every prediction below was
  // written against this table, so a change to it has to be re-stated here WITH a capture that proves it.
  const table = PP_MEASURED_OFFSETS;
  const claims: Array<[string, boolean]> = [
    ['PP#1 action @4', table[1]?.actionCode === 4],
    ['PP#1 target @148', table[1]?.target === 148],
    ['PP#2 action @6', table[2]?.actionCode === 6],
    ['PP#2 target @160', table[2]?.target === 160],
    ['PP#3 action @8', table[3]?.actionCode === 8],
    ['PP#3 target @172', table[3]?.target === 172],
    ['PP#4 action @10', table[4]?.actionCode === 10],
    ['PP#4 target @184', table[4]?.target === 184],
    ['PP#5 action @12', table[5]?.actionCode === 12],
    ['PP#5 target @196', table[5]?.target === 196],
    ['indices 6+ still have NO observed offset', Object.keys(table).length === 5 && table[6] === undefined]
  ];
  for (const [what, ok] of claims) {
    if (!ok) { console.log(`FAIL: the codec table no longer says "${what}" — the predictions below were written against that table`); bad++; }
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
