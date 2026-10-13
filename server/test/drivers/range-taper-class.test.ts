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
// instrument is linear there (0.00 at raw 0 on the unit's screen, 5.00 at mid-scale for Cab Drive).
//
// WHAT THIS SUITE ASSERTS (review R18 finding #8 hardened this): the SERVED VALUE, not local arithmetic.
// Every value below is computed through the codec's own `wireToDisplay` (the exact helper gen3.ts #display
// calls) with the taper that the driver's own `rangeIsLog` selects — so a regression that flips the
// decision moves the served side and this file goes red. It no longer re-implements the map inline, and the
// raw↔norm divisor is the driver's real 65534 (not 65535).
//
// Every typecode-0x52 param the audit could read disagreed with the unit: CABINET/33 Drive (0.316 vs 5.00),
// CHORUS/20 Drive, FLANGER/20 Drive, FLANGER/26 Bass Focus, DELAY/22 Drive, DELAY/58 Resonance, REVERB/32
// Drive. Those are the fixtures below. Real table data, real device numbers, no hardware needed.

import { rangeIsLog } from '../../src/drivers/gen3.js';
import { wireToDisplay } from 'forgefx-midi/shared';
import { FM3_RANGES } from 'forgefx-midi/gen3/fm3';
import { assert, assertEqual } from '../helpers/mock.js';

/** raw 32768 is exactly mid-scale (the unit's own reading was taken at this byte). */
const MID_RAW = 32768;
/** The driver normalises with /65534, NOT /65535: gen3.ts `#display` (`clamp01(raw / 65534)`) and
 *  `decodeEditBurst` (`clamp01((cur[id] ?? 0) / 65534)`) both divide by 65534. Keep this in lockstep with
 *  those, or the fixture's `norm` describes a wire value the server never computes. */
const RAW_MAX = 65534;
/** Normalised wire value, matching what the server serves as `norm`: 32768/65534 = 0.500015… (the earlier
 *  34266/65535 comment described a different fixture's raw and the wrong divisor). */
const MID_NORM = MID_RAW / RAW_MAX;

/** The driver's own rounding for a served display value (gen3.ts `round3`). */
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Minimal shape of an FM3 range row the value map needs. */
interface RangeRow {
  displayMin: number;
  displayMax: number;
  typecode?: number;
  taper?: string;
}

/**
 * The SERVED value, computed through the codec's own `wireToDisplay` — the exact helper gen3.ts `#display`
 * calls — with the taper the driver's own `rangeIsLog` picks, rounded the way the driver rounds it.
 * This is deliberately NOT local arithmetic: if the decision or the divisor regresses, the served side moves.
 */
function served(raw: number, row: RangeRow): number {
  const scale = rangeIsLog(row) ? 'log10' : 'linear';
  return round3(wireToDisplay(raw, { displayMin: row.displayMin, displayMax: row.displayMax, displayScale: scale }));
}

/** A row pinned to a device reading the unit itself printed, at the raw it held. */
interface ValueFixture {
  family: string;
  pid: number;
  name: string;
  raw: number;
  /** the unit's own display string, as a number */
  unit: number;
  /** half the last digit the unit printed (scripts/audit-taper-vs-device.ts tolerance rule) */
  tol: number;
}

/** The typecode-nibble class size the correction was measured against. */
const NIBBLE_5_PARAMS = 17;
const NIBBLE_4_PARAMS = 274;

/** Assertions this suite makes when every row it names is present (the registration prints this). */
export const RANGE_TAPER_CLASS_CASE_COUNT = 52;

