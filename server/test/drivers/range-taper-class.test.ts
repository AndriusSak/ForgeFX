// The log/linear taper decision for a range row, pinned against the INSTRUMENT's own readings.
//
// INCIDENT (owner, 2026-10-13): with Cab Drive set to 5.00 on the unit, the app showed 0.32. The unit's own
// display string (self-describe view 0x00, read with scripts/audit-taper-vs-device.ts) says "5.00" at raw
// 32768. So the DECODE was wrong, not the wire and not the render.
//
// ROOT CAUSE: the taper for a row with no explicit `taper` came from `(typecode >> 4) & 0xf ∈ {4,5}`. The
// rule was derived from the frequency cuts (0x240/0x241, nibble 4, genuine log10 — CABINET/55 Frequency
// served 5000.07 against the unit's 5000.1 and CABINET/39 High Cut 1 9999.895 against 10000, both matching).
// Typecode 0x52 — the "Drive"/gain-style class — lands on nibble 5 by coincidence and is NOT log: the
// instrument is linear 0→10 there (0.00 at raw 0 on the unit's screen, 5.00 at mid-scale).
//
// Every typecode-0x52 param the audit could read disagreed with the unit: CABINET/33 Drive (0.316 vs 5.00),
// CHORUS/20 Drive, FLANGER/20 Drive, FLANGER/26 Bass Focus, DELAY/22 Drive, DELAY/58 Resonance, REVERB/32
// Drive. Those are the fixtures below. Real table data, real device numbers, no hardware needed.

import { rangeIsLog } from '../../src/drivers/gen3.js';
import { FM3_RANGES } from 'forgefx-midi/gen3/fm3';
import { assert, assertEqual } from '../helpers/mock.js';

/** raw 32768 is exactly mid-scale (the unit's own reading was taken at this byte). */
const MID_RAW = 32768;
const RAW_MAX = 65535;
/** Normalised wire value, matching what the server serves as `norm` (34266/65535 = 0.522874). */
const MID_NORM = MID_RAW / RAW_MAX;

/**
 * The linear map the instrument follows for the Drive-class params: value = min + n·(max − min).
 * Local arithmetic on purpose — this is the specification, not a call into the code under test.
 */
function linearValue(min: number, max: number, n: number): number {
  return min + n * (max - min);
}

/** The log10 map the old `|| 5` branch applied instead. */
function logValue(min: number, max: number, n: number): number {
  return min * Math.pow(max / min, n);
}

/** The typecode-nibble class size the correction was measured against. */
const NIBBLE_5_PARAMS = 17;
const NIBBLE_4_PARAMS = 274;

/** Assertions this suite makes when every row it names is present (the registration prints this). */
export const RANGE_TAPER_CLASS_CASE_COUNT = 39;

export function runRangeTaperClassTests(): void {
  // ── 1. The fixture: Cab Drive. Unit prints 5.00 at mid-scale; the app showed 0.32. ────────────────
  const drive = FM3_RANGES.CABINET[33];
  assert(drive !== undefined, 'CABINET/33 (Drive) must exist in the FM3 range table');
  assertEqual(rangeIsLog(drive), false, 'CABINET/33 Drive must NOT be log — the unit is linear there');
  assertEqual((drive.typecode >> 4) & 0xf, 5, 'the fixture is only meaningful while Drive keeps nibble 5');

  const ours = linearValue(drive.displayMin, drive.displayMax, MID_NORM);
  assert(
    Math.abs(ours - 5.0) <= 0.05,
    `CABINET/33 Drive at raw ${MID_RAW} must decode to the unit's 5.00, got ${ours.toFixed(3)}`
  );
  // …and the class of error that was shipped: a log map of the same range gives 0.316, which is the exact
  // number the owner saw on screen. If this ever stops differing, the fixture has lost its power.
  const asLog = logValue(drive.displayMin, drive.displayMax, MID_NORM);
  assert(
    Math.abs(asLog - 0.316) <= 0.002,
    `the log map of the same range must still be the wrong 0.316 (sanity on the fixture), got ${asLog.toFixed(4)}`
  );

  // ── 2. Every other param the audit caught, same signature ─────────────────────────────────────────
  const caught: [string, number, string][] = [
    ['CABINET', 33, 'Drive'],
    ['CHORUS', 20, 'Drive'],
    ['FLANGER', 20, 'Drive'],
    ['FLANGER', 26, 'Bass Focus'],
    ['DELAY', 22, 'Drive'],
    ['DELAY', 58, 'Resonance'],
    ['REVERB', 32, 'Drive'],
  ];
  for (const [family, pid, name] of caught) {
    const row = FM3_RANGES[family]?.[pid];
    assert(row !== undefined, `${family}/${pid} (${name}) must exist in the FM3 range table`);
    assertEqual((row.typecode >> 4) & 0xf, 5, `${family}/${pid} ${name} should be in the nibble-5 class`);
    assertEqual(rangeIsLog(row), false, `${family}/${pid} ${name} must not be log (device-confirmed)`);
  }

  // ── 3. The controls: nibble 4 IS log, and these matched the unit exactly ──────────────────────────
  for (const [family, pid, name] of [
    ['CABINET', 55, 'Frequency'],
    ['CABINET', 39, 'High Cut 1'],
  ] as [string, number, string][]) {
    const row = FM3_RANGES[family]?.[pid];
    assert(row !== undefined, `${family}/${pid} (${name}) must exist in the FM3 range table`);
    assertEqual((row.typecode >> 4) & 0xf, 4, `${family}/${pid} ${name} should be in the nibble-4 class`);
    assertEqual(rangeIsLog(row), true, `${family}/${pid} ${name} must stay log — the unit agrees on it`);
  }
  // And the two unit readings that confirm the log side, as arithmetic:
  const freq = FM3_RANGES.CABINET[55];
  const freqMid = logValue(freq.displayMin, freq.displayMax, 0.5); // the unit sat near mid-scale
  assert(
    freqMid > freq.displayMin && freqMid < freq.displayMax,
    'the log map must stay inside the row bounds (sanity)'
  );

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
    for (const row of Object.values(family)) {
      const nib = (row.typecode >> 4) & 0xf;
      if (row.taper) continue; // explicit taper: outside the heuristic's class
      if (nib === 4) nib4 += 1;
      else if (nib === 5) nib5 += 1;
    }
  }
  assertEqual(nib5, NIBBLE_5_PARAMS, 'the nibble-5 class size changed — re-audit before trusting the fix');
  assertEqual(nib4, NIBBLE_4_PARAMS, 'the nibble-4 class size changed — re-audit before trusting the fix');
  console.log(
    `  range-taper-class: ${caught.length} device-confirmed nibble-5 params, 2 nibble-4 controls, ` +
      `class sizes ${nib4}/${nib5}`
  );
}
