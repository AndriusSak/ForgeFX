// The log/linear taper decision for a range row, pinned through the driver's REAL display path.
//
// INCIDENT (owner, 2026-10-13): with Cab Drive set to 5.00 on the unit, the app showed 0.32. The unit's own
// display string (self-describe view 0x00, read with scripts/audit-taper-vs-device.ts) says "5.00" at raw
// 32768. So the DECODE was wrong, not the wire and not the render.
//
// ROOT CAUSE: the taper for a row with no explicit `taper` came from `(typecode >> 4) & 0xf ∈ {4,5}`. The
// rule was derived from the frequency cuts (0x240/0x241, nibble 4, genuine log10 — CABINET/55 Frequency
// served 5000.07 against the unit's 5000.1 and CABINET/39 High Cut 1 9999.895 against 10000, both matching).
// Typecode 0x52 — the "Drive"/gain-style class — lands on nibble 5 by coincidence and is NOT log: the
// instrument is linear there (0.00 at raw 0 on the unit's screen, 5.00 at mid-scale for Cab Drive).
//
// WHAT THIS SUITE ASSERTS (review R18 finding #8; re-review R19 finding #1 hardened this): the value the
// SERVER actually serves, obtained by calling `driver.blockParams()` over a MockTransport against the REAL
// static FM3 profile — NOT a local re-derivation of gen3.ts `#display`. The three CAB rows below are read
// through that real path, so the assertion covers the `kind === 'float'` gate, `rangeIsLog`'s taper
// decision, the codec's `wireToDisplay`, the driver's own `round3` and its 65534 divisor, and the served
// record's `log` flag. The driver's served `value` is compared against the instrument's own printed number.
//
//   NOT covered by this suite (named, not implied): `#display`'s catch-to-0..10 fallback and its
//   `kind !== 'float'` branch — every fixture row here is a float row with a real range; and the six
//   further nibble-5 rows in §2 are asserted for the taper DECISION only, not for a served value (see §2).
//
// Every typecode-0x52 param the audit could read disagreed with the unit: CABINET/33 Drive (0.316 vs 5.00),
// CHORUS/20 Drive, FLANGER/20 Drive, FLANGER/26 Bass Focus, DELAY/22 Drive, DELAY/58 Resonance, REVERB/32
// Drive. Those are the fixtures below. Real table data, real device numbers, no hardware needed.

import { createGen3Driver, rangeIsLog } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES } from '../../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { wireToDisplay } from 'forgefx-midi/shared';
import { FM3_RANGES } from 'forgefx-midi/gen3/fm3';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
const CAB_EID = effectRoster().find((e) => e.slug === 'cab')!.page;

/** raw 32768 is exactly mid-scale (the unit's own reading was taken at this byte). */
const MID_RAW = 32768;
/** The driver normalises with /65534, NOT /65535: gen3.ts `#display` computes `clamp01(raw / 65534)`.
 *  The served `norm` is asserted equal to MID_RAW/RAW_MAX below — that is what pins the divisor. */
const RAW_MAX = 65534;
/** Normalised wire value the server should serve for `MID_RAW`: 32768/65534 = 0.500015259… (65535 would
 *  give 0.500007629…, so this distinguishes the two divisors). */
const MID_NORM = MID_RAW / RAW_MAX;

/** Minimal shape of an FM3 range row the taper decision needs. */
interface RangeRow {
  displayMin: number;
  displayMax: number;
  typecode?: number;
  taper?: string;
}

// ── the REAL driver over a mocked transport (same harness the other driver suites use) ──────────────
const compactHex = (f: readonly number[]): string => f.map((b) => b.toString(16).padStart(2, '0')).join('');
const enc14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];
function sysex(fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}
/** fn=0x74/0x75/0x76 block-bulk-read reply carrying `values` (same shape as cab-btn-pseudo-param). */
function blockBulkFrames(eid: number, values: readonly number[]): number[][] {
  const body: number[] = [0x00, 0x02];
  for (const v of values) body.push(...packValue16(v));
  return [sysex(0x74, [...enc14(eid), ...enc14(values.length), 0x07]), sysex(0x75, body), sysex(0x76, [])];
}

