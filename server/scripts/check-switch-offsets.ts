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
//   I  preset-switches/preset-410-enumeration.bin  ROUND 10, the ENUMERATION — the seven unmeasured category
//      codes plus the discriminators. **Its predictions were committed while this fixture did not exist** (the
//      step prints PENDING until it lands), which is what makes every `want` in it a prediction rather than a
//      value transcribed from a dump. The row list is "ROUND 10" in review-2026-10-09/HARDWARE-ROUND-PLAN.md.
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
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parsePresetDump, decodeRawPatch, findPerPresetSwitchBlock, parsePerPresetSwitches, PP_ACTION_OFFSET, PP_TARGET_OFFSET, PP_MEASURED_OFFSETS } from 'forgefx-midi/devices/gen3';

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

/**
 * The HOLD action-code array's base, relative to the marker: MEASURED 2026-10-11 as 148 + 12 × 24 = 436, i.e.
 * immediately after the twenty-fourth 12-byte record. One u16 per switch, the same width and stride as the TAP
 * action-code array at +4 — so a HOLD definition mirrors a TAP definition. Declared BEFORE `STEPS` because the
 * step below uses it in its own initializer. Not yet a codec constant: the HOLD half is decoded but not wired,
 * and this file must not invent a model the codec does not carry.
 */
