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
//   G  preset-switches/preset-410-pp6-pp12.bin  PP#6..PP#12 → seven DISTINCT anchors (the whole remaining
//      range in one edit: 208/220/232/244/256/268 predicted and read, plus PP#12's 280 — which makes the
//      switch COUNT a measurement rather than an assumption)
//   H  preset-switches/preset-410-pp13-pp24.bin PP#13 → Gate 1 and PP#24 → Megatap 1, i.e. the TWO ENDS of the
//      range the owner's FM3-Edit lists (24 rows): the unit really has 24 per-preset switches, and both strides
//      hold across the whole span (marker+28/+50 for the action codes, marker+292/+424 for the targets)
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
  /**
   * Bytes that MAY move without failing the check, as ABSOLUTE body offsets — a documented known-unknown, named
   * per offset, NEVER a wildcard. The callback is handed the step's own marker, so a caller never has to
   * hard-code a position that the codec's own rule says must be SEARCHED for (the marker moves between presets).
   */
  allowedElsewhere: (o: number, at: number) => boolean;
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
  },
  {
    // The WHOLE REST OF THE RANGE in one edit: PP#6..PP#12 set to seven DISTINCT anchors, so every byte has to
    // be right for the right reason. This is the step that turned the assumed switch count into a measurement —
    // PP#12's target is read here (marker+280) even though the codec's table does not yet carry that index.
    from: '../test/fixtures/preset-switches/preset-410-pp4-delay2-pp5-reverb1.bin',
    to: '../test/fixtures/preset-switches/preset-410-pp6-pp12.bin',
    predictions: [
      { rel: 14, want: 0x04, mustMove: true, what: 'PP#6 action code (marker+14)' },
      { rel: 208, want: 25, mustMove: true, what: 'PP#6 target → 25 = Gate 1 (marker+208, PREDICTED)' },
      { rel: 16, want: 0x04, mustMove: true, what: 'PP#7 action code (marker+16)' },
      { rel: 220, want: 27, mustMove: true, what: 'PP#7 target → 27 = GEQ 1 (marker+220, PREDICTED)' },
      { rel: 18, want: 0x04, mustMove: true, what: 'PP#8 action code (marker+18)' },
      { rel: 232, want: 29, mustMove: true, what: 'PP#8 target → 29 = In 1 (marker+232, PREDICTED)' },
      { rel: 20, want: 0x04, mustMove: true, what: 'PP#9 action code (marker+20)' },
      { rel: 244, want: 31, mustMove: true, what: 'PP#9 target → 31 = Looper (marker+244, PREDICTED)' },
      { rel: 22, want: 0x04, mustMove: true, what: 'PP#10 action code (marker+22)' },
      { rel: 256, want: 32, mustMove: true, what: 'PP#10 target → 32 = Megatap 1 (marker+256, PREDICTED)' },
      { rel: 24, want: 0x04, mustMove: true, what: 'PP#11 action code (marker+24)' },
      { rel: 268, want: 38, mustMove: true, what: 'PP#11 target → 38 = MultDly 1 (marker+268, PREDICTED)' },
      { rel: 26, want: 0x04, mustMove: true, what: 'PP#12 action code (marker+26 — the TWELFTH slot, so the 2-byte stride covers the whole range)' },
      { rel: 280, want: 3, mustMove: true, what: 'PP#12 target → 3 = Chorus 2 (marker+280, PREDICTED — the 12th entry is REAL)' }
    ],
    allowedElsewhere: (o) => isPerformPageByte(o)
  },
  {
    // THE COUNT ITSELF, tested rather than believed: FM3-Edit lists 24 per-preset switches while the codec
    // assumed 12. Two switches — the FIRST and the LAST of the extra range — were set to distinct known
    // anchors, and the strides say exactly where their bytes must land. If only one of the four moved, the
    // range would be two blocks of twelve rather than one array of 24.
    from: '../test/fixtures/preset-switches/preset-410-pp6-pp12.bin',
    to: '../test/fixtures/preset-switches/preset-410-pp13-pp24.bin',
    predictions: [
      { rel: 28, want: 0x04, mustMove: true, what: 'PP#13 action code (marker+28 — the 2-byte stride continues past PP#12)' },
      { rel: 292, want: 25, mustMove: true, what: 'PP#13 target → 25 = Gate 1 (marker+292 = 148 + 12×12, PREDICTED)' },
      { rel: 50, want: 0x04, mustMove: true, what: 'PP#24 action code (marker+50 = 4 + 2×23, PREDICTED)' },
      { rel: 424, want: 32, mustMove: true, what: 'PP#24 target → 32 = Megatap 1 (marker+424 = 148 + 12×23, PREDICTED)' }
    ],
    allowedElsewhere: (o) => isPerformPageByte(o)
  },
  {
    // THE CATEGORY SWEEP — PP#14..PP#23 given ten different functions in one edit. Two things come out of it at
    // once: every remaining action-code slot is located (so the 2-byte array is measured for all 24), and the
    // CODES are read for six categories. It also shows the action code names the FAMILY, not the function:
    // bypass, change-channel and parameter rows all read 0x04.
    //
    // NOTE ON THE `want` VALUES HERE: unlike every other step, this capture was read BEFORE these expectations
    // were written, so this step is a REGRESSION SNAPSHOT, not a prediction. It still earns its place — it pins
    // the slots, the codes and the record fields so a later capture cannot change them unnoticed — but the
    // predictions for the NEXT round live in the hardware plan, written down before the dump.
    from: '../test/fixtures/preset-switches/preset-410-pp13-pp24.bin',
    to: '../test/fixtures/preset-switches/preset-410-pp14-pp23-categories.bin',
    predictions: [
      // Action codes, in order: Scene ×3, Effect ×2, Preset ×2, Tuner, Looper, Control Switch.
      { rel: 30, want: 0x03, mustMove: true, what: 'PP#14 action code (marker+30) — Scene' },
      { rel: 32, want: 0x03, mustMove: true, what: 'PP#15 action code — Scene (a SECOND scene flavour)' },
      { rel: 34, want: 0x03, mustMove: true, what: 'PP#16 action code — Scene again, so 0x03 is the whole scene family' },
      { rel: 36, want: 0x04, mustMove: true, what: 'PP#17 action code — Effect: Change Channel, and it reads the SAME code as Effect: Bypass' },
      { rel: 38, want: 0x04, mustMove: true, what: 'PP#18 action code — Effect: Parameter, also 0x04' },
      { rel: 40, want: 0x02, mustMove: true, what: 'PP#19 action code — Preset (observed)' },
      { rel: 42, want: 0x02, mustMove: true, what: 'PP#20 action code — Preset again' },
      { rel: 44, want: 0x05, mustMove: true, what: 'PP#21 action code — Utility (the assignment was "Utility: Tuner", and 0x05 is the UTILITY category)' },
      { rel: 46, want: 0x08, mustMove: true, what: 'PP#22 action code — Looper (observed)' },
      { rel: 48, want: 0x07, mustMove: true, what: 'PP#23 action code — Control Switch (the owner confirmed this switch was Control Switch, not Layout)' },
      // record+0, the "which one" byte — a scene number here, a preset number there, and ZERO for the four
      // categories that do not select a target at all (18, 21, 22, 23) — hence no predictions for those.
      { rel: 304, want: 3, mustMove: true, what: 'PP#14 record+0 → 3 = SCENE 3 (not an FX slot: a scene action stores a scene number)' },
      { rel: 316, want: 7, mustMove: true, what: 'PP#15 record+0 → 7 = scene 7 (the pair proves the field is the scene number)' },
      { rel: 328, want: 1, mustMove: true, what: 'PP#16 record+0 → 1 (the second scene flavour)' },
      { rel: 340, want: 2, mustMove: true, what: 'PP#17 record+0 → 2 (Effect: Change Channel — a value of 2, which MIGHT be the FX-slot index of the block it changes; unmeasured, with the channel-looking byte at +4)' },
      { rel: 364, want: 28, mustMove: true, what: 'PP#19 record+0 → 28 = a PRESET number' },
      { rel: 376, want: 1, mustMove: true, what: 'PP#20 record+0 → 1 (Preset: Increment)' },
      // The rest of the record: the fields a category writes when it does NOT use +0. Named as observations,
      // not decoded — the per-category layout is still open.
      { rel: 330, want: 1, mustMove: true, what: 'PP#16 record+2 → 1' },
      { rel: 344, want: 1, mustMove: true, what: 'PP#17 record+4 → 1' },
      { rel: 354, want: 2, mustMove: true, what: 'PP#18 record+2 → 2 (Effect: Parameter writes +2, leaving +0 zero)' },
      { rel: 360, want: 1, mustMove: true, what: 'PP#18 record+8 → 1' },
      { rel: 382, want: 255, mustMove: true, what: 'PP#20 record+6 → 255 (low byte of a u16 at +6)' },
      { rel: 383, want: 1, mustMove: true, what: 'PP#20 record+7 → 1 (high byte: 0x01FF = 511)' },
      // Tuner, Looper and the Control Switch row left the WHOLE record zero — 21, 22 and 23. Those are
      // the four rows whose record+0 the codec therefore refuses to read or write.
      { rel: 388, mustMove: false, what: 'PP#21 (Tuner) record stayed ALL ZERO — nothing to locate' },
      { rel: 400, mustMove: false, what: 'PP#22 (Looper) record stayed ALL ZERO' },
      { rel: 412, mustMove: false, what: 'PP#23 (Control Switch) record stayed ALL ZERO' },
      // The second array's four moved slots, PINNED. These are regression expectations (measured, transcribed
      // after the dump), not predictions — but leaving them unpinned meant the bytes could read anything and the
      // check would still pass.
      { rel: 82, want: 1, mustMove: true, what: 'slot 16 of the marker+52 array = 1' },
      { rel: 84, want: 2, mustMove: true, what: 'slot 17 = 2' },
      { rel: 86, want: 3, mustMove: true, what: 'slot 18 = 3' },
      { rel: 88, mustMove: false, what: 'slot 19 stayed ZERO (its switch is the one with a +0-only record)' },
      { rel: 90, want: 4, mustMove: true, what: 'slot 20 = 4' }
    ],
    // This step's own sweep moved FOUR bytes in a region that had been all-zero in every previous capture:
    // marker+82, +84, +86 and +90 read 1, 2, 3, 4 with +88 staying 0. Reading the region back with the tool —
    // not by eye — showed they are not stray bytes at all: they are slots 16/17/18/20 of a stride-2 array that
    // starts right after the action-code array (marker+52) and is one entry per switch. Its MEANING is OPEN
    // (three candidates, in the codec header), but its VALUES are now PINNED as ordinary predictions below —
    // which is why this step needs no `allowedElsewhere` entry for them any more: a pinned expectation that can
    // fail beats a documented unknown that cannot. No offset here is hard-coded: the callback is handed the
    // step's own marker, because the codec's rule is that the marker must be SEARCHED for, never assumed.
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
    ['PP#6 action @14', table[6]?.actionCode === 14],
    ['PP#6 target @208', table[6]?.target === 208],
    ['PP#11 action @24', table[11]?.actionCode === 24],
    ['PP#11 target @268', table[11]?.target === 268],
    ['PP#12 action @26', table[12]?.actionCode === 26],
    ['PP#12 target @280', table[12]?.target === 280],
    ['PP#13 action @28', table[13]?.actionCode === 28],
    ['PP#13 target @292', table[13]?.target === 292],
    ['PP#24 action @50', table[24]?.actionCode === 50],
    ['PP#24 target @424', table[24]?.target === 424],
    ['PP#14 action @30', table[14]?.actionCode === 30],
    ['PP#23 action @48', table[23]?.actionCode === 48],
    // The count is 24 and every ACTION CODE is located; FOUR rows have no located record+0 (18, 21, 22, 23),
    // because those categories leave that byte at zero — so the per-FIELD bound is the live claim, not a
    // per-index one. This is what keeps a stride or a "they all have targets" assumption from slipping in.
    ['the table holds all 24 OBSERVED indices', Object.keys(table).length === 24],
    ['exactly four rows have no located record+0 (18, 21, 22, 23)',
      [18, 21, 22, 23].every((i) => table[i] !== undefined && table[i]!.target === undefined)
      && [14, 15, 16, 17, 19, 20].every((i) => table[i]!.target !== undefined)]
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
    const extras = [...diff].filter((o) => !covered.has(o) && !step.allowedElsewhere(o, at));
    const tolerated = [...diff].filter((o) => !covered.has(o) && step.allowedElsewhere(o, at));
    if (tolerated.length) {
      console.log(`  allowed-elsewhere (documented known-unknowns — named so they cannot drift silently): ` +
        tolerated.map((o) => `marker+${o - at}: ${a[o]}→${b[o]}`).join(', '));
    }
    console.log(`  extras: ${extras.length ? extras.map((o) => `${o} (marker+${o - at}: ${a[o]}→${b[o]})`).join(', ') : 'none'}`);
    if (extras.length) bad++;
  }
  console.log(`\n${bad === 0 ? 'MODEL HOLDS on every captured step' : `${bad} prediction(s) FAILED`}`);
  return bad === 0 ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then((c) => process.exit(c));