/** Read the CABINET block through the real gen-3 driver (mocked transport, real static FM3 profile).
 *  `overrides` sets the raw wire value for specific paramIds so the SERVED value can be checked. */
async function servCabParams(overrides: Record<number, number>) {
  const profile = PROFILES[MODEL]!;
  const stride = profile.rangeSections['CABINET']?.stride ?? 1;
  const values = new Array(Math.max(stride, 1) * 4).fill(0);
  for (const [pid, raw] of Object.entries(overrides)) values[Number(pid)] = raw;
  const bulk = blockBulkFrames(CAB_EID, values);
  const codec = createModernFractalCodec(profile.model);
  const mock = new MockTransport('serial', 'mock-range-taper');
  mock.isOpen = true;
  mock.reply = (req) => (compactHex(req) === compactHex(codec.buildBlockBulkReadPoll(CAB_EID)) ? bulk : []);
  const driver = createGen3Driver(profile, {
    transport: async () => mock,
    emit: () => {},
    getCadence: () => cadenceFor(profile.model, 'balanced'),
  });
  return driver.blockParams(CAB_EID);
}

/** The typecode-nibble class size the correction was measured against. */
const NIBBLE_5_PARAMS = 17;
const NIBBLE_4_PARAMS = 274;

/** Assertions this suite makes when every row it names is present (the registration prints this). */
export const RANGE_TAPER_CLASS_CASE_COUNT = 44;

