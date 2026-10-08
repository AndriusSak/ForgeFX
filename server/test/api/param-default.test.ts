// W2.4 — the param write route FAILS CLOSED when `continuous` is OMITTED.
//
// Previously an omitted flag defaulted to DISCRETE here (`continuous ?? false`) while the Axis client's
// own helper defaulted the SAME omission to `continuous:true`. The two sides of the wire therefore
// disagreed on what an omission means, and the units are per-opcode:
//   continuous:true  → NORMALIZED 0..1 (raw 0.25 → 25.0%)
//   continuous:false → PERCENT / ordinal (raw 40 → 40.0%)
// so a direct REST caller sending `{value:1}` for a knob at maximum silently got 1% (discrete) instead
// of 100%. There is no safe default; the boundary now requires the field and answers 400 when it is
// missing, sending NOTHING to the device. This is an INTENTIONAL API change — callers that relied on
// the old default must send `continuous` explicitly (the Axis client already does).
//
// Route-level (app.inject) over a REAL FM3 driver on a MockTransport, and the same three writes on the
// browser router, so BOTH surfaces fail closed identically. Frames are read off `mock.sent`.
import { buildTestApp } from '../helpers/api.js';
import { createRouter } from '../../src/runtime/router.js';
import * as store from '../../src/store.js';
import { createModernFractalCodec } from 'forgefx-midi/gen3/axe-fx-iii';
import { assert, assertEqual, hex } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
const EID = 58;
const PID = 7;

export const PARAM_DEFAULT_CASE_COUNT = 5;

export async function runParamDefaultTests(): Promise<void> {
  const { app, registry, mock } = await buildTestApp(MODEL); // real FM3 gen-3 driver
  const codec = createModernFractalCodec(MODEL);
  const router = createRouter({ registry, store: store.defaultStore });

  const frames = (from: number): string[] => mock.sent.slice(from).map(hex);

  try {
    // ── 1. OMITTED `continuous` → 400, and NOTHING reaches the device (fail closed, no silent guess). ──
    {
      const before = mock.sent.length;
      const res = await app.inject({ method: 'PUT', url: `/preset/blocks/${EID}/params/${PID}`, payload: { value: 12 } });
      assertEqual(res.statusCode, 400, 'an omitted `continuous` must be a 400, not a silent discrete write');
      const err = (res.json() as { error?: string }).error ?? '';
      assert(/continuous is required/i.test(err), `the 400 names the missing field (got: ${err})`);
      assertEqual(frames(before).length, 0, 'the rejected request sent NOTHING to the device');
    }

    // ── 2. `continuous:false` → 200, the DISCRETE frame (float32(12)). ──
    {
      const before = mock.sent.length;
      const res = await app.inject({ method: 'PUT', url: `/preset/blocks/${EID}/params/${PID}`, payload: { value: 12, continuous: false } });
      assertEqual(res.statusCode, 200, 'an explicit continuous:false still writes → 200');
      const sent = frames(before);
      assertEqual(sent.length, 1, 'the discrete write sent exactly one frame');
      assertEqual(sent[0], hex(codec.buildSetParameter(EID, PID, 12)), 'continuous:false sends the DISCRETE frame (float32(12))');
    }

    // ── 3. `continuous:true` → 200, the CONTINUOUS frame (clamp01(12) → float32(1.0)). ──
    {
      const before = mock.sent.length;
      const res = await app.inject({ method: 'PUT', url: `/preset/blocks/${EID}/params/${PID}`, payload: { value: 12, continuous: true } });
      assertEqual(res.statusCode, 200, 'an explicit continuous:true still writes → 200');
      const sent = frames(before);
      assertEqual(sent.length, 1, 'the continuous write sent exactly one frame');
      assertEqual(sent[0], hex(codec.buildSetParameterContinuous(EID, PID, 1)), 'continuous:true sends the CONTINUOUS frame (clamp01(12) = 1.0)');
    }

    // ── 4. The BROWSER ROUTER fails closed identically: omitted → 400 + no device traffic. ──
    {
      const before = mock.sent.length;
      const routed = await router.handle('PUT', `/preset/blocks/${EID}/params/${PID}`, JSON.stringify({ value: 12 }));
      assertEqual(routed.status, 400, 'the router also rejects an omitted `continuous` (400 on both surfaces)');
      assertEqual(frames(before).length, 0, 'the router 400 also sent NOTHING to the device');
    }

    // ── 5. And the router's explicit writes reach the device with the SAME frames as the app. ──
    {
      const before = mock.sent.length;
      await router.handle('PUT', `/preset/blocks/${EID}/params/${PID}`, JSON.stringify({ value: 12, continuous: false }));
      const disc = frames(before);
      assertEqual(disc.length, 1, 'the router discrete write sent exactly one frame');
      assertEqual(disc[0], hex(codec.buildSetParameter(EID, PID, 12)), 'the router sends the discrete frame for continuous:false');
      const before2 = mock.sent.length;
      await router.handle('PUT', `/preset/blocks/${EID}/params/${PID}`, JSON.stringify({ value: 12, continuous: true }));
      const cont = frames(before2);
      assertEqual(cont.length, 1, 'the router continuous write sent exactly one frame');
      assertEqual(cont[0], hex(codec.buildSetParameterContinuous(EID, PID, 1)), 'the router sends the continuous frame for continuous:true');
    }
  } finally {
    await app.close();
  }
}
