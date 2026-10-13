// The fn=0x1F CHANNEL-BLOCK STRIDE must describe THE BODY IN HAND, not just the family.
//
// DEFECT (measured on the owner's FM3, 2026-10-13, preset 408 "80s test"): the served params of the DRIVE
// block on channels B/C/D were shifted by ONE PARAM relative to the unit's own bytes, while the WRITE
// path — addressed by (eid, paramId) and resolved by the DEVICE — was correct. So the UI showed a
// label/value pair for an edit the unit had stored in a different param.
//
// HOW IT WAS FOUND: a marker write (`pid 2 = 0.9` on channel B) landed at raw index 46, and the served
// readout reported it under `pid 3`. The independent witness is `GET /preset/blocks/:eid/raw`, which
// returns the UNsliced body: index = channel*stride + i, i=0 holding the TYPE. Markers on A/B/C/D at
// 2/46/90/134 pinned the device's per-channel width at exactly 44.
//
// ROOT CAUSE, and the TWO fixes it took. `#channelSlice` took `stride = profile.rangeSections[family].stride`
// whenever that row existed, and three FM3 rows declared a stride that does not describe the body they are
// used on (logged from the fn=0x1F head's own itemCount — the device states it, nothing here is inferred):
//
//   FUZZ (the DRIVE block)  itemCount 176 = 4x44   table said 43   <- off by 1
//   CHORUS                  itemCount 128 = 4x32   table said 29   <- off by 3
//   DELAY                   itemCount 356 = 4x89   table said 88   <- off by 1
//   DISTORT 576=4x144, REVERB 284=4x71, COMP 148=4x37, PHASER 140=4x35, CABINET 424=4x106,
//   INPUT 40=4x10, OUTPUT 104=4x26 — every one divides evenly and was already correct.
//
//   (1) `forgefx-midi` corrects those three rows in `sectionStrideOverlay.ts`, merged at the fm3 index
//       export point. Case 8 pins that the CORRECTED rows reach this server — without it, a dropped
//       overlay would be MASKED by the guard below and the data could silently rot back.
//   (2) `#channelSlice` no longer trusts a stride that does not divide the body: `itemCount % stride === 0`
//       or the stride is derived as `itemCount / 4` (the fallback the driver already used where the table
//       has no row at all). Cases 1-6 pin THAT, against a deliberately STALE table injected here — the
//       guard must hold for a table that is wrong for ANY reason (a future family, an import, a cache
//       row), so this suite must not depend on the shipped data ever being broken again.
//
// WHY THESE CASES NEED NO DECODER: the contract is `index = channel*stride + paramId`. So a marked byte
// changes the served reading EXACTLY WHEN the chosen window contains that index — assert a change at the
// body-derived index and NO change at the competing index, and the window is pinned without any
// test-local re-implementation of the range/taper tables (which a value-equality oracle would have shared
// with the code under test, and which silently broke on the first log-taper param, Chorus Rate).
//
// Mocked transport + the real static FM3 profile: no hardware.
import { PROFILES } from '../../src/devices.js';
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { FM3_RANGE_SECTIONS } from 'forgefx-midi/gen3/fm3';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
const DRIVE_EID = effectRoster().find((e) => e.slug === 'drive')!.page; // 118, FUZZ family
const CHORUS_EID = effectRoster().find((e) => e.slug === 'chorus')!.page; // 78, CHORUS family
const CAB_EID = effectRoster().find((e) => e.slug === 'cab')!.page; // 62, CABINET family
const AMP_EID = effectRoster().find((e) => e.slug === 'amp')!.page; // 58, DISTORT family
const DELAY_EID = effectRoster().find((e) => e.slug === 'delay')!.page; // 70, DELAY family

/** The PRE-overlay strides the GENERATED table declared for the two families this suite injects as stale. */
const STALE_FUZZ = 43;
const STALE_CHORUS = 29;
/** The fn=0x1F itemCount the unit actually reports for each family (logged 2026-10-13). */
const FUZZ_ITEM_COUNT = 176;
const CHORUS_ITEM_COUNT = 128;
const CABINET_ITEM_COUNT = 424;
const AMP_ITEM_COUNT = 576;
const DELAY_ITEM_COUNT = 356;
/** A knob position used as a marker: 0.9 of full scale. Any non-zero byte moves any served float. */
const MARK = Math.round(0.9 * 65534);

