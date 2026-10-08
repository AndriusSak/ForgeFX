// P14 — GLOBAL's CONTINUOUS SET wire value is in DISPLAY units, not the default 0..1 normalized
// fraction. The fact lives in the hand-maintained FM3 catalogue (forgefx-midi
// `FM3_DISPLAY_UNIT_FAMILIES`); the gen-3 driver honours it on the CONTINUOUS write path only, so
// the client's currency stays `norm ∈ [0,1]` while the wire carries the display value.
//
// MEASURED on a real FM3 (fw 13.0, 2026-10-08), the fn=0x1F bulk body as the panel oracle:
//   setParam(1, 7115, 70)   → panel 70%   (body[7115] = 45874 ≈ 0.700 · 65534)
//   setParam(1, 7115, 0.70) → panel 0.7%  (body[7115] = 459)   ← the ~100x-too-small bug
// So a marked param must be sent as its DISPLAY value; an unmarked family must stay BYTE-IDENTICAL.
//
// Mocked transport + the REAL static FM3 profile, NO hardware.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES } from '../../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import {
  createModernFractalCodec,
  packValue16,
  decode5SeptetFloat32,
} from 'forgefx-midi/gen3/axe-fx-iii';
import { FM3_DISPLAY_UNIT_FAMILIES } from 'forgefx-midi/gen3/fm3';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';
import type { NamedParam, DeviceEvent } from '../../src/drivers/types.js';

const FM3 = 0x11;
const AXE3 = 0x10; // a non-FM3 gen-3 device — must NOT get the marker
const GLOBAL_EID = 1; // virtual GLOBAL effect
const BRIGHTNESS_PID = 7115; // GLOBAL_FS_BRIGHTNESS, display range 0..100
const AMP_EID = effectRoster().find((e) => e.slug === 'amp')!.page; // DISTORT family
const AMP_STRIDE = PROFILES[FM3]!.rangeSections['DISTORT']!.stride;
const GLOBAL_BODY_LEN = 14880; // the eid-1 GLOBAL body length measured on the device

export const GEN3_GLOBAL_WIRE_UNITS_CASE_COUNT = 7;

const enc14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];
function sysex(model: number, fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, model, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}
/** fn=0x74/0x75/0x76 block-bulk-read reply carrying `values`. */
function burst(effectId: number, values: readonly number[]): number[][] {
  const head = sysex(FM3, 0x74, [...enc14(effectId), ...enc14(values.length), 0x07]);
  const body: number[] = [0x00, 0x02];
  for (const v of values) body.push(...packValue16(v));
  return [head, sysex(FM3, 0x75, body), sysex(FM3, 0x76, [])];
}
/** The float32 a continuous SET frame carries (sub 52 00, value at payload pos 12-16). */
const frameFloat = (f: readonly number[]): number =>
  decode5SeptetFloat32(f[12]!, f[13]!, f[14]!, f[15]!, f[16]!);
const frameSub = (f: readonly number[]): string => `${f[6]!.toString(16)} ${f[7]!.toString(16)}`;
const eq = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

function makeGen3(model = FM3, reply: (bytes: readonly number[]) => number[][] = () => []) {
  const mock = new MockTransport('serial', `mock-p14-${model}`);
  mock.isOpen = true;
  mock.reply = reply;
  const events: DeviceEvent[] = [];
  const driver = createGen3Driver(PROFILES[model]!, {
    transport: async () => mock,
    emit: (e) => events.push(e),
    getCadence: () => cadenceFor(model, 'balanced'),
  });
  return { driver, mock, events };
}

