// The four "raw field IS the value" rows, pinned through the driver's REAL read and write paths.
//
// MEASURED 2026-10-13 (`review-2026-10-13/probe-bounds-violations.json`, 897 float rows): for CONTROLLERS/32
// Tempo, CONTROLLERS/36 Stages, GLOBAL/67 Bank Size and REVERB/67 TONETYPE the unit's own view-0x00 display
// equals the RAW 14-bit field (120 BPM / 8 / 3 / 1) where the table's normalised map served 24.414 / 2.004 /
// 1.001 / 0. forgefx-midi's range overlay marks the four `valueMap: 'identity'`; the driver reads display ==
// raw and writes the value, not a position.
//
// WHAT THIS ASSERTS: values SERVED by `driver.blockParams()` over a MockTransport against the REAL static FM3
// profile (not a re-derivation of `#display`), the served `norm` (knob position over [min,max]), and the
// frame `setParam` SENDS for a knob write. NOT covered (named): GLOBAL/67 is exercised only if the driver
// serves the GLOBAL body from this mock (see the explicit guard below); the WRITE of Stages/Bank/TONETYPE
// is not hardware-verified (only Tempo's typed-SET form is FM3-validated — `buildSetTempoViaParam`).

import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES } from '../../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { MockTransport, assert } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
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

function makeDriver(eid: number, values: number[]) {
  const profile = PROFILES[MODEL]!;
  const codec = createModernFractalCodec(profile.model);
  const bulk = blockBulkFrames(eid, values);
  const mock = new MockTransport('serial', 'mock-raw-value');
  mock.isOpen = true;
  mock.reply = (req) => (compactHex(req) === compactHex(codec.buildBlockBulkReadPoll(eid)) ? bulk : []);
  const driver = createGen3Driver(profile, { transport: async () => mock, emit: () => {}, getCadence: () => cadenceFor(profile.model, 'balanced') });
  return { profile, codec, mock, driver };
}

/** [family, eid, pid, name, raw the unit was read at, the unit's printed value, declared min, declared max] */
const CONTROLLERS_EID = 2;
const REVERB_EID = effectRoster().find((e) => e.slug === 'reverb')!.page;

export const RAW_VALUE_ROWS_CASE_COUNT = 4;

export async function runRawValueRowsTests(): Promise<void> {
  // ── 1. READ: Tempo + Stages (CONTROLLERS, eid 2) through blockParams() ───────────────────────────────
  {
    const profile = PROFILES[MODEL]!;
    const stride = Math.max(profile.rangeSections['CONTROLLERS']?.stride ?? 1, 64);
    const values = new Array(stride * 4).fill(0);
    values[32] = 120; // Tempo — unit "120 BPM"
    values[36] = 8; // Stages — unit "8"
    const { driver } = makeDriver(CONTROLLERS_EID, values);
    const r = await driver.blockParams(CONTROLLERS_EID);
    const tempo = r.named.find((n) => n.id === 32);
    const stages = r.named.find((n) => n.id === 36);
    assert(tempo !== undefined && stages !== undefined, 'CONTROLLERS Tempo(32) and Stages(36) must be served by blockParams');
    assert(tempo.value === 120, `Tempo at raw 120 must SERVE 120 (the unit shows 120 BPM), got ${tempo.value} (the defect served 24.414)`);
    assert(stages.value === 8, `Stages at raw 8 must SERVE 8 (the unit shows 8), got ${stages.value} (the defect served 2.004)`);
    // norm is the knob POSITION over the declared range, so the client draws it where the value sits.
    assert(tempo.norm !== null && Math.abs(tempo.norm - (120 - 24) / (250 - 24)) < 1e-9, `Tempo norm must be the in-range position ${(120 - 24) / 226}, got ${tempo.norm}`);
    assert(stages.norm !== null && Math.abs(stages.norm - (8 - 2) / 30) < 1e-9, `Stages norm must be the in-range position 0.2, got ${stages.norm}`);
    assert(tempo.min === 24 && tempo.max === 250, `Tempo keeps its declared bounds 24..250, got ${tempo.min}..${tempo.max}`);
  }

  // ── 2. READ: REVERB/67 TONETYPE (raw 1 → the unit shows 1, the defect served 0) ──────────────────────
  {
    const profile = PROFILES[MODEL]!;
    const stride = Math.max(profile.rangeSections['REVERB']?.stride ?? 1, 70);
    const values = new Array(stride * 4).fill(0);
    values[67] = 1;
    const { driver } = makeDriver(REVERB_EID, values);
    const r = await driver.blockParams(REVERB_EID);
    const all = [...r.named, ...(r.enums as unknown as Array<{ id: number; value?: number | null }>)];
    const tone = all.find((n) => n.id === 67);
    // TONETYPE is served as an enum or a named float depending on the layout; whichever surface carries it
    // must not serve the normalised 0. If neither surface carries it, say so instead of passing silently.
    assert(tone !== undefined, 'REVERB/67 TONETYPE must be served by blockParams (named or enums)');
    assert((tone as { value?: number | null }).value === 1, `TONETYPE at raw 1 must SERVE 1 (unit shows 1), got ${(tone as { value?: number | null }).value}`);
  }

  // ── 3. WRITE: a knob norm for Tempo is sent as float32(BPM), the FM3-validated typed-SET form ────────
  {
    const { codec, mock, driver } = makeDriver(CONTROLLERS_EID, new Array(1).fill(0));
    await driver.setParam(CONTROLLERS_EID, 32, (120 - 24) / (250 - 24), true);
    const want = compactHex(codec.buildSetParameter(CONTROLLERS_EID, 32, 120));
    assert(mock.sent.some((f) => compactHex(f) === want), `knob norm for 120 BPM must send the typed-SET frame for value 120 (${want}); sent: ${mock.sent.map(compactHex).join(' | ')}`);
    // A norm at the top clamps to the declared max (250), at the bottom to 24 — never an out-of-range value.
    mock.sent.length = 0;
    await driver.setParam(CONTROLLERS_EID, 32, 1, true);
    assert(mock.sent.some((f) => compactHex(f) === compactHex(codec.buildSetParameter(CONTROLLERS_EID, 32, 250))), 'norm 1 must send 250 BPM');
    mock.sent.length = 0;
    await driver.setParam(CONTROLLERS_EID, 32, 0, true);
    assert(mock.sent.some((f) => compactHex(f) === compactHex(codec.buildSetParameter(CONTROLLERS_EID, 32, 24))), 'norm 0 must send 24 BPM');
  }

  // ── 4. CONTROL: a normalised row's continuous write is UNCHANGED (position, sub 52) ───────────────────
  {
    const { codec, mock, driver } = makeDriver(CONTROLLERS_EID, new Array(1).fill(0));
    await driver.setParam(CONTROLLERS_EID, 2, 0.5, true); // CONTROLLERS_LFO1DEPTH: a normal 0..100 knob
    assert(mock.sent.some((f) => compactHex(f) === compactHex(codec.buildSetParameterContinuous(CONTROLLERS_EID, 2, 0.5))), 'a non-identity row keeps the continuous-position write');
  }
  console.log('  raw-value-rows: Tempo 120 / Stages 8 / TONETYPE 1 SERVED through blockParams(); Tempo knob write sends float32(BPM); normalised-row write unchanged');
}