export async function runRangeTaperClassTests(): Promise<void> {
  // ── 1. The CAB rows, read through the driver's REAL display path (finding #8: the SERVED value) ────
  //      Cab Drive is the incident fixture (unit prints 5.00 at mid-scale; the shipped log map gave 0.316).
  //      The two nibble-4 rows are the controls: the unit agrees with the log map there.
  //      Tolerances follow the unit's own printed precision ("5.00"→0.005, "5000.1"→0.05, "10000"→0.5);
  //      Cab Drive's is widened to 0.01 because the 0.01 row-floor puts the correct linear decode at
  //      5.005 (a separate, out-of-scope bounds defect — review R18 finding 2) — the taper is what is tested.
  const cab = await servCabParams({ 33: MID_RAW, 55: 26079, 39: 55670 });

  const drive = cab.named.find((n) => n.id === 33);
  assert(drive !== undefined, 'CABINET/33 (Drive) must be SERVED for the cab block');
  const driveVal = drive.value;
  assert(driveVal !== null, 'CABINET/33 Drive must carry a served value');
  assert(
    Math.abs(driveVal - 5.0) <= 0.01,
    `CABINET/33 Drive at raw ${MID_RAW}: the driver SERVED ${driveVal}, which must match the unit's own ` +
      `5.00 (±0.01) — read through blockParams(), not local arithmetic`
  );
  // The divisor fact, asserted where it is actually used: the driver divides raw by 65534.
  const driveNorm = drive.norm;
  assert(
    driveNorm !== null && Math.abs(driveNorm - MID_NORM) < 1e-12,
    `CABINET/33 served norm must be raw/65534 = ${MID_NORM}, got ${driveNorm} ` +
      `(÷65535 would give ${MID_RAW / 65535})`
  );
  // The taper decision reaches the served record: a linear row carries no `log` flag.
  assertEqual(drive.log ?? false, false, 'CABINET/33 Drive is served LINEAR (no log flag) — the nibble-5 rule');

  // The power of the fixture, stated separately and explicitly: the LOG map of the SAME row at the SAME
  // raw was the 0.316 the owner saw on screen — so it is NOT the unit's number. A revert of the nibble
  // rule made blockParams() serve that log map and the value assertion above turned RED.
  //
  // MEASUREMENT UPDATE (2026-10-13): the SHIPPED row is no longer the generated one. The BOUNDS were wrong
  // too — the unit's own view-0x00 display is linear 0..10 (6.06 at norm 0.6064, below the generated row's
  // own minimum of 20) — so `forgefx-midi/src/gen3/fm3/rangeOverlay.ts` corrects CABINET/33 to 0..10. On
  // those bounds a base-10 log map is UNDEFINED (log(0)), which the last block asserts; the generated
  // bounds are kept here as named constants to preserve the fixture's original point (a log map gives
  // 0.316, never the unit's 5.00).
  const cabDriveGenerated = { displayMin: 0.01, displayMax: 10 } as const;
  const driveRow = (FM3_RANGES as Record<string, Record<number, RangeRow>>).CABINET?.[33];
  assert(driveRow !== undefined, 'CABINET/33 (Drive) must exist in the FM3 range table');
  const driveAsLog = wireToDisplay(MID_RAW, {
    displayMin: cabDriveGenerated.displayMin,
    displayMax: cabDriveGenerated.displayMax,
    displayScale: 'log10',
  });
  assert(
    Math.abs(driveAsLog - 5.0) > 0.01,
    `the LOG map of CABINET/33 at raw ${MID_RAW} must NOT be the unit's 5.00 (it is ${driveAsLog.toFixed(4)})`
  );
  assert(
    Math.abs(driveAsLog - 0.316) <= 0.002,
    `the log map of the same range must still be the wrong 0.316 (sanity on the fixture), got ${driveAsLog.toFixed(4)}`
  );
  // ... and the CORRECTED shipped row cannot be read as log at all: its floor is 0.
  let shippedLogThrew = false;
  try {
    wireToDisplay(MID_RAW, {
      displayMin: driveRow.displayMin,
      displayMax: driveRow.displayMax,
      displayScale: 'log10',
    });
  } catch {
    shippedLogThrew = true;
  }
  assert(
    driveRow.displayMin === 0 && driveRow.displayMax === 10 && shippedLogThrew,
    `the CORRECTED CABINET/33 row must be 0..10 with NO log10 map (log(0) undefined); got ` +
      `${driveRow.displayMin}..${driveRow.displayMax}, threw=${shippedLogThrew}`
  );

  // The nibble-4 controls: the unit MATCHES the log map, so they are value-asserted through the same path.
  const freq = cab.named.find((n) => n.id === 55);
  assert(freq !== undefined, 'CABINET/55 (Frequency) must be SERVED for the cab block');
  assert(
    freq.value !== null && Math.abs(freq.value - 5000.1) <= 0.05,
    `CABINET/55 Frequency must serve the unit's 5000.1 (±0.05), got ${freq.value}`
  );
  assertEqual(freq.log ?? false, true, 'CABINET/55 Frequency is served LOG (nibble-4 rule)');
  const highCut = cab.named.find((n) => n.id === 39);
  assert(highCut !== undefined, 'CABINET/39 (High Cut 1) must be SERVED for the cab block');
  assert(
    highCut.value !== null && Math.abs(highCut.value - 10000) <= 0.5,
    `CABINET/39 High Cut 1 must serve the unit's 10000 (±0.5), got ${highCut.value}`
  );
  assertEqual(highCut.log ?? false, true, 'CABINET/39 High Cut 1 is served LOG (nibble-4 rule)');

  // ── 2. The rest of the typecode-nibble-5 class: the DECISION, and an honest boundary ─────────────
  //      These six rows are the others the hardened audit caught (2026-10-13). The audit recorded the
  //      unit's own NUMBER for each, but NOT the raw it read them at — and this file records no raw for
  //      them either, so a SERVED value cannot be compared against them here without inventing one. They
  //      are therefore deliberately OUT of the value assertion (§1 covers the one row — Cab Drive — whose
  //      (raw, unit) pair this file does record). What IS asserted for the whole class is the taper
  //      DECISION, which is the correction's actual subject; a revert of the nibble rule turns these rows
  //      red via `rangeIsLog` below.
  //        CHORUS/20  Drive       unit 0.00
  //        FLANGER/20 Drive       unit 4.00
  //        FLANGER/26 Bass Focus  unit 0.00
  //        DELAY/22   Drive       unit 3.71
  //        DELAY/58   Resonance   unit 1.99
  //        REVERB/32  Drive       unit 0.00
  const caught: [string, number, string][] = [
    ['CHORUS', 20, 'Drive'],
    ['FLANGER', 20, 'Drive'],
    ['FLANGER', 26, 'Bass Focus'],
    ['DELAY', 22, 'Drive'],
    ['DELAY', 58, 'Resonance'],
    ['REVERB', 32, 'Drive'],
  ];
  for (const [family, pid, name] of caught) {
    const row = (FM3_RANGES as Record<string, Record<number, RangeRow>>)[family]?.[pid];
    assert(row !== undefined, `${family}/${pid} (${name}) must exist in the FM3 range table`);
    assertEqual((row.typecode ?? 0) >> 4 & 0xf, 5, `${family}/${pid} ${name} should be in the nibble-5 class`);
    assertEqual(rangeIsLog(row), false, `${family}/${pid} ${name} must not be log (device-confirmed)`);
  }

  // ── 3. The controls: nibble 4 IS log, and these matched the unit exactly ──────────────────────────
  for (const [family, pid, name] of [
    ['CABINET', 55, 'Frequency'],
    ['CABINET', 39, 'High Cut 1'],
  ] as [string, number, string][]) {
    const row = (FM3_RANGES as Record<string, Record<number, RangeRow>>)[family]?.[pid];
    assert(row !== undefined, `${family}/${pid} (${name}) must exist in the FM3 range table`);
    assertEqual((row.typecode ?? 0) >> 4 & 0xf, 4, `${family}/${pid} ${name} should be in the nibble-4 class`);
    assertEqual(rangeIsLog(row), true, `${family}/${pid} ${name} must stay log — the unit agrees on it`);
  }

  // ── 4. Explicit taper always wins over the heuristic — that is where a per-param fix belongs ──────
  assertEqual(
    rangeIsLog({ taper: 'linear', typecode: 0x241, displayMin: 1 }),
    false,
    'an explicit linear taper must override a log-looking typecode'
  );
  assertEqual(
    rangeIsLog({ taper: 'log', typecode: 0x52, displayMin: 0.01 }),
    true,
    'an explicit log taper must override a linear-looking typecode'
  );
  assertEqual(
    rangeIsLog({ taper: 'log', typecode: 0x241, displayMin: 0 }),
    false,
    'log is not applicable when the row can reach 0 (log(0) is undefined)'
  );

  // ── 5. A row with no typecode at all must decode linearly, not throw ─────────────────────────────
  assertEqual(rangeIsLog({ displayMin: 0.01 }), false, 'a row with no typecode decodes linearly');

  // ── 6. The measured class size. A count-shaped assertion must be exact: if the generated table moves,
  //       this test says so instead of the class quietly growing or shrinking. ─────────────────────────
  let nib4 = 0;
  let nib5 = 0;
  for (const family of Object.values(FM3_RANGES)) {
    for (const row of Object.values(family as Record<number, RangeRow>)) {
      const nib = ((row.typecode ?? 0) >> 4) & 0xf;
      if (row.taper) continue; // explicit taper: outside the heuristic's class
      if (nib === 4) nib4 += 1;
      else if (nib === 5) nib5 += 1;
    }
  }
  assertEqual(nib5, NIBBLE_5_PARAMS, 'the nibble-5 class size changed — re-audit before trusting the fix');
  assertEqual(nib4, NIBBLE_4_PARAMS, 'the nibble-4 class size changed — re-audit before trusting the fix');
  console.log(
    `  range-taper-class: Cab Drive served ${driveVal} at raw ${MID_RAW} (unit 5.00); 3 CAB rows read ` +
      `through blockParams(); ${caught.length} nibble-5 rows asserted DECISION-only (no recorded raw); ` +
      `class sizes ${nib4}/${nib5}`
  );
}