export async function runGen3GlobalWireUnitsTests(): Promise<void> {
  // Precondition: the catalogue fact this whole suite depends on is present.
  assert(FM3_DISPLAY_UNIT_FAMILIES.has('GLOBAL'), 'precondition: the FM3 catalogue marks GLOBAL as display-unit wire');

  // 1. MARKED: a GLOBAL continuous write of norm 0.7 carries the DISPLAY value 70, not 0.7.
  {
    const { driver, mock } = makeGen3();
    await driver.setParam(GLOBAL_EID, BRIGHTNESS_PID, 0.7, true);
    const f = mock.sent.at(-1)!;
    assertEqual(frameSub(f), '52 0', 'case 1: the write still rides the continuous sub-action (52 00)');
    assert(Math.abs(frameFloat(f) - 70) < 1e-3,
      `case 1: norm 0.7 → display 70 on the wire (range 0..100), got ${frameFloat(f)}`);
  }

  // 2. UNMARKED FAMILY IS BYTE-IDENTICAL: a DISTORT continuous write of 0.7 encodes exactly what the
  //    codec produces for (eid, pid, 0.7) — same bytes as before this change, float32 = 0.7.
  {
    const codec = createModernFractalCodec(FM3);
    const { driver, mock } = makeGen3();
    await driver.setParam(AMP_EID, 16, 0.7, true);
    const f = mock.sent.at(-1)!;
    assert(eq(f, codec.buildSetParameterContinuous(AMP_EID, 16, 0.7)),
      'case 2: an unmarked family sends the byte-identical pre-change frame');
    assert(Math.abs(frameFloat(f) - 0.7) < 1e-6,
      `case 2: an unmarked family carries the raw norm 0.7, got ${frameFloat(f)}`);
  }

  // 3. OTHER MODEL UNCHANGED: the marker is FM3-only. On an Axe-Fx III the same GLOBAL write stays a
  //    norm — the ~100x bug is not "fixed" onto a device it was never measured on.
  {
    const { driver, mock } = makeGen3(AXE3);
    await driver.setParam(GLOBAL_EID, BRIGHTNESS_PID, 0.7, true);
    assert(Math.abs(frameFloat(mock.sent.at(-1)!) - 0.7) < 1e-6,
      'case 3: a non-FM3 device keeps the default 0..1 wire');
  }

  // 4. TOTAL LOOKUP: a marked-family pid with no usable display range degrades to the default wire —
  //    never throws, never guesses. (7115 is the only kind with a 0..100 range; an arbitrary pid is not.)
  {
    const { driver, mock } = makeGen3();
    await driver.setParam(GLOBAL_EID, 9999, 0.7, true);
    assert(Math.abs(frameFloat(mock.sent.at(-1)!) - 0.7) < 1e-6,
      'case 4: an unmarked pid in a marked family falls back to the norm (total, no throw)');
  }

  // 5. DISCRETE PATH UNTOUCHED: an enum write still sends float32(ordinal) via sub 09 00, and emits
  //    no `param` (norm) event — the marker must not leak into the ordinal path.
  {
    const { driver, mock, events } = makeGen3();
    await driver.setParam(GLOBAL_EID, BRIGHTNESS_PID, 16, false);
    const f = mock.sent.at(-1)!;
    assertEqual(frameSub(f), '9 0', 'case 5: a discrete write keeps sub-action 09 00');
    assert(Math.abs(frameFloat(f) - 16) < 1e-6, 'case 5: a discrete write still carries float32(ordinal)');
    assertEqual(events.filter((e) => e.type === 'param').length, 0, 'case 5: a discrete write emits no norm event');
  }

  // 6. CLIENT CONTRACT PRESERVED: the `param` event for a MARKED continuous write still broadcasts the
  //    0..1 norm — the wire conversion is invisible to every other window (Axis applies e.norm verbatim).
  {
    const { driver, events } = makeGen3();
    await driver.setParam(GLOBAL_EID, BRIGHTNESS_PID, 0.7, true);
    const paramEvents = events.filter((e) => e.type === 'param');
    assertEqual(paramEvents.length, 1, 'case 6: a marked continuous write still broadcasts one param event');
    assert(Math.abs(paramEvents[0]!.norm - 0.7) < 1e-6,
      `case 6: the broadcast norm stays the client's 0..1 value, got ${paramEvents[0]!.norm}`);
  }

  // 7. ROUND-TRIP: write norm 0.7 → the frame carries display 70 → the device quantizes it to the raw
  //    16-bit the panel oracle recorded (45874 = 70% of 65534) → the READ path serves it back as the
  //    same display value 70 / norm 0.7. Write and read agree on the display value.
  {
    const { driver, mock } = makeGen3();
    await driver.setParam(GLOBAL_EID, BRIGHTNESS_PID, 0.7, true);
    const display = frameFloat(mock.sent.at(-1)!); // 70
    const raw = Math.round((display / 100) * 65534); // the device's own quantization
    assertEqual(raw, 45874, 'case 7: display 70 quantizes to the measured panel-oracle raw 45874');

    const gbody = Array.from({ length: GLOBAL_BODY_LEN }, (_, i) => (i % 250) + 1);
    gbody[BRIGHTNESS_PID] = raw;
    const readback = makeGen3(FM3, (req) => (req[5] === 0x1f ? burst(GLOBAL_EID, gbody) : []));
    const served = await readback.driver.blockParams(GLOBAL_EID);
    const bright = served.named.find((p: NamedParam) => p.id === BRIGHTNESS_PID);
    assert(!!bright && typeof bright.value === 'number',
      'case 7: the written GLOBAL brightness reads back as a resolved number');
    assert(Math.abs((bright as NamedParam).value - 70) < 0.02,
      `case 7: read-back display value matches the write (≈70), got ${bright!.value}`);
    assert(Math.abs((bright as NamedParam).norm! - 0.7) < 1e-3,
      `case 7: read-back norm matches the original norm (0.7), got ${(bright as NamedParam).norm}`);
  }
}