const PP_HOLD_REL = 436;

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
    // the three Effect functions set that day all read 0x04.
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
      { rel: 36, want: 0x04, mustMove: true, what: 'PP#17 action code — an Effect function (the docs called it "Change Channel" then; FM3-Edit calls it Chan Toggle), reading the SAME code as Bypass' },
      { rel: 38, want: 0x04, mustMove: true, what: 'PP#18 action code — Effect function #3 (Chan Inc/Dec), also 0x04' },
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
      { rel: 340, want: 2, mustMove: true, what: 'PP#17 record+0 → 2 (that row was Chan Toggle — a value of 2, whose meaning was unmeasured then, with the +4 byte beside it)' },
      { rel: 364, want: 28, mustMove: true, what: 'PP#19 record+0 → 28 = a PRESET number' },
      { rel: 376, want: 1, mustMove: true, what: 'PP#20 record+0 → 1 (Preset: Increment)' },
      // The rest of the record: the fields a category writes when it does NOT use +0. Named as observations,
      // not decoded — the per-category layout is still open.
      { rel: 330, want: 1, mustMove: true, what: 'PP#16 record+2 → 1' },
      { rel: 344, want: 1, mustMove: true, what: 'PP#17 record+4 → 1' },
      { rel: 354, want: 2, mustMove: true, what: 'PP#18 record+2 → 2 (that row was Effect function #3 / Chan Inc/Dec, writing +2 and leaving +0 zero)' },
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
  },
  {
    // ── ROUND 10 — the ENUMERATION (2026-10-11). READ, so this step is now a REGRESSION SNAPSHOT. ──────────
    // The predictions were committed in ForgeFX a5c79f1 while the fixture did NOT exist, so their pre-dump
    // wording is preserved in git — and the capture then did three things to them, each recorded inline:
    //   • 7/7 unmeasured category codes read EXACTLY as predicted (0x01 Bank … 0x0D Song Section), which takes
    //     the "code = the category's position in FM3-Edit's dropdown" reading to 13 measured codes, 13 exact;
    //   • the CHANNEL hypothesis was CORRECTED: the channel is at record+2 (A=0·B=1·C=2·D=3, measured B and D)
    //     and NOT at +4 as predicted, so the two +4 predictions are now mustMove:false;
    //   • the HOLD HOME was REFUTED: +100…+147 stayed ZERO and the HOLD action codes appeared at
    //     marker+436 + 2·(i−1) — three bytes (8, 5, 7 = Looper, Utility, Control Switch) found by the extras
    //     line because they sat OUTSIDE the dump script's print window, which is now widened.
    // Two rows (PP#18, PP#19) could not be set to the planned functions, so the predictions that named those
    // functions never applied — they are marked as such rather than quietly deleted or retro-fitted. The list it implements is "ROUND 10 — the authoritative list" in
    // review-2026-10-09/HARDWARE-ROUND-PLAN.md; the open questions it is designed to answer are:
    //   • the seven unmeasured CATEGORY codes (Bank/Layout/Per-Preset/View/Setlist/Song/Song Section);
    //   • whether a Chan Select row's record+0 is the FX-SLOT INDEX (three independent blocks: Chorus 1 = 2,
    //     Reverb 1 = 51, Delay 1 = 7) — which decides whether Axis may name effect rows again;
    //   • whether the marker+52 array is the HOLD half: the three HOLDs sit on rows 16/17/18, whose TAPs are
    //     UNCHANGED from the sweep and whose slots read 1/2/3 — so those three slots are a positive control;
    //   • whether +100…+147 (24 u16, zero in every capture) is the HOLD home: `+100 + 2·(i−1)`;
    //   • function index vs allocation index: three Scene: Toggles (12/13/16) and two Chan Select rows (18/19).
    // A FAIL below is a RESULT, not a broken test: a prediction that fails is how the contiguous-target-array
    // reading was refuted. Anything this step cannot predict is named per INDEX (never as a blank cheque over
    // a region) and still printed, so no moved byte goes unreported.
    from: '../test/fixtures/preset-switches/preset-410-pp14-pp23-categories.bin',
    to: '../test/fixtures/preset-switches/preset-410-enumeration.bin',
    predictions: [
      // The twenty-four ACTION CODES. Rows 16/17/18 keep the sweep's TAP (so their code must NOT move), and
      // 20/21/22/23 are unchanged rows; every other row is reassigned, so its code must move to the CATEGORY's
      // position in FM3-Edit's own list — the seven unchecked categories are the predictions under test.
      { rel: 4,  want: 0x01, mustMove: true,  what: 'PP#1 action code → Bank (PREDICTED 0x01)' },
      { rel: 6,  want: 0x06, mustMove: true,  what: 'PP#2 action code → Layout (PREDICTED 0x06 — the gap INSIDE the measured run)' },
      { rel: 8,  want: 0x09, mustMove: true,  what: 'PP#3 action code → Per-Preset (PREDICTED 0x09)' },
      { rel: 10, want: 0x0a, mustMove: true,  what: 'PP#4 action code → View (PREDICTED 0x0A)' },
      { rel: 12, want: 0x0b, mustMove: true,  what: 'PP#5 action code → Setlist (PREDICTED 0x0B)' },
      { rel: 14, want: 0x0c, mustMove: true,  what: 'PP#6 action code → Song (PREDICTED 0x0C)' },
      { rel: 16, want: 0x0d, mustMove: true,  what: 'PP#7 action code → Song Section (PREDICTED 0x0D — the FAR END; where a hidden category would shift everything)' },
      { rel: 18, want: 0x03, mustMove: true,  what: 'PP#8 action code → Scene: Select (was Effect: Bypass)' },
      { rel: 20, want: 0x03, mustMove: true,  what: 'PP#9 action code → Scene: Select 8' },
      { rel: 22, want: 0x02, mustMove: true,  what: 'PP#10 action code → Preset: Select 1' },
      { rel: 24, want: 0x02, mustMove: true,  what: 'PP#11 action code → Preset: Select 100' },
      { rel: 26, want: 0x03, mustMove: true,  what: 'PP#12 action code → Scene: Toggle' },
      { rel: 28, want: 0x03, mustMove: true,  what: 'PP#13 action code → Scene: Toggle (the second one)' },
      { rel: 30, want: 0x04, mustMove: true,  what: 'PP#14 action code → Effect: Chan Select' },
      { rel: 32, want: 0x04, mustMove: true,  what: 'PP#15 action code → Effect: Chan Select' },
      { rel: 34, want: 0x03, mustMove: false, what: 'PP#16 action code → Scene: Toggle (TAP UNCHANGED from the sweep — a positive control)' },
      { rel: 36, want: 0x04, mustMove: false, what: 'PP#17 action code → Effect: Chan Select (TAP category unchanged)' },
      { rel: 38, want: 0x04, mustMove: false, what: 'PP#18 action code → Effect: Chan Select (TAP category unchanged)' },
      { rel: 40, want: 0x04, mustMove: true,  what: 'PP#19 action code → Effect: Chan Select (was Preset: Select)' },
      { rel: 42, want: 0x02, mustMove: false, what: 'PP#20 action code → Preset: Increment (UNCHANGED — the fourth control row)' },
      { rel: 44, want: 0x05, mustMove: false, what: 'PP#21 action code → Utility: Tuner (unchanged)' },
      { rel: 46, want: 0x08, mustMove: false, what: 'PP#22 action code → Looper (unchanged category, different function)' },
      { rel: 48, want: 0x07, mustMove: false, what: 'PP#23 action code → Control Switch (unchanged)' },
      { rel: 50, want: 0x07, mustMove: true,  what: 'PP#24 action code → Control Switch 4 (was Effect: Bypass)' },
      // THE SEVEN NEW CATEGORIES WRITE record+0 TOO — their "which one" value, exactly like the categories
      // measured before them: Bank 1 → 1, Layout 2 → 2, Per-Preset/View/Setlist/Song/Song Section 1 → 1. These
      // were left as tolerated unknowns by the pre-dump step (the layout had never been seen) and are pinned
      // now that the capture has read them — a value that CAN fail beats a documented unknown that cannot.
      { rel: 148, want: 1, mustMove: true, what: 'PP#1 (Bank 1) record+0 → 1 — a BANK row writes its item number here (was 20 = a Bypass row\'s Filter 4)' },
      { rel: 160, want: 2, mustMove: true, what: 'PP#2 (Layout 2) record+0 → 2 = the layout number (was 14 = FB Rtn 2)' },
      { rel: 162, want: 1, mustMove: true, what: 'PP#2 record+2 → 1 — the Layout row writes a SECOND field, position unlocated (0 in every earlier capture)' },
      { rel: 172, want: 1, mustMove: true, what: 'PP#3 (Per-Preset 1) record+0 → 1' },
      { rel: 184, want: 1, mustMove: true, what: 'PP#4 (View 1) record+0 → 1' },
      { rel: 196, want: 1, mustMove: true, what: 'PP#5 (Setlist 1) record+0 → 1' },
      { rel: 208, want: 1, mustMove: true, what: 'PP#6 (Song 1) record+0 → 1' },
      { rel: 220, want: 1, mustMove: true, what: 'PP#7 (Song Section 1) record+0 → 1' },
      // record+0 — the field whose MEANING is per-category.
      { rel: 232, want: 1,   mustMove: true,  what: 'PP#8 record+0 → 1 = scene 1 (was 29 = In 1)' },
      { rel: 244, want: 8,   mustMove: true,  what: 'PP#9 record+0 → 8 = scene 8' },
      { rel: 256, want: 1,   mustMove: true,  what: 'PP#10 record+0 → 1 = preset 1' },
      { rel: 268, want: 100, mustMove: true,  what: 'PP#11 record+0 → 100 = preset 100 (a byte, not a u16 — see the plan)' },
      { rel: 280, want: 1,   mustMove: true,  what: 'PP#12 record+0 → 1 = the Scene: Toggle PRIMARY' },
      { rel: 282, want: 5,   mustMove: true,  what: 'PP#12 record+2 → 5 = its SECONDARY (12 vs 13 decide which offset is which)' },
      { rel: 292, want: 3,   mustMove: true,  what: 'PP#13 record+0 → 3 = PRIMARY 3' },
      { rel: 294, want: 8,   mustMove: true,  what: 'PP#13 record+2 → 8 = SECONDARY 8' },
      // THE NAME QUESTION: does a Chan Select row carry the FX-SLOT INDEX at +0? Three blocks, three values,
      // one hypothesis — and the channel byte beside it, predicted from the channel numbers that were set.
      { rel: 304, want: 2,   mustMove: true,  what: 'PP#14 (Chan Select → Chorus 1) record+0 → 2 = the FX-slot index of Chorus 1' },
      { rel: 306, want: 1,   mustMove: true,  what: 'PP#14 record+2 → 1 = the CHANNEL (CORRECTED by the capture: the channel is at +2, not +4, and this row is channel B = 1)' },
      { rel: 308, mustMove: false, what: 'PP#14 record+4 stays 0 — the PREDICTED channel offset, WRONG: the channel is at +2 (see marker+306)' },
      { rel: 318, want: 3,   mustMove: true,  what: 'PP#15 record+2 → 3 = channel D (A=0·B=1·C=2·D=3 — a second channel, so the field and its encoding are both measured)' },
      { rel: 316, want: 51,  mustMove: true,  what: 'PP#15 (Chan Select → Reverb 1) record+0 → 51 = the FX-slot index of Reverb 1' },
      { rel: 320, mustMove: false, what: 'PP#15 record+4 stays 0 — the PREDICTED channel offset, WRONG (see marker+318)' },
      { rel: 340, want: 7,   mustMove: true,  what: 'PP#17 (Chan Select → Delay 1) record+0 → 7 = the FX-slot index of Delay 1 (a THIRD block, same question)' },
      { rel: 344, want: 1,   mustMove: false, what: 'PP#17 record+4 stays 1 — an UNEXPLAINED 1, stable across two captures (the sweep read 1 here too, with a different Effect function); it is NOT the channel, which is at +2 and reads 0 = channel A' },
      { rel: 364, mustMove: false, what: "PP#19 record+0 = 28 — the planned function could NOT be set, so the prediction never applied; 28 is GEQ 2's FX-slot index, and the byte is unchanged from the sweep ONLY BY COINCIDENCE (its PP#19 was Preset: Select 28), which is why this is a no-move and not a value claim" },
      { rel: 366, want: 1,   mustMove: true,  what: 'PP#19 record+2 → 1 = channel B — a THIRD row placing the channel at +2, agreeing with PP#14' },
      { rel: 354, mustMove: true,  what: 'PP#18 record+2 → 0 — the planned function could not be set; as a Chan Select row on Amp 1 / channel A its WHOLE record reads zero (the field moved from the old row\'s value)' },
      { rel: 360, mustMove: true,  what: 'PP#18 record+8 → 0 (the same row change)' },
      { rel: 372, mustMove: false, what: 'PP#19 record+8 stays 0 — the same row change (this is not the planned row)' },
      { rel: 424, mustMove: true,  what: 'PP#24 record+0 MOVES (a Control Switch row: value not decodable, only that it changes)' },
      // Rows that must NOT move at all: 16 (the HOLD-test control — only its HOLD changes), 18/19's +0 already
      // stated above, and the four unchanged rows 20/21/22/23 whose records were empty apart from the
      // Preset: Increment u16.
      { rel: 328, mustMove: false, what: 'PP#16 record+0 stays 1 (the TAP is unchanged; only its HOLD is set)' },
      { rel: 330, mustMove: false, what: 'PP#16 record+2 stays 1' },
      { rel: 352, mustMove: false, what: 'PP#18 record+0 stays 0' },
      { rel: 376, mustMove: false, what: 'PP#20 record+0 stays 1' },
      { rel: 382, mustMove: false, what: 'PP#20 record+6 stays 255 (the u16 511)' },
      { rel: 383, mustMove: false, what: 'PP#20 record+7 stays 1' },
      { rel: 388, mustMove: false, what: 'PP#21 (Utility: Tuner) record+0 stays 0' },
      { rel: 400, mustMove: false, what: 'PP#22 (Looper) record+0 stays 0 — the answer to "does every looper mode leave it empty?" is read from its extras' },
      { rel: 412, mustMove: false, what: 'PP#23 (Control Switch 1) record+0 stays 0' },
      // THE HOLD DISCRIMINATOR — the second array's four control slots, plus the predicted HOLD home.
      // THE +52 ARRAY = the TAP's FUNCTION INDEX WITHIN ITS CATEGORY (0 = the category's first entry). The
      // pre-written discriminator was "a function index predicts REPEATS when two switches share a function,
      // an allocation index predicts DISTINCT ascending ones" — the capture answered REPEATS: five Change
      // Channel rows all read 1 and three Scene: Toggles all read 1, so the allocation reading is REFUTED.
      // Reading it as the HOLD half is refuted too: the three HOLDs are Looper/Utility/Control Switch and these
      // slots read 1/1/1 while the HOLD codes appeared at +436 (below).
      { rel: 74, want: 1, mustMove: true, what: 'slot 12 = 1 = Scene #1 (Toggle) — 0 was Scene #0 (Select)' },
      { rel: 76, want: 1, mustMove: true, what: 'slot 13 = 1 — the SAME function ⇒ the SAME value (the REPEATS prediction that killed the allocation index)' },
      { rel: 78, want: 1, mustMove: true, what: 'slot 14 = 1 = Effect #1 (Chan Select) — 0 was Effect #0 (Bypass)' },
      { rel: 80, want: 1, mustMove: true, what: 'slot 15 = 1 — the same function, the same value' },
      { rel: 82, mustMove: false, what: 'slot 16 stays 1 — the HOLD test\'s POSITIVE CONTROL: its TAP is unchanged and its HOLD is now Looper, and the slot did NOT take a HOLD value' },
      { rel: 84, want: 1, mustMove: true, what: 'slot 17 = 1 — it read 2 in the sweep, when this row held a different Effect function: the array tracks the FUNCTION, so it moved with the TAP and not with the HOLD' },
      { rel: 86, want: 1, mustMove: true, what: 'slot 18 = 1 — it read 3 in the sweep (a third Effect function) and follows the function, not the HOLD' },
      { rel: 88, want: 1, mustMove: true, what: 'slot 19 = 1 = Chan Select (it read 0 as Scene/Preset #0 in the sweep)' },
      { rel: 90, mustMove: false, what: 'slot 20 stays 4 = Preset #4 (Increment) — unchanged row, so a stable function index' },
      { rel: 94, want: 4, mustMove: true, what: 'slot 22 = 4 = the Looper function index of Undo/Erase (0 with the sweep\'s looper function) — a within-category function change in a second category' },
      // REFUTED — the HOLD home. Kept as mustMove:false so the wrong reading cannot come back.
      { rel: 130, mustMove: false, what: 'marker+130 (+100 + 2·15) stayed 0 — REFUTED: the HOLD half is NOT the +100…+147 span' },
      { rel: 132, mustMove: false, what: 'marker+132 (+100 + 2·16) stayed 0 — REFUTED' },
      { rel: 134, mustMove: false, what: 'marker+134 (+100 + 2·17) stayed 0 — REFUTED' },
      // THE HOLD HALF, FOUND BY THE EXTRAS LINE: a second 24-wide u16 ACTION-CODE array at marker+436 + 2·(i−1)
      // (436 = 148 + 12×24, i.e. immediately after the last 12-byte record). The three HOLDs set for this round
      // read back as their categories' codes, in row order, and every other row stayed 0 (all HOLDs unassigned).
      { rel: PP_HOLD_REL, mustMove: false, what: 'PP#1 HOLD stays 0 (Unassigned) — every HOLD row except 16/17/18 was left unassigned' },
      { rel: PP_HOLD_REL + 2 * 15, want: 0x08, mustMove: true, what: 'PP#16 HOLD = 0x08 Looper — the HOLD half lives at marker+436 + 2·(i−1)' },
      { rel: PP_HOLD_REL + 2 * 16, want: 0x05, mustMove: true, what: 'PP#17 HOLD = 0x05 Utility (the assignment was Utility: Tuner — 0x05 is the Utility category)' },
      { rel: PP_HOLD_REL + 2 * 17, want: 0x07, mustMove: true, what: 'PP#18 HOLD = 0x07 Control Switch (Control Switch 1)' }
    ],
    // Named, per-INDEX unknowns — not a wildcard over the block. The seven newly enumerated categories have a
    // record layout nobody has seen yet, and three individual rows have a field whose position is unknown
    // (PP#11's possible u16, PP#17's block index, PP#24's Control-Switch number). Their bytes are still PRINTED
    // by the tolerated line below, so nothing is invisible; the pins above are what the check has teeth on.
    allowedElsewhere: (o, at) =>
      isPerformPageByte(o) ||
      ENUM_UNDECODED_RECORD_ROWS.some((i) => o >= at + 148 + 12 * (i - 1) && o < at + 148 + 12 * (i - 1) + 12) ||
      (o >= at + 52 && o < at + 100)
  },
  {
    // R11-P0-C (2026-10-12): the owner set PP#1 → Looper: Half Speed, PP#2 → Utility: Scene Level + Save and
    // PP#3 → Control Switch: Latching so that "the editor lists its entries in index order" — the ONE step of
    // the owner's menu read-out that is an assumption rather than a measurement — could be tested. The three
    // indices below were written down in review-2026-10-09/HARDWARE-ROUND-PLAN.md ("R11-P0-C") BEFORE the dump,
    // and each is the LAST entry of its list (5 of six, 4 of five, 1 of two): deliberately non-zero and
    // unique, because a FIRST entry would predict 0 under every candidate ordering and prove nothing.
    //
    // Everything else may differ, and does: between these two captures the owner rewrote rows freely, so the
    // rest of the block is USER DATA, not model output. The allowance is therefore the WHOLE block, named as
    // such — the teeth here are the six predicted bytes (the three indices and their rows' action codes).
    from: '../test/fixtures/preset-switches/preset-410-enumeration.bin',
    to: '../test/fixtures/preset-switches/preset-410-r11-p0c.bin',
    predictions: [
      { rel: PP_ACTION_OFFSET, want: 0x08, mustMove: true, what: 'PP#1 action code → 0x08 Looper' },
      { rel: PP2_ACTION_REL, want: 0x05, mustMove: true, what: 'PP#2 action code → 0x05 Utility' },
      { rel: PP3_ACTION_REL, want: 0x07, mustMove: true, what: 'PP#3 action code → 0x07 Control Switch' },
      { rel: 52, want: 5, mustMove: true, what: 'PP#1 function index = 5 = Looper: Half Speed (PREDICTED — the menu order IS the wire index)' },
      { rel: 54, want: 4, mustMove: true, what: 'PP#2 function index = 4 = Utility: Scene Level + Save (PREDICTED)' },
      { rel: 56, want: 1, mustMove: true, what: 'PP#3 function index = 1 = Control Switch: Latching (PREDICTED)' },
      // Regression snapshots, TRANSCRIBED after the capture — labelled as such, not sold as predictions. The
      // same dump read two Effect rows at indices 2 and 3, which is the wire's own evidence that those entries
      // exist (until now only Effect: Bypass = 0 and Chan Select = 1 had been seen).
      { rel: 52 + 2 * 16, want: 2, mustMove: true, what: 'PP#17 function index = 2 (snapshot: Effect: Chan Toggle)' },
      { rel: 52 + 2 * 17, want: 3, mustMove: true, what: 'PP#18 function index = 3 (snapshot: Effect: Chan Inc/Dec)' }
    ],
    allowedElsewhere: (o, at) => isPerformPageByte(o) || (o >= at + 4 && o < at + PP_HOLD_REL + 2 * 24)
  },
  {
    // R11-A (2026-10-12) — THE HOLD WRITE, first time on a real unit. Pre-registered in
    // review-2026-10-09/HARDWARE-ROUND-PLAN.md: PP#5 HOLD := Control Switch (0x07) through
    // `PUT /preset/switches/5`, then read the EDIT BUFFER with a dump (the independent path — the route's own
    // read-back is the path that wrote). The subject was chosen because its HOLD slot was ALREADY 0 in the
    // pre-write capture: a slot already holding the value being written proves nothing about a write landing.
    //
    // What the two captures below show: exactly ONE byte moved, at marker+444 = 436 + 2×4 — PP#5's slot, in the
    // HOLD array's own stride — and the restore's dump is byte-identical to the pre-write one (same sha256).
    // The allowance is the perform page only, so "nothing else moved" is enforced rather than assumed.
    from: '../test/fixtures/preset-switches/preset-410-r11-p0c.bin',
    to: '../test/fixtures/preset-switches/preset-410-r11a-hold-pp5-after.bin',
    predictions: [
      { rel: PP_HOLD_REL + 2 * 4, want: 0x07, mustMove: true, what: 'PP#5 HOLD = 0x07 Control Switch — the first HOLD this stack has written to a real unit' }
    ],
    allowedElsewhere: (o) => isPerformPageByte(o)
  },
  {
    // The RESTORE half of R11-A. "Restored" here does not rest on the route's verdict (which echoes what we
    // sent) but on a fresh dump agreeing with the pre-write capture; this step pins the byte, and the
    // sha256 comparison is stated in the ROUND 11 result text.
    from: '../test/fixtures/preset-switches/preset-410-r11a-hold-pp5-after.bin',
    to: '../test/fixtures/preset-switches/preset-410-r11a-hold-pp5-restored.bin',
    predictions: [
      { rel: PP_HOLD_REL + 2 * 4, want: 0, mustMove: true, what: 'PP#5 HOLD back to 0 (Unassigned) — the restore, confirmed by dump and not by a same-path read-back' }
    ],
    allowedElsewhere: (o) => isPerformPageByte(o)
  }
];

