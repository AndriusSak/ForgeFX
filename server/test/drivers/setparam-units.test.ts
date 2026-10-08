// UNITS ARE PER-OPCODE — the guard against re-introducing a scale conversion on the write path.
//
// WHY THIS EXISTS. On 2026-10-08 a change (P14) taught the driver to convert a normalized value to
// DISPLAY units for the GLOBAL family before sending. It was based on a diagnostic that called
// `setParam(eid, pid, 0.40)` WITHOUT the `continuous` argument — which is REQUIRED and has no default,
// so the call silently took the DISCRETE branch (percent) and set 0.4%. The premise was false, the
// change shipped, and it broke every knob write: the driver sent 40 where the device expected 0.4, and
// the FM3 clamped to 100%. It was caught by the live unit and reverted (ForgeFX 1b380d3).
//
// MEASURED on a real FM3 by sending raw floats straight to the codec and reading the fn-0x1F body:
//
//   opcode        sent     body[7115]   unit
//   ────────────────────────────────────────────────────────────────────────────
//   continuous    0.25     25.0%        NORMALIZED 0..1     <- what Axis's knobs send
//   continuous    40       100.0%       (clamped; 40 >> 1.0)
//   discrete      0.25     0.3%         PERCENT 0..100
//   discrete      40       40.0%        PERCENT 0..100
//
// So the driver must pass the caller's value through UNCHANGED in both branches — the units belong to
// the opcode the caller chose, and the client's currency is the normalized 0..1 for continuous writes
// (Axis `ControlSurface.svelte:664` → `editor.svelte.ts:1684` pass `continuous: true`).
//
// These cases are byte-level: they compare the frame the DRIVER sends against the CODEC's own encoding
// of the same value, so any conversion, scaling or rounding the driver adds fails the suite. Mocked
// transport + the REAL static FM3 profile: no hardware.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES } from '../../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec } from 'forgefx-midi/gen3/axe-fx-iii';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
const GLOBAL_EID = 1; // the family this regression was about (pid 7115 = Mini Display/Ring Brightness)
const BRIGHTNESS_PID = 7115;

export const SETPARAM_UNITS_CASE_COUNT = 6;

function makeDriver(): { driver: ReturnType<typeof createGen3Driver>; mock: MockTransport; codec: ReturnType<typeof createModernFractalCodec> } {
  const mock = new MockTransport('serial', 'mock');
  mock.isOpen = true;
  mock.reply = () => []; // silent device: we only inspect what WE sent
  const driver = createGen3Driver(PROFILES[MODEL]!, {
    transport: async () => mock,
    emit: () => {},
    getCadence: () => cadenceFor(MODEL, 'balanced')
  });
  return { driver, mock, codec: createModernFractalCodec(MODEL) };
}

