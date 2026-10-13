// A MEASURED range correction must be the FINAL authority over a device-cache row.
//
// INCIDENT (measured end-to-end 2026-10-13, not a theory). forgefx-midi gained an in-repo overlay
// (`src/gen3/fm3/rangeOverlay.ts`, commit 3a27af5) correcting the display bounds of the typecode-0x52
// class (17 rows) — the unit's own view-0x00 display reads LINEAR 0..10 where the generated rows carry
// the raw definition record (WAH/3 `20..200`, FLANGER/26 `200..20000`). `forgefx-midi` applies that
// overlay at its FM3 index export, so the STATIC profile (`FM3_RANGES`) is corrected.
//
// But `ForgeFX/server/src/devices.ts` `runtimeProfileFrom()` merges the device CACHE's rows OVER the
// static ones ("device-true wins"). A cache captured from the SAME wrong record re-supplies the OLD
// bounds and WINS — so the correction never reaches the served value. Measured against the real
// `11_13p0` cache (built 2026-10-12T19:50Z, source "live"): WAH/3 carried `20..200` and FLANGER/26
// `200..20000`, so a full rebuild + restart still served WAH/3 Resonance Q 129.15 where the unit shows
// 6.06, and FLANGER/26 Bass Focus 20000 where the unit reads 10.00 at the knob's maximum.
//
// THE RULE (general): a MEASURED correction beats BOTH the static table AND a device cache built from
// the same wrong record, because it is the only one checked against the instrument. `runtimeProfileFrom`
// therefore re-applies the codec's overlay as the LAST step, after the cache merge.
//
// NO CACHE REBUILD IS THE FIX: a full-mode cache capture WRITES to the unit and on 2026-10-12 damaged
// the owner's per-preset switch block. The overlay-wins rule removes the need to invalidate anything.
//
// Mocked transport only — no hardware. The served value is read through the driver's REAL path
// (`blockParams()` over a MockTransport against the runtime profile), not a local re-derivation.
import { PROFILES, runtimeProfileFrom } from '../../src/devices.js';
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import type { BuiltCache } from 'forgefx-midi/cache';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
const WAH_EID = effectRoster().find((e) => e.slug === 'wah')!.page; // 94
const FLANGER_EID = effectRoster().find((e) => e.slug === 'flanger')!.page; // 82

/** raw 32768 is exactly mid-scale; the driver normalises with /65534 (gen3.ts `#display`). */
const MID_RAW = 32768;
const RAW_MAX = 65534;
const MID_NORM = MID_RAW / RAW_MAX; // 0.500015259…

/**
 * A minimal BuiltCache carrying ONLY a `ranges` override (the merge under test) and the meta a real
 * `11_13p0` cache carried. `ranges` values are the OLD (wrong) bounds the incident cache held.
 */
function cacheWithOldBounds(): BuiltCache {
  return {
    model: MODEL,
    firmware: '13.0',
    // WAH/3 and FLANGER/26 are OVERLAY rows (corrected source bounds 0..10); the incident cache
    // carried the wrong generated bounds. WAH/1 is NOT an overlay row — the cache must still win there.
    ranges: {
      WAH: {
        1: { kind: 'float', displayMin: 111, displayMax: 222, scale: 1, step: 0, typecode: 576 },
        3: { kind: 'float', displayMin: 20, displayMax: 200, scale: 10, step: 0, typecode: 82 },
      },
      FLANGER: {
        26: { kind: 'float', displayMin: 200, displayMax: 20000, scale: 10, step: 0.001, typecode: 82 },
      },
    },
    rangeSections: {},
    enumOverrides: {},
    rosters: {},
    cabIrs: {},
    unmappedSections: [],
    unmappedFamilies: [],
    meta: { recordCount: 2581, source: 'live', builtAt: '2026-10-12T19:50:18.387Z' },
  } as unknown as BuiltCache;
}