/** Drive `Tone` (FUZZ) / Chorus `Depth 1` (CHORUS) / Cab `Room Level` (CABINET) / Amp `Gain 1` (DISTORT). */
const DRIVE_PID = 2;
const CHORUS_PID = 4;
const CAB_PID = 35;
const AMP_GAIN_PID = 7;

export const CHANNEL_SLICE_STRIDE_CASE_COUNT = 8;

// ── frame helpers (the shapes the other driver suites script) ──
const compactHex = (f: readonly number[]) => f.map((b) => b.toString(16).padStart(2, '0')).join('');
const enc14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];
function sysex(fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}
/** A fn-0x13 status dump enumerating `entries` ([eid, channel]) — the PLACED blocks only. */
function statusDump(entries: readonly (readonly [number, number])[]): number[] {
  const payload: number[] = [];
  for (const [eid, ch] of entries) payload.push(...enc14(eid), ch << 1);
  return sysex(0x13, payload);
}
/** A fn=0x1F burst whose head declares `itemCount = values.length` — the device states its own size. */
function bulkFrames(eid: number, values: readonly number[]): number[][] {
  const body: number[] = [0x00, 0x02];
  for (const v of values) body.push(...packValue16(v));
  return [sysex(0x74, [...enc14(eid), ...enc14(values.length), 0x07]), sysex(0x75, body), sysex(0x76, [])];
}

/** A profile whose declared stride for `family` is `stride` (`null` = drop the row entirely). */
function withStride(family: string, stride: number | null) {
  const sections: Record<string, { stride: number; recordCount: number }> = {};
  for (const [k, v] of Object.entries(PROFILES[MODEL]!.rangeSections)) {
    sections[k] = { stride: v.stride, recordCount: v.recordCount };
  }
  if (stride === null) delete sections[family];
  else sections[family] = { stride, recordCount: sections[family]?.recordCount ?? 0 };
  return { ...PROFILES[MODEL]!, rangeSections: sections };
}

/**
 * Serve one block a body of `itemCount` records with a single marker at `markIndex` (`null` = all zeros),
 * and return the reading the driver serves for `pid`.
 */
async function served(
  eid: number, pid: number, channel: number, itemCount: number, markIndex: number | null,
  profile = PROFILES[MODEL]!,
): Promise<number | undefined> {
  const codec = createModernFractalCodec(MODEL);
  const body = new Array<number>(itemCount).fill(0);
  if (markIndex !== null) body[markIndex] = MARK;
  const status = statusDump([[eid, channel]]);
  const mock = new MockTransport('serial', 'mock-channel-slice');
  mock.isOpen = true;
  mock.reply = (req) => {
    if (req[5] === 0x13) return [status];
    if (compactHex(req) === compactHex(codec.buildBlockBulkReadPoll(eid))) return bulkFrames(eid, body);
    return [];
  };
  const driver = createGen3Driver(profile, {
    transport: async () => mock,
    emit: () => {},
    getCadence: () => cadenceFor(MODEL, 'balanced')
  });
  const r = await driver.blockParams(eid);
  return r.named.find((p) => p.id === pid)?.value;
}

/**
 * Pin the window: a marker INSIDE it must move the reading, a marker at `competing` (the index the other
 * candidate stride would use) must NOT. `expectedWindow` is that inside-index minus `pid`.
 */
async function assertWindow(
  eid: number, pid: number, channel: number, itemCount: number, expectedWindow: number,
  competing: number, why: string, profile = PROFILES[MODEL]!,
): Promise<void> {
  const base = await served(eid, pid, channel, itemCount, null, profile);
  assert(base !== undefined, `${why} — pid ${pid} is not served at all, so this case would be vacuous`);
  const inside = await served(eid, pid, channel, itemCount, expectedWindow + pid, profile);
  const outside = await served(eid, pid, channel, itemCount, competing + pid, profile);
  assert(inside !== base, `${why} — a marker at index ${expectedWindow + pid} did NOT move the reading (window is not ${expectedWindow})`);
  assert(outside === base, `control (${why}) — a marker at index ${competing + pid} DID move the reading, so the two windows are not distinguishable here`);
  assert(expectedWindow !== competing, `${why} — the two candidate windows must differ`);
}

