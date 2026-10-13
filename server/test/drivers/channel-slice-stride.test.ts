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
// ROOT CAUSE: `#channelSlice` took `stride = profile.rangeSections[family].stride` whenever that row
// existed, and the row is WRONG for three families on this firmware. Logged from the fn=0x1F head's own
// itemCount (the device states it; nothing here is inferred):
//
//   FUZZ (the DRIVE block)  itemCount 176 = 4x44   table says 43   <- off by 1
//   CHORUS                  itemCount 128 = 4x32   table says 29   <- off by 3
//   DELAY                   itemCount 356 = 4x89   table says 88   <- off by 1
//   DISTORT 576=4x144, REVERB 284=4x71, COMP 148=4x37, PHASER 140=4x35, CABINET 424=4x106,
//   INPUT 40=4x10, OUTPUT 104=4x26 — every one divides evenly and was already correct.
//
// The fix keeps a table stride ONLY when it describes the body (`itemCount % stride === 0`) and otherwise
// derives the stride from the body (`itemCount / 4`, the fallback the driver already used where the table
// has no row at all). Cases 1-3 are the regression; 4-7 are the guards that keep the rule from collapsing
// into "always itemCount/4" or "always the table".
//
// WHY THESE CASES NEED NO DECODER: the contract is `index = channel*stride + paramId`. So a marked byte
// changes the served reading EXACTLY WHEN the chosen window contains that index — assert a change at the
// body-derived index and NO change at the competing table index, and the window is pinned without any
// test-local re-implementation of the range/taper tables (which a value-equality oracle would have shared
// with the code under test, and which silently broke on the first log-taper param).
//
// Mocked transport + the REAL static FM3 profile: no hardware.
import { PROFILES } from '../../src/devices.js';
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
const DRIVE_EID = effectRoster().find((e) => e.slug === 'drive')!.page; // 118, FUZZ family
const CHORUS_EID = effectRoster().find((e) => e.slug === 'chorus')!.page; // 78, CHORUS family
const CAB_EID = effectRoster().find((e) => e.slug === 'cab')!.page; // 62, CABINET family
const AMP_EID = effectRoster().find((e) => e.slug === 'amp')!.page; // 58, DISTORT family
const DELAY_EID = effectRoster().find((e) => e.slug === 'delay')!.page; // 70, DELAY family

/** The table's declared strides — the numbers this suite exists to stop trusting blindly. */
const FUZZ_TABLE = PROFILES[MODEL]!.rangeSections['FUZZ']!.stride; // 43, measured-wrong
const CHORUS_TABLE = PROFILES[MODEL]!.rangeSections['CHORUS']!.stride; // 29, measured-wrong
/** The fn=0x1F itemCount the unit actually reports for each family (logged 2026-10-13). */
const FUZZ_ITEM_COUNT = 176;
const CHORUS_ITEM_COUNT = 128;
const CABINET_ITEM_COUNT = 424;
const AMP_ITEM_COUNT = 576;
/** A knob position used as a marker: 0.9 of full scale. Any non-zero byte moves any served float. */
const MARK = Math.round(0.9 * 65534);

/** Drive `Tone` (FUZZ) / Chorus `Depth 1` (CHORUS) / Cab `Room Level` (CABINET) — all 0..10-or-wider. */
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
  // ── 1. REQUIRED (the regression): DRIVE on channel B. The table says 43; the body is 176 = 4x44. ──
  await assertWindow(DRIVE_EID, DRIVE_PID, 1, FUZZ_ITEM_COUNT, 44, FUZZ_TABLE,
    'the drive body\'s own 44-wide channel wins over the table\'s 43');

  // ── 2. REQUIRED: the same body on channel D — a +1 stride error is +3 by channel D. ──
  await assertWindow(DRIVE_EID, DRIVE_PID, 3, FUZZ_ITEM_COUNT, 132, FUZZ_TABLE * 3,
    'channel D is sliced at 3*44, not 3*43');

  // ── 3. REQUIRED: CHORUS, off by THREE — proves the rule is not "subtract one, drive only". ──
  await assertWindow(CHORUS_EID, CHORUS_PID, 1, CHORUS_ITEM_COUNT, 32, CHORUS_TABLE,
    'the chorus body\'s 32-wide channel wins over the table\'s 29');

  // ── 4. GUARD: a table stride that DOES describe the body is still honoured. ──
  // A 172-record drive body is exactly 4x43, so the table row is right for it and must be used.
  await assertWindow(DRIVE_EID, DRIVE_PID, 1, 172, FUZZ_TABLE, 44,
    'a table stride that divides the body evenly is honoured');

  // ── 5. GUARD: the rule is not "always itemCount/4". ──
  // CABINET with a declared stride of 212 divides a 424-record body; itemCount/4 = 106 would be wrong.
  {
    const patched = {
      ...PROFILES[MODEL]!,
      rangeSections: { ...PROFILES[MODEL]!.rangeSections, CABINET: { stride: 212, recordCount: 110 } }
    };
    await assertWindow(CAB_EID, CAB_PID, 1, CABINET_ITEM_COUNT, 212, 106,
      'a dividing table stride wins over itemCount/4 (212 divides 424; /4 gives 106)', patched);
  }

  // ── 6. GUARD: a family with NO table row still falls back to the body's own shape. ──
  {
    const rest = Object.entries(PROFILES[MODEL]!.rangeSections).filter(([k]) => k !== 'FUZZ');
    const patched = { ...PROFILES[MODEL]!, rangeSections: Object.fromEntries(rest) };
    await assertWindow(DRIVE_EID, DRIVE_PID, 1, FUZZ_ITEM_COUNT, 44, FUZZ_TABLE,
      'with no table row the body-derived stride applies (176/4)', patched);
  }

  // ── 7. GUARD: a family whose table stride is already correct is untouched by the fix. ──
  // AMP/DISTORT: 576 = 4x144 and the table says 144, so the served window is the same as before.
  await assertWindow(AMP_EID, AMP_GAIN_PID, 1, AMP_ITEM_COUNT, 144, 143,
    'the amp family (table 144, body 4x144) keeps the static stride');

  // ── 8. The DELAY family is the third measured-wrong row (356 = 4x89 vs table 88); assert it from the
  //    TABLE's own numbers rather than a hard-coded guess, so the case still means something if the
  //    table is ever corrected. ──
  {
    const table = PROFILES[MODEL]!.rangeSections['DELAY']!.stride; // 88
    const itemCount = 356; // measured; 356 % 88 === 4, so the table cannot describe this body
    assertEqual(itemCount % table, 4, `precondition: the DELAY table stride (${table}) does not divide the measured body (${itemCount})`);
    await assertWindow(DELAY_EID, 16, 1, itemCount, itemCount / 4, table,
      'the delay body\'s 89-wide channel wins over the table\'s 88');
  }
}