const lastSent = (mock: MockTransport): number[] => mock.sent[mock.sent.length - 1]!;
const eq = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export async function runSetParamUnitsTests(): Promise<void> {
  const roster = effectRoster();
  const ampEid = roster.find((e) => e.slug === 'amp')!.page;

  // 1. A continuous GLOBAL write carries the caller's normalized value UNCHANGED. The P14 regression
  //    sent 40 here and the device clamped to 100%.
  {
    const { driver, mock, codec } = makeDriver();
    await driver.setParam(GLOBAL_EID, BRIGHTNESS_PID, 0.4, true);
    const sent = lastSent(mock);
    assert(
      eq(sent, codec.buildSetParameterContinuous(GLOBAL_EID, BRIGHTNESS_PID, 0.4)),
      'a continuous GLOBAL write must encode 0.4 as-is (no norm→display conversion)'
    );
  }

  // 2. The continuous branch CLAMPS to the 0..1 knob range — it does not SCALE. This distinction is the
  //    whole point: a caller passing 40 (a percentage) is clamped to 1.0, which the device reads as 100%;
  //    the P14 regression instead sent 40 verbatim and got the same 100% by accident, for the wrong reason.
  //    (The clamp is pre-existing behaviour — `setParam` passes `clamp01(value)` and the emitted `param`
  //    event reports the clamped knob position.)
  {
    const { driver, mock, codec } = makeDriver();
    await driver.setParam(GLOBAL_EID, BRIGHTNESS_PID, 40, true);
    const sent = lastSent(mock);
    assert(
      eq(sent, codec.buildSetParameterContinuous(GLOBAL_EID, BRIGHTNESS_PID, 1)),
      'the continuous branch must CLAMP an out-of-range value to 1.0, never scale it'
    );
  }

  // 3. The DISCRETE branch of the same param takes PERCENT, so 40 reaches the wire as 40 — and the
  //    driver still adds nothing. This is the unit that made the original diagnostic look like an app bug.
  {
    const { driver, mock, codec } = makeDriver();
    await driver.setParam(GLOBAL_EID, BRIGHTNESS_PID, 40, false);
    const sent = lastSent(mock);
    assert(
      eq(sent, codec.buildSetParameter(GLOBAL_EID, BRIGHTNESS_PID, 40)),
      'a discrete GLOBAL write encodes the caller value as-is (percent semantics belong to the opcode)'
    );
  }

  // 4. An unmarked family is trivially unaffected (the regression only ever touched GLOBAL) — a normal
  //    AMP knob keeps its byte-identical frame.
  {
    const { driver, mock, codec } = makeDriver();
    await driver.setParam(ampEid, 16, 0.7, true);
    const sent = lastSent(mock);
    assert(
      eq(sent, codec.buildSetParameterContinuous(ampEid, 16, 0.7)),
      'an unmarked family (AMP) keeps the caller value byte-identical'
    );
  }

  // 5. The two opcodes are distinguishable on the wire, and the CALLER's `continuous` flag is what
  //    selects one — the driver adds nothing to either. (Offsets are not hardcoded: the frames are
  //    compared to the codec's own output and to each other, so a header change can't silently pass.)
  {
    const { driver, mock, codec } = makeDriver();
    await driver.setParam(GLOBAL_EID, BRIGHTNESS_PID, 0.4, true);
    const cont = lastSent(mock);
    await driver.setParam(GLOBAL_EID, BRIGHTNESS_PID, 0.4, false);
    const disc = lastSent(mock);
    assert(
      eq(cont, codec.buildSetParameterContinuous(GLOBAL_EID, BRIGHTNESS_PID, 0.4)),
      'the continuous flag selects the continuous opcode, byte for byte'
    );
    assert(
      eq(disc, codec.buildSetParameter(GLOBAL_EID, BRIGHTNESS_PID, 0.4)),
      'continuous=false selects the discrete opcode, byte for byte'
    );
    assert(!eq(cont, disc), 'the two opcodes must not be interchangeable on the wire');
  }

  // 6. The FM3 model gate: this suite is about the FM3 only; another model's GLOBAL frame is untouched
  //    (the reverted change was FM3-scoped, and this pins that the revert left other models alone).
  {
    const ax3 = Object.values(PROFILES).find((p) => p.key !== 'fm3');
    if (ax3) {
      const mock = new MockTransport('serial', 'mock');
      mock.isOpen = true;
      mock.reply = () => [];
      const driver = createGen3Driver(ax3, {
        transport: async () => mock,
        emit: () => {},
        getCadence: () => cadenceFor(0x10, 'balanced')
      });
      const codec = createModernFractalCodec(ax3.model);
      await driver.setParam(GLOBAL_EID, BRIGHTNESS_PID, 0.4, true);
      assert(
        eq(lastSent(mock), codec.buildSetParameterContinuous(GLOBAL_EID, BRIGHTNESS_PID, 0.4)),
        `a non-FM3 profile (${ax3.key}) encodes the caller value as-is`
      );
    }
  }
}