export async function runChannelSliceStrideTests(): Promise<void> {
  // ── 1. REQUIRED (the guard): a STALE table stride must not be used when it cannot describe the body. ──
  await assertWindow(DRIVE_EID, DRIVE_PID, 1, FUZZ_ITEM_COUNT, 44, STALE_FUZZ,
    'the drive body\'s own 44-wide channel wins over a stale 43',
    withStride('FUZZ', STALE_FUZZ));

  // ── 2. REQUIRED: the same body on channel D — a +1 stride error is +3 by channel D. ──
  await assertWindow(DRIVE_EID, DRIVE_PID, 3, FUZZ_ITEM_COUNT, 132, STALE_FUZZ * 3,
    'channel D is sliced at 3*44, not 3*43',
    withStride('FUZZ', STALE_FUZZ));

  // ── 3. REQUIRED: CHORUS, off by THREE — proves the rule is not "subtract one, drive only". ──
  await assertWindow(CHORUS_EID, CHORUS_PID, 1, CHORUS_ITEM_COUNT, 32, STALE_CHORUS,
    'the chorus body\'s 32-wide channel wins over a stale 29',
    withStride('CHORUS', STALE_CHORUS));

  // ── 4. GUARD: a table stride that DOES describe the body is still honoured. ──
  // A 172-record drive body is exactly 4x43, so a declared 43 is right for THAT body and must be used.
  await assertWindow(DRIVE_EID, DRIVE_PID, 1, 172, STALE_FUZZ, 44,
    'a table stride that divides the body evenly is honoured',
    withStride('FUZZ', STALE_FUZZ));

  // ── 5. GUARD: the rule is not "always itemCount/4". ──
  // CABINET with a declared stride of 212 divides a 424-record body; itemCount/4 = 106 would be wrong.
  await assertWindow(CAB_EID, CAB_PID, 1, CABINET_ITEM_COUNT, 212, 106,
    'a dividing table stride wins over itemCount/4 (212 divides 424; /4 gives 106)',
    withStride('CABINET', 212));

  // ── 6. GUARD: a family with NO table row still falls back to the body's own shape. ──
  await assertWindow(DRIVE_EID, DRIVE_PID, 1, FUZZ_ITEM_COUNT, 44, STALE_FUZZ,
    'with no table row the body-derived stride applies (176/4)',
    withStride('FUZZ', null));

  // ── 7. GUARD: a family whose declared stride is already correct is untouched by the guard. ──
  // AMP/DISTORT: 576 = 4x144 and the table says 144, so the served window is the same as before.
  await assertWindow(AMP_EID, AMP_GAIN_PID, 1, AMP_ITEM_COUNT, 144, 143,
    'the amp family (table 144, body 4x144) keeps the static stride');

  // ── 8. THE SHIPPED DATA: the three measured-bad rows are CORRECTED in the table this server consumes.
  //    This is the case that fails if `sectionStrideOverlay` is dropped or its merge at the fm3 index
  //    export point is unwired — the guard in cases 1-6 would otherwise mask a regression in the DATA. ──
  {
    const measured: ReadonlyArray<readonly [string, string, number]> = [
      ['FUZZ', 'Drive', FUZZ_ITEM_COUNT],
      ['CHORUS', 'Chorus', CHORUS_ITEM_COUNT],
      ['DELAY', 'Delay', DELAY_ITEM_COUNT],
    ];
    for (const [family, block, itemCount] of measured) {
      const shipped = FM3_RANGE_SECTIONS[family]?.stride;
      assertEqual(PROFILES[MODEL]!.rangeSections[family]?.stride, shipped,
        `${block}: the profile's ${family} stride IS the corrected table's`);
      assertEqual(itemCount % (shipped ?? 0), 0,
        `${block}: the shipped ${family} stride (${shipped}) divides the measured body ${itemCount}`);
      assertEqual(itemCount / (shipped ?? 1), 4, `${block}: the measured body is 4x the shipped stride`);
    }
    // controls, so case 8 cannot pass by describing a hazard that no longer exists:
    assertEqual(STALE_FUZZ, 43, 'the GENERATED FUZZ row this suite injects as stale is still 43');
    assertEqual(FM3_RANGE_SECTIONS['FUZZ']?.stride, 44, 'the EXPORTED FM3_RANGE_SECTIONS carries the corrected 44');
  }
}