export function runRangeTaperClassTests(): void {
  // ── 1. Device readings, asserted through the SERVED value (finding #8: no local arithmetic) ────────
  //      Cab Drive is the incident fixture (unit prints 5.00 at mid-scale; the shipped log map gave 0.316).
  //      The two nibble-4 rows are the controls: the unit agrees with the log map there.
  //      Tolerances follow the unit's own printed precision ("5.00"→0.005, "5000.1"→0.05, "10000"→0.5);
  //      Cab Drive's is widened to 0.01 because the 0.01 row-floor puts the correct linear decode at
  //      5.005 (a separate, out-of-scope bounds defect — review R18 finding 2) — the taper is what is tested.
  const valueFixtures: ValueFixture[] = [
    { family: 'CABINET', pid: 33, name: 'Drive', raw: MID_RAW, unit: 5.0, tol: 0.01 },
    { family: 'CABINET', pid: 55, name: 'Frequency', raw: 26079, unit: 5000.1, tol: 0.05 },
    { family: 'CABINET', pid: 39, name: 'High Cut 1', raw: 55670, unit: 10000, tol: 0.5 },
  ];
  for (const fx of valueFixtures) {
    const row = (FM3_RANGES as Record<string, Record<number, RangeRow>>)[fx.family]?.[fx.pid];
    assert(row !== undefined, `${fx.family}/${fx.pid} (${fx.name}) must exist in the FM3 range table`);
    const got = served(fx.raw, row);
    assert(
      Math.abs(got - fx.unit) <= fx.tol,
      `${fx.family}/${fx.pid} ${fx.name} at raw ${fx.raw}: SERVED ${got} must match the unit's own ` +
        `${fx.unit} (±${fx.tol}) — computed via wireToDisplay, not local arithmetic`
    );
  }

  // The Cab Drive fixture's power: the log map of the SAME row is the 0.316 the owner saw on screen. If
  // this ever stops differing from 5.00, the fixture has lost its power.
  const drive = (FM3_RANGES as Record<string, Record<number, RangeRow>>).CABINET?.[33];
  assert(drive !== undefined, 'CABINET/33 (Drive) must exist in the FM3 range table');
  assertEqual(rangeIsLog(drive), false, 'CABINET/33 Drive must NOT be log — the unit is linear there');
  assertEqual((drive.typecode ?? 0) >> 4 & 0xf, 5, 'the fixture is only meaningful while Drive keeps nibble 5');
  const driveAsLog = round3(
    wireToDisplay(MID_RAW, { displayMin: drive.displayMin, displayMax: drive.displayMax, displayScale: 'log10' })
  );
  assert(
    Math.abs(driveAsLog - 0.316) <= 0.002,
    `the log map of the same range must still be the wrong 0.316 (sanity on the fixture), got ${driveAsLog.toFixed(4)}`
  );

  // ── 2. Every other param the audit caught: the DECISION *and* the SERVED VALUE it yields ────────────
  //      Each row also carries the unit's reading from the hardened audit (2026-10-13). Only Cab Drive's
  //      served value reproduces its device number today; the other six still MISMATCH on VALUE for a
  //      bounds defect outside this test's scope (finding #2 — e.g. Chorus/Delay Drive carry a log-shaped
  //      0.5..500 bound). So for the whole class we pin the TAPE's job: at mid-scale the served value must
  //      be the LINEAR map (through the real helper), never the log map the {4,5} heuristic produced.
  //        CHORUS/20  Drive       unit 0.00   (ours 0.5    — floor)
  //        FLANGER/20 Drive       unit 4.00   (ours 20.049 at audit time)
  //        FLANGER/26 Bass Focus  unit 0.00   (ours 200    — floor)
  //        DELAY/22   Drive       unit 3.71   (ours 185.974 at audit time)
  //        DELAY/58   Resonance   unit 1.99   (ours 41.395 at audit time)
  //        REVERB/32  Drive       unit 0.00   (ours 0.1    — floor)
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
    const row = (FM3_RANGES as Record<string, Record<number, RangeRow>>)[family]?.[pid];
    assert(row !== undefined, `${family}/${pid} (${name}) must exist in the FM3 range table`);
    assertEqual((row.typecode ?? 0) >> 4 & 0xf, 5, `${family}/${pid} ${name} should be in the nibble-5 class`);
    assertEqual(rangeIsLog(row), false, `${family}/${pid} ${name} must not be log (device-confirmed)`);
    // The served value through the codec's own helper, with the driver's own decision, must be the LINEAR
    // map at raw 0..65534. A revert to {4,5} moves this to the log map and turns the row red.
    const got = served(MID_RAW, row);
    const expectLinear = round3(
      wireToDisplay(MID_RAW, { displayMin: row.displayMin, displayMax: row.displayMax, displayScale: 'linear' })
    );
    assertEqual(
      got,
      expectLinear,
      `${family}/${pid} ${name}: the SERVED value at raw ${MID_RAW} must be the linear map (${expectLinear}), got ${got}`
    );
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
  // Their served values (section 1) are the unit readings; a sanity check that the log map stays in bounds.
  const freq = (FM3_RANGES as Record<string, Record<number, RangeRow>>).CABINET?.[55];
  assert(freq !== undefined, 'CABINET/55 (Frequency) must exist in the FM3 range table');
  const freqMid = served(MID_RAW, freq);
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
    `  range-taper-class: ${caught.length} device-confirmed nibble-5 params, 2 nibble-4 controls, ` +
      `class sizes ${nib4}/${nib5}`
  );
}