/** Build the runtime profile the server would serve: static FM3 profile + the incident cache. */
function runtimeFm3Profile() {
  return runtimeProfileFrom(cacheWithOldBounds(), PROFILES[MODEL]!);
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
function blockBulkFrames(eid: number, values: readonly number[]): number[][] {
  const body: number[] = [0x00, 0x02];
  for (const v of values) body.push(...packValue16(v));
  return [sysex(0x74, [...enc14(eid), ...enc14(values.length), 0x07]), sysex(0x75, body), sysex(0x76, [])];
}

/**
 * Read one block through the REAL gen-3 driver over a runtime profile built from the incident cache.
 * `overrides` sets the raw wire value for specific paramIds so the SERVED value can be asserted.
 */
async function servBlock(profile: ReturnType<typeof runtimeFm3Profile>, eid: number, family: string, overrides: Record<number, number>) {
  const stride = profile.rangeSections[family]?.stride ?? 1;
  const values = new Array(Math.max(stride, 1) * 4).fill(0);
  for (const [pid, raw] of Object.entries(overrides)) values[Number(pid)] = raw;
  const bulk = blockBulkFrames(eid, values);
  const codec = createModernFractalCodec(profile.model);
  const mock = new MockTransport('serial', 'mock-measured-overlay');
  mock.isOpen = true;
  mock.reply = (req) => (compactHex(req) === compactHex(codec.buildBlockBulkReadPoll(eid)) ? bulk : []);
  const driver = createGen3Driver(profile, {
    transport: async () => mock,
    emit: () => {},
    getCadence: () => cadenceFor(profile.model, 'balanced'),
  });
  return driver.blockParams(eid);
}

/** Assertions this suite makes when every row it names is present (the registration prints this). */
export const MEASURED_OVERLAY_WINS_CASE_COUNT = 3;

export async function runMeasuredOverlayWinsTests(): Promise<void> {
  // ── 1. The MERGE: an overlay row corrected by the codec, but re-supplied with the OLD bounds by
  //        the cache, must still serve the CORRECTED bounds. And the cache must STILL win for a
  //        non-overlay row — so this is the overlay-wins rule, not a cache-disable stub.
  //        FAILS BEFORE: `mergedRanges` kept the cache's `20..200` for WAH/3 (both assertions below red).
  {
    const runtime = runtimeFm3Profile();

    const overlayRow = runtime.ranges.WAH?.[3];
    assert(overlayRow !== undefined, 'case 1: WAH/3 must be present in the merged runtime ranges');
    assertEqual(overlayRow.displayMin, 0,
      `case 1: the cache carried WAH/3 displayMin 20 but the MEASURED overlay corrects it to 0 — got ${overlayRow.displayMin}`);
    assertEqual(overlayRow.displayMax, 10,
      `case 1: the cache carried WAH/3 displayMax 200 but the MEASURED overlay corrects it to 10 — got ${overlayRow.displayMax}`);

    // The cache must still be authoritative for a row the overlay does NOT name.
    const cacheRow = runtime.ranges.WAH?.[1];
    assert(cacheRow !== undefined, 'case 1: WAH/1 must be present in the merged runtime ranges');
    assertEqual(cacheRow.displayMin, 111,
      `case 1 (control): the cache still wins for a NON-overlay row (WAH/1) — got displayMin ${cacheRow.displayMin}`);
    assertEqual(cacheRow.displayMax, 222,
      `case 1 (control): the cache still wins for a NON-overlay row (WAH/1) — got displayMax ${cacheRow.displayMax}`);

    // And the other overlay row in a second family, through the same merge.
    const flangerRow = runtime.ranges.FLANGER?.[26];
    assert(flangerRow !== undefined, 'case 1: FLANGER/26 must be present in the merged runtime ranges');
    assertEqual(flangerRow.displayMin, 0,
      `case 1: FLANGER/26 cache was 200..20000; the overlay corrects displayMin to 0 — got ${flangerRow.displayMin}`);
    assertEqual(flangerRow.displayMax, 10,
      `case 1: FLANGER/26 cache was 200..20000; the overlay corrects displayMax to 10 — got ${flangerRow.displayMax}`);
  }

  // ── 2. The SERVED value, read through the driver's REAL path (review finding #8). The unit's own
  //        view-0x00 display is 10 × norm on the corrected 0..10 row, so raw 32768 (norm 0.50001525)
  //        must SERVE ≈ 5.00015. FAILS BEFORE: the cache's 20..200 (linear) served 20 + 0.5×180 ≈ 110.0.
  {
    const runtime = runtimeFm3Profile();
    const wah = await servBlock(runtime, WAH_EID, 'WAH', { 3: MID_RAW });
    const q = wah.named.find((n) => n.id === 3);
    assert(q !== undefined, 'case 2: WAH/3 (Resonance Q) must be SERVED for the wah block');
    // The divisor fact, straight off the served record: norm = raw/65534, not raw/65535.
    assert(q.norm !== null && Math.abs(q.norm - MID_NORM) < 1e-12,
      `case 2: WAH/3 served norm must be raw/65534 = ${MID_NORM}, got ${q.norm} (÷65535 → ${MID_RAW / 65535})`);
    assert(q.value !== null && Math.abs(q.value - 5.00015) <= 0.01,
      `case 2: WAH/3 Resonance Q at raw ${MID_RAW} must SERVE ≈5.0 (10 × ${MID_NORM.toFixed(8)}) — ` +
        `the unit's own 0..10 reading — but the driver served ${q.value}. The OLD cache row (20..200) ` +
        `served 20 + norm×180 ≈ 110.0.`);
    // The corrected bounds reached the SERVED record, and the taper is linear (no `log` flag).
    assertEqual(q.min, 0, `case 2: WAH/3 served min must be the corrected 0, got ${q.min}`);
    assertEqual(q.max, 10, `case 2: WAH/3 served max must be the corrected 10, got ${q.max}`);
    assertEqual(q.log ?? false, false, 'case 2: WAH/3 (typecode 0x52) is served LINEAR, not log');
  }

  // ── 3. FLANGER/26 Bass Focus at the knob's MAXIMUM (raw 65534, norm 1.0): the unit reads 10.00; the
  //        OLD cache row `200..20000` served 20000. FAILS BEFORE: served 20000, not 10.
  {
    const runtime = runtimeFm3Profile();
    const flanger = await servBlock(runtime, FLANGER_EID, 'FLANGER', { 26: RAW_MAX });
    const focus = flanger.named.find((n) => n.id === 26);
    assert(focus !== undefined, 'case 3: FLANGER/26 (Bass Focus) must be SERVED for the flanger block');
    assert(focus.value !== null && Math.abs(focus.value - 10) <= 0.01,
      `case 3: FLANGER/26 Bass Focus at raw ${RAW_MAX} must SERVE ≈10.00 (the unit's reading at the ` +
        `knob's maximum) — the OLD cache row 200..20000 served 20000; the driver served ${focus.value}`);
    assertEqual(focus.max, 10, `case 3: FLANGER/26 served max must be the corrected 10, got ${focus.max}`);
  }
}
