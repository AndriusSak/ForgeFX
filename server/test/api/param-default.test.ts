// W3.2 — the generic param write route must treat an OMITTED `continuous` flag as a DISCRETE write.
// The bare numeric `value` is an ordinal / model selector, so `PUT /preset/blocks/:eid/params/:pid`
// with `{value:12}` (no flag) must emit the discrete SET (float32(12)); the old `continuous ?? true`
// default sent a CONTINUOUS frame (clamp01(12)=1 → float32(1.0)), silently selecting the wrong
// model/type for any third-party or direct REST caller (Axis always sends the flag).
// Route-level (app.inject) over a REAL FM3 driver on a MockTransport: the frames are read off
// `mock.sent`, so this is independent of the W3.1 dry-run machinery.
import { buildTestApp } from '../helpers/api.js';
import { assert, assertEqual, hex } from '../helpers/mock.js';

export const PARAM_DEFAULT_CASE_COUNT = 3;

export async function runParamDefaultTests(): Promise<void> {
  const { app, mock } = await buildTestApp(0x11); // real FM3 gen-3 driver
  const put = async (body: Record<string, unknown>): Promise<string[]> => {
    const before = mock.sent.length;
    const res = await app.inject({ method: 'PUT', url: '/preset/blocks/58/params/7', payload: body });
    assertEqual(res.statusCode, 200, `PUT params ${JSON.stringify(body)} → 200`);
    return mock.sent.slice(before).map(hex);
  };

  const noFlag = await put({ value: 12 });                    // the defect: was sent as continuous
  const discrete = await put({ value: 12, continuous: false });
  const continuous = await put({ value: 12, continuous: true });

  assertEqual(noFlag.length, 1, 'omitted-flag write sent exactly one frame');
  assertEqual(noFlag[0], discrete[0], 'omitted flag sends the DISCRETE frame (float32(12))');
  assert(noFlag[0] !== continuous[0], 'omitted flag is NOT the continuous frame (float32(1.0))');

  await app.close();
}