/**
 * The rows whose 12-byte RECORD layout is genuinely undecoded at the time ROUND 10 was written: the seven
 * newly enumerated categories (their record is seen for the first time), and the rows carrying a field whose
 * position or width nobody has located. Listed by INDEX and printed, never expressed as a byte range.
 */
const ENUM_UNDECODED_RECORD_ROWS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 24];

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
  // R11-P0-C's capture, decoded through the SHIPPED codec: the three rows the owner set on 2026-10-12 must NAME
  // themselves out of PP_FUNCTION_NAMES. This is what keeps the menu read-out under the gate instead of in a
  // document — a name edited wrongly, or a list trimmed, fails here rather than shipping.
  const r11Rel = '../test/fixtures/preset-switches/preset-410-r11-p0c.bin';
  const r11 = existsSync(new URL(r11Rel, import.meta.url)) ? parsePerPresetSwitches(load(r11Rel)) : null;
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
      && [14, 15, 16, 17, 19, 20].every((i) => table[i]!.target !== undefined)],
    // The 2026-10-12 menu read-out, checked against a real capture through the shipped decoder.
    ['R11-P0-C capture: PP#1 decodes as Looper: Half Speed', r11?.switches[0]?.functionName === 'Half Speed'],
    ['R11-P0-C capture: PP#2 decodes as Utility: Scene Level + Save', r11?.switches[1]?.functionName === 'Scene Level + Save'],
    ['R11-P0-C capture: PP#3 decodes as Control Switch: Latching', r11?.switches[2]?.functionName === 'Latching']
  ];
  for (const [what, ok] of claims) {
    if (!ok) { console.log(`FAIL: the codec table no longer says "${what}" — the predictions below were written against that table`); bad++; }
  }
  for (const step of STEPS) {
    // A step whose capture has not been taken yet reports PENDING and is skipped — the predictions for ROUND 10
    // were committed to this file BEFORE the dump existed, which is the only way to prove they were written in
    // advance, and a missing fixture must not fail a gate that has nothing to check.
    if (!existsSync(new URL(step.to, import.meta.url))) {
      console.log(`\nPENDING (capture not taken yet): ${step.to}`);
      console.log('  its predictions are committed BEFORE the dump on purpose — checked the moment the fixture lands');
      continue;
    }
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
