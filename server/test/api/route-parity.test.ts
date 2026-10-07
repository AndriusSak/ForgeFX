// P2.4 route-parity drift guard + P3 bad-param validation.
//
// THE BUG CLASS THIS PREVENTS: ForgeFX has TWO route tables — the Fastify app (src/app.ts, the Node
// host) and the browser-facing runtime router (src/runtime/router.ts, Axis's browser-direct
// transport). A new endpoint added to only ONE table silently 404s on the other surface (this is how
// the Range Trace panel and the Convert dialog broke in browser-direct mode). This suite enumerates
// BOTH tables' (method, path) sets and FAILS on any difference that is not on the documented
// exception list below, so a route can never again land in one table only.
//
// Enumeration is AUTHORITATIVE, not source-scraped: the app table comes from Fastify's own `onRoute`
// hook (buildApp's test-only `onRoute` seam, so registerHelpRoutes/registerLocalRoutes are all
// included) and the router table from createRouter().listRoutes(). Nothing here runs a device.
//
// It also covers P3: a route param that makes the codec's encode14 throw (a preset number outside
// 0..16383, a non-integer :paramId) must answer 400 on BOTH surfaces, not an unhandled 500.
import type { DeviceDriver, DriverCapabilities } from '../../src/drivers/types.js';
import { createRouter } from '../../src/runtime/router.js';
import * as store from '../../src/store.js';
import { buildTestApp } from '../helpers/api.js';
import { assert, assertEqual } from '../helpers/mock.js';

// ── fake FM3 driver: records its calls so a validation test can prove the guard fired BEFORE the
//    driver (the guard, not the driver, is what turns a bad param into a 400). ──
const CAPS: DriverCapabilities = {
  slotModel: 'grid',
  grid: { rows: 4, cols: 12 },
  gridEdit: true,
  scenes: 8,
  channels: true,
  presetDump: true,
  blockParamDecode: true,
  telemetry: { tuner: false, outputMeters: false, cpu: false },
  fcModel: true,
  fcLiveRead: true,
  modBind: true,
  cabIrs: true,
  supportsSave: true,
  selfDescribe: false,
  cacheImport: false,
  fullCapture: false
};

type FakeFm3 = DeviceDriver & { calls: unknown[][] };
function makeFakeFm3(): FakeFm3 {
  const calls: unknown[][] = [];
  const rec = (name: string, ...args: unknown[]) => calls.push([name, ...args]);
  return {
    calls,
    modelId: 0x11,
    key: 'fm3',
    name: 'FM3',
    capabilities: CAPS,
    selectPreset: async (n: number) => { rec('selectPreset', n); return { ok: true }; },
    setParam: async (addr: number, pid: number, value: number, continuous: boolean) => {
      rec('setParam', addr, pid, value, continuous);
      return { ok: true };
    },
    // The write methods the P6 validation rows exercise — each records so the row can prove the guard
    // fired BEFORE the driver (400 rows must NOT reach it) or that a valid input DID reach it.
    setBypass: async (addr: number, bypassed: boolean) => { rec('setBypass', addr, bypassed); return { ok: true }; },
    setChannel: async (eid: number, channel: string) => { rec('setChannel', eid, channel); return { ok: true }; },
    setType: async (eid: number, value: number) => { rec('setType', eid, value); return { ok: true }; },
    setScene: async (index: number) => { rec('setScene', index); return { ok: true }; },
    setSceneName: async (index: number, name: string) => { rec('setSceneName', index, name); return { ok: true }; },
    setPresetName: async (name: string) => { rec('setPresetName', name); return { ok: true }; },
    setTempo: async (bpm: number) => { rec('setTempo', bpm); return { ok: true }; },
    placeCell: async (row: number, col: number, blockId: number) => { rec('placeCell', row, col, blockId); return { ok: true }; },
    cable: async (srcRow: number, srcCol: number, destRow: number, connect: boolean) => { rec('cable', srcRow, srcCol, destRow, connect); return { ok: true }; },
    selectCell: async (row: number, col: number) => { rec('selectCell', row, col); return { ok: true }; },
    store: async (n: number) => { rec('store', n); return { ok: true }; },
    restorePreset: async (bytes: number[]) => { rec('restorePreset', bytes.length); return { ok: true }; },
    setParamByKey: async (key: string, value: number) => { rec('setParamByKey', key, value); return { ok: true }; },
    bindModifier: async (slot: number, targetEffectId: number, targetParam: number, source: number) => {
      rec('bindModifier', slot, targetEffectId, targetParam, source);
      return { ok: true };
    },
    // ── READ methods the P8 read-validation rows exercise — each records so a 400 row can prove the
    //    guard fired BEFORE the driver, and a valid boundary twin proves it still DID reach the driver. ──
    rawBlock: async (eid: number) => { rec('rawBlock', eid); return { eid, values: {} }; },
    cabState: async (eid: number) => { rec('cabState', eid); return { eid, mode: 'legacy' }; },
    readParams: async (eid: number, pids: number[]) => { rec('readParams', eid, pids); return {}; },
    readRange: async (eid: number, pids: number[]) => { rec('readRange', eid, pids); return {}; },
    presetSummary: async (n: number, full?: boolean) => {
      rec('presetSummary', n, full);
      return { number: n, name: `P${n}`, model: 'FM3', crcValid: true, scenes: [], blocks: [], models: {} } as never;
    },
    presetParams: async (n: number) => { rec('presetParams', n); return [] as never; },
    storedPresetName: async (n: number) => { rec('storedPresetName', n); return { number: n, name: `P${n}` }; },
    liveMonitors: async (onlyEid?: number) => { rec('liveMonitors', onlyEid); return []; },
    looperTelemetry: async (eid: number) => { rec('looperTelemetry', eid); return { wave: [], position: null, level: null }; },
    // P9 — the /fc/state live read. Records so a garbage row proves the guard fired BEFORE it, and the
    // valid boundary twin proves a well-formed address still reaches it.
    fcReadState: async (layout: number, view: number, sw: number) => {
      rec('fcReadState', layout, view, sw);
      return { effectId: 199, layout, view, switch: sw, config: 0, fields: {}, tapLabel: '', holdLabel: '' } as never;
    }
  } as DeviceDriver as FakeFm3;
}

// ── the documented, justified app-only difference (the claim is verified in the code, not assumed) ──
//  • GET /events — the SSE stream. app.ts hijacks the socket (reply.hijack + text/event-stream); the
//    browser runtime replaces it with createRouter().subscribe() (router.ts header), so there is no
//    SSE route to register there. This is now the ONLY app-only route (the /am4/* alias surface was
//    removed, which the stricter assertion in §2 below pins down exactly).
function exceptionReason(key: string): string | null {
  const [method, path] = key.split(' ');
  if (method === 'GET' && path === '/events') {
    return 'SSE — Node host only; the browser runtime consumes DeviceEvents via subscribe() instead';
  }
  return null;
}

const CORE_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);
const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

/** Routes this work package ported into the router so browser-direct mode stops 404ing. */
const PORTED = [
  'GET /diag/ranges',
  'POST /preset/convert',
  'POST /preset/convert/export',
  'POST /debug/raw',
  'GET /preset/body'
];

interface ValRow { name: string; method: string; url: string; body: unknown; expect: number; callsDriver: boolean }
// Every row is run against BOTH surfaces and must answer the SAME status (and make the SAME driver
// call decision). 400 = the encode14-throwing inputs; 200 = the boundary/valid twin that proves the
// guard is not over-broad.
const VALIDATION_ROWS: ValRow[] = [
  { name: 'preset select out of encode14 range', method: 'POST', url: '/preset/select', body: { number: 20000 }, expect: 400, callsDriver: false },
  { name: 'preset select missing number', method: 'POST', url: '/preset/select', body: {}, expect: 400, callsDriver: false },
  { name: 'preset select non-integer', method: 'POST', url: '/preset/select', body: { number: 1.5 }, expect: 400, callsDriver: false },
  { name: 'preset select valid', method: 'POST', url: '/preset/select', body: { number: 33 }, expect: 200, callsDriver: true },
  { name: 'set param non-integer paramId', method: 'PUT', url: '/preset/blocks/58/params/not-a-number', body: { value: 0.5, continuous: true }, expect: 400, callsDriver: false },
  { name: 'set param non-integer eid', method: 'PUT', url: '/preset/blocks/xyz/params/7', body: { value: 0.5 }, expect: 400, callsDriver: false },
  { name: 'set param out-of-range paramId', method: 'PUT', url: '/preset/blocks/58/params/20000', body: { value: 0.5 }, expect: 400, callsDriver: false },
  // P5 item 3 — `value` itself is validated at the seam. A DISCRETE write's value is an integer ORDINAL;
  // a fraction or an out-of-14-bit ordinal passed through to the codec (which does NOT throw — it
  // encodes any number as float32) and reached the device as a garbage frame with a 200. Now 400.
  { name: 'set param discrete non-integer value', method: 'PUT', url: '/preset/blocks/58/params/7', body: { value: 1.5 }, expect: 400, callsDriver: false },
  { name: 'set param discrete out-of-range ordinal', method: 'PUT', url: '/preset/blocks/58/params/7', body: { value: 20000 }, expect: 400, callsDriver: false },
  { name: 'set param discrete valid ordinal (boundary twin)', method: 'PUT', url: '/preset/blocks/58/params/7', body: { value: 12, continuous: false }, expect: 200, callsDriver: true },
  { name: 'set param valid', method: 'PUT', url: '/preset/blocks/58/params/7', body: { value: 0.5, continuous: true }, expect: 200, callsDriver: true },

  // ── P6 — the rest of the write seam. Every write route must answer 400 on garbage. Each garbage row
  //    is paired with a valid boundary twin that proves the guard is not over-broad. ──
  // bypass: eid out of range (codec encode14 throws → was 500) and a NON-BOOLEAN bypassed (the codec's
  // `bypassed ? 1 : 0` coerced "false" to BYPASSED with a 200 — the silent accept).
  { name: 'bypass eid out of range', method: 'POST', url: '/preset/blocks/20000/bypass', body: { bypassed: true }, expect: 400, callsDriver: false },
  { name: 'bypass non-integer eid', method: 'POST', url: '/preset/blocks/xyz/bypass', body: { bypassed: true }, expect: 400, callsDriver: false },
  { name: 'bypass non-boolean bypassed', method: 'POST', url: '/preset/blocks/58/bypass', body: { bypassed: 'false' }, expect: 400, callsDriver: false },
  { name: 'bypass valid', method: 'POST', url: '/preset/blocks/58/bypass', body: { bypassed: true }, expect: 200, callsDriver: true },
  // channel: a non-string channel crashed the driver's `channel.toUpperCase()` (500); an unknown letter
  // was silently ignored; a bad eid made encode14 throw (500).
  { name: 'channel non-string', method: 'POST', url: '/preset/blocks/58/channel', body: { channel: 5 }, expect: 400, callsDriver: false },
  { name: 'channel unknown letter', method: 'POST', url: '/preset/blocks/58/channel', body: { channel: 'Z' }, expect: 400, callsDriver: false },
  { name: 'channel valid', method: 'POST', url: '/preset/blocks/58/channel', body: { channel: 'B' }, expect: 200, callsDriver: true },
  // type: the ordinal rides a float-valued SET the codec encodes WITHOUT throwing → a fraction/NaN used
  // to reach the device as a bad frame with a 200 (the P5 lesson).
  { name: 'type non-numeric value', method: 'POST', url: '/preset/blocks/58/type', body: { value: 'abc' }, expect: 400, callsDriver: false },
  { name: 'type fractional value', method: 'POST', url: '/preset/blocks/58/type', body: { value: 1.5 }, expect: 400, callsDriver: false },
  { name: 'type valid', method: 'POST', url: '/preset/blocks/58/type', body: { value: 3 }, expect: 200, callsDriver: true },
  // grid edit: a col PAST the FM3's 4×12 grid (13) is inside the codec's 6×14 backstop, so it would
  // encode a gridPos outside the unit's own grid — now bounded to the device's capabilities.
  { name: 'grid cell col past the FM3 grid', method: 'PUT', url: '/preset/grid/cell', body: { row: 1, col: 13, blockId: 1 }, expect: 400, callsDriver: false },
  { name: 'grid cell valid', method: 'PUT', url: '/preset/grid/cell', body: { row: 1, col: 1, blockId: 1 }, expect: 200, callsDriver: true },
  { name: 'grid cable srcCol past the FM3 grid', method: 'POST', url: '/preset/grid/cable', body: { srcRow: 1, srcCol: 12, destRow: 2 }, expect: 400, callsDriver: false },
  { name: 'grid cable valid', method: 'POST', url: '/preset/grid/cable', body: { srcRow: 1, srcCol: 2, destRow: 2 }, expect: 200, callsDriver: true },
  { name: 'grid select non-integer col', method: 'POST', url: '/preset/grid/select', body: { row: 1, col: 'x' }, expect: 400, callsDriver: false },
  { name: 'grid select valid', method: 'POST', url: '/preset/grid/select', body: { row: 1, col: 2 }, expect: 200, callsDriver: true },
  // tempo: bpm packs as a float32 the codec encodes silently → a non-numeric bpm reached the device.
  { name: 'tempo non-numeric bpm', method: 'POST', url: '/tempo', body: { bpm: 'abc' }, expect: 400, callsDriver: false },
  { name: 'tempo valid', method: 'POST', url: '/tempo', body: { bpm: 121 }, expect: 200, callsDriver: true },
  // scene: a non-integer index made the codec's buildSetScene throw (500). (An in-range integer the
  // device lacks is the driver's EXPLICIT {ok:false} at 200 — unchanged, see api/write-safety.)
  { name: 'scene non-integer index', method: 'POST', url: '/scene', body: { index: 1.5 }, expect: 400, callsDriver: false },
  { name: 'scene valid', method: 'POST', url: '/scene', body: { index: 2 }, expect: 200, callsDriver: true },
  { name: 'scene name non-string', method: 'POST', url: '/scene/name', body: { index: 1, name: 5 }, expect: 400, callsDriver: false },
  { name: 'preset name non-string', method: 'POST', url: '/preset/name', body: { name: 5 }, expect: 400, callsDriver: false },
  // preset store: a fraction / out-of-range slot makes the codec's buildStorePreset throw (500).
  { name: 'preset store fractional number', method: 'POST', url: '/preset/store', body: { number: 1.5 }, expect: 400, callsDriver: false },
  { name: 'preset store out-of-range number', method: 'POST', url: '/preset/store', body: { number: 20000 }, expect: 400, callsDriver: false },
  // restore: Uint8Array.from SILENTLY wraps/clamps non-byte elements — reject them at the seam.
  { name: 'restore non-byte element', method: 'POST', url: '/preset/restore', body: { bytes: [1, 2, 300] }, expect: 400, callsDriver: false },
  { name: 'restore valid', method: 'POST', url: '/preset/restore', body: { bytes: [0xf0, 0x11, 0xf7] }, expect: 200, callsDriver: true },
  // device param: a non-finite value was passed straight to the encoder (silent accept).
  { name: 'device param non-numeric value', method: 'PUT', url: '/device/param', body: { key: 'amp.gain', value: 'x' }, expect: 400, callsDriver: false },
  { name: 'device param valid', method: 'PUT', url: '/device/param', body: { key: 'amp.gain', value: 7.5 }, expect: 200, callsDriver: true },
  // modifier bind: a non-integer slot flowed into Math.floor()→NaN and the encoder.
  { name: 'mod bind non-integer slot', method: 'POST', url: '/mod/bind', body: { slot: 'a', targetEffectId: 1, targetParam: 2, source: 3 }, expect: 400, callsDriver: false },

  // ── P8 — the READ seam. A malformed address (non-integer / outside the 14-bit codec space) is
  //    400 on BOTH surfaces; a WELL-FORMED address that names no present block/slot is deliberately
  //    LEFT to the driver (the twin reaches it). Each garbage row is paired with a boundary twin. ──
  // raw: the driver's enc14 would mask a garbage eid to a wrong address and read the wrong block (200).
  { name: 'raw non-integer eid', method: 'GET', url: '/preset/blocks/abc/raw', body: undefined, expect: 400, callsDriver: false },
  { name: 'raw out-of-14-bit eid', method: 'GET', url: '/preset/blocks/20000/raw', body: undefined, expect: 400, callsDriver: false },
  { name: 'raw valid boundary twin (eid 16383)', method: 'GET', url: '/preset/blocks/16383/raw', body: undefined, expect: 200, callsDriver: true },
  // cab: garbage eid → `slugForEffectId(NaN)` fell through to a 200 {error:'not a cab block'} (silent).
  { name: 'cab non-integer eid', method: 'GET', url: '/preset/blocks/xyz/cab', body: undefined, expect: 400, callsDriver: false },
  { name: 'cab valid', method: 'GET', url: '/preset/blocks/58/cab', body: undefined, expect: 200, callsDriver: true },
  // read / readrange: the eid AND the pids[] ride the enc14 field; both are validated at the seam.
  { name: 'read non-integer eid', method: 'POST', url: '/preset/blocks/abc/read', body: { pids: [1] }, expect: 400, callsDriver: false },
  { name: 'read non-integer pid', method: 'POST', url: '/preset/blocks/58/read', body: { pids: ['x'] }, expect: 400, callsDriver: false },
  { name: 'read out-of-14-bit pid', method: 'POST', url: '/preset/blocks/58/read', body: { pids: [20000] }, expect: 400, callsDriver: false },
  { name: 'read valid', method: 'POST', url: '/preset/blocks/58/read', body: { pids: [1, 2] }, expect: 200, callsDriver: true },
  { name: 'readrange non-integer eid', method: 'POST', url: '/preset/blocks/abc/readrange', body: { pids: [1] }, expect: 400, callsDriver: false },
  { name: 'readrange valid boundary twin (eid 16383)', method: 'POST', url: '/preset/blocks/16383/readrange', body: { pids: [1] }, expect: 200, callsDriver: true },
  // preset reads: a malformed :n was a silent {number:NaN,name:''} stub (name) or a 503 (summary/params).
  { name: 'preset name non-integer n', method: 'GET', url: '/presets/abc', body: undefined, expect: 400, callsDriver: false },
  { name: 'preset name out-of-14-bit n', method: 'GET', url: '/presets/20000', body: undefined, expect: 400, callsDriver: false },
  { name: 'preset name valid boundary twin (n 16383)', method: 'GET', url: '/presets/16383', body: undefined, expect: 200, callsDriver: true },
  { name: 'preset summary non-integer n', method: 'GET', url: '/presets/abc/summary', body: undefined, expect: 400, callsDriver: false },
  { name: 'preset summary valid', method: 'GET', url: '/presets/5/summary', body: undefined, expect: 200, callsDriver: true },
  { name: 'preset params non-integer n', method: 'GET', url: '/presets/abc/params', body: undefined, expect: 400, callsDriver: false },
  { name: 'preset params valid', method: 'GET', url: '/presets/5/params', body: undefined, expect: 200, callsDriver: true },
  // query eid reads: a present-but-malformed ?eid= used to silently widen (monitors: all blocks) or
  // the driver already 400'd (looper: 'eid required' only for non-numbers — a fraction slipped through).
  { name: 'monitors live malformed eid query', method: 'GET', url: '/preset/monitors/live?eid=abc', body: undefined, expect: 400, callsDriver: false },
  { name: 'monitors live valid eid query', method: 'GET', url: '/preset/monitors/live?eid=58', body: undefined, expect: 200, callsDriver: true },
  { name: 'monitors live absent eid (all blocks)', method: 'GET', url: '/preset/monitors/live', body: undefined, expect: 200, callsDriver: true },
  { name: 'looper missing eid', method: 'GET', url: '/preset/looper', body: undefined, expect: 400, callsDriver: false },
  { name: 'looper fractional eid', method: 'GET', url: '/preset/looper?eid=1.5', body: undefined, expect: 400, callsDriver: false },
  { name: 'looper valid eid query', method: 'GET', url: '/preset/looper?eid=58', body: undefined, expect: 200, callsDriver: true },

  // ── P9 — GET /fc/state. The three axes address one FC config (`layout*configsPerLayout + view*switches
  //    + sw`). A malformed axis makes the driver's config NaN → `enc14` encodes [0,0] → every field read
  //    from pid 0 with a silent 200; an axis past the FM3's geometry (9×4×3) aliases another switch. Now
  //    400 at the seam (before driver()), bounded to the device's declared geometry. Each garbage row is
  //    paired with a valid boundary twin that proves the guard is not over-broad. ──
  { name: 'fc state non-integer layout', method: 'GET', url: '/fc/state?layout=abc', body: undefined, expect: 400, callsDriver: false },
  { name: 'fc state negative view', method: 'GET', url: '/fc/state?view=-1', body: undefined, expect: 400, callsDriver: false },
  { name: 'fc state fractional switch', method: 'GET', url: '/fc/state?switch=1.5', body: undefined, expect: 400, callsDriver: false },
  { name: 'fc state layout past the FM3 geometry', method: 'GET', url: '/fc/state?layout=9', body: undefined, expect: 400, callsDriver: false },
  { name: 'fc state view past the FM3 geometry', method: 'GET', url: '/fc/state?view=4', body: undefined, expect: 400, callsDriver: false },
  { name: 'fc state switch past the FM3 geometry', method: 'GET', url: '/fc/state?switch=3', body: undefined, expect: 400, callsDriver: false },
  { name: 'fc state default config 0 (boundary twin)', method: 'GET', url: '/fc/state', body: undefined, expect: 200, callsDriver: true },
  { name: 'fc state max valid geometry (boundary twin)', method: 'GET', url: '/fc/state?layout=8&view=3&switch=2', body: undefined, expect: 200, callsDriver: true }
];

// drift-diff + documented-exceptions-used + ported-routes-present, plus one case per validation row,
// plus the P6 silent-accept proof (case 5, against the REAL gen-3 codec).
export const ROUTE_PARITY_CASE_COUNT = VALIDATION_ROWS.length + 5;

export async function runRouteParityTests(): Promise<void> {
  // Hermetic: no cloud (so app.ts's AXIS_CLOUD branch is off and both tables are compared in the
  // same "cloud disabled" configuration the browser runtime ships with by default).
  delete process.env.AXIS_CLOUD;
  delete process.env.FORGEFX_STATIC;

  const appRoutes: Array<{ method: string; path: string }> = [];
  const { app, registry } = await buildTestApp(0x11, makeFakeFm3(), {
    onRoute: (method, path) => appRoutes.push({ method, path })
  });
  const router = createRouter({ registry, store: store.defaultStore });

  try {
    // ── 1. drift guard: the two (method, path) sets must agree except on the documented list ──
    const appSet = new Set(appRoutes.filter((r) => CORE_METHODS.has(r.method)).map(key));
    const routerSet = new Set(router.listRoutes().filter((r) => CORE_METHODS.has(r.method)).map(key));

    const appOnly = [...appSet].filter((k) => !routerSet.has(k)).sort();
    const routerOnly = [...routerSet].filter((k) => !appSet.has(k)).sort();
    const unexplained = [...appOnly, ...routerOnly].filter((k) => exceptionReason(k) == null);
    assertEqual(
      unexplained.length,
      0,
      `route tables drifted — a route exists on only one surface without a documented exception:\n` +
        `  app-only (unexplained): ${appOnly.filter((k) => exceptionReason(k) == null).join(', ') || '(none)'}\n` +
        `  router-only (unexplained): ${routerOnly.join(', ') || '(none)'}`
    );

    // ── 2. every exception must actually correspond to a real app-only route (no stale excuses).
    //    After the /am4/* alias removal the ONLY app-only difference is the SSE route — assert that
    //    EXACTLY (an equality, not a count), so a revived or newly-drifting one-table route fails
    //    here, not merely a non-zero tally. ──
    assertEqual(appOnly.join(','), 'GET /events', `the only app-only route must be GET /events (found: ${appOnly.join(', ') || '(none)'})`);
    assert(!appOnly.some((k) => k.split(' ')[1]?.startsWith('/am4/')), 'no /am4/* alias may remain app-only — the alias surface is removed');
    for (const k of appOnly) assert(exceptionReason(k) != null, `${k} is app-only but has no documented exception`);
    assertEqual(routerOnly.length, 0, `the router must not register routes the app lacks: ${routerOnly.join(', ')}`);

    // ── 3. the routes this package ported must now exist on BOTH surfaces ──
    for (const k of PORTED) {
      assert(appSet.has(k), `ported route ${k} must exist in app.ts`);
      assert(routerSet.has(k), `ported route ${k} must exist in the browser runtime router`);
    }

    // ── 4. P3 — bad route params map to 400 (not an unhandled 500) on BOTH surfaces ──
    for (const row of VALIDATION_ROWS) {
      const fake = (await registry.driver()) as FakeFm3;
      const start = fake.calls.length;

      const res = await app.inject({
        method: row.method as 'GET',
        url: row.url,
        ...(row.body !== undefined ? { payload: row.body as Record<string, unknown> } : {})
      });
      const routed = await router.handle(row.method, row.url, row.body !== undefined ? JSON.stringify(row.body) : undefined);

      assertEqual(res.statusCode, row.expect, `${row.name}: app status (body ${res.payload.slice(0, 120)})`);
      assertEqual(routed.status, row.expect, `${row.name}: router status (body ${String(routed.body).slice(0, 120)})`);
      // the router body must deep-match the app body for the 400 envelope too
      if (typeof routed.body === 'string' && res.payload.length) {
        assertEqual(routed.body, res.payload, `${row.name}: 400 body parity`);
      }

      const madeCall = fake.calls.length > start;
      assertEqual(madeCall, row.callsDriver, `${row.name}: driver ${row.callsDriver ? 'must be' : 'must NOT be'} called`);
    }
  } finally {
    await app.close();
  }

  // ── 5. P6 — the P5 SILENT-ACCEPT lesson, proven against the REAL gen-3 codec ──
  // The failure mode was a write route answering 200 {ok:true} while a garbage value reached the
  // device: the gen-3 codec encodes ANY number as a float32 and does NOT throw, so POST /tempo used
  // to encode a NaN bpm into a tempo frame. Prove (a) the DRIVER still accepts garbage silently — so
  // validation MUST live at the seam, it can't be assumed from the driver — and (b) the seam now
  // answers 400 and puts NOTHING on the wire.
  {
    const { app, registry, mock } = await buildTestApp(0x11); // REAL FM3 driver over MockTransport
    const real = await registry.driver();
    try {
      const beforeProbe = mock.sent.length;
      const r = (await real.setTempo!(NaN)) as { ok?: boolean };
      assertEqual(r.ok, true, 'the gen-3 driver SILENTLY accepts a NaN bpm (ok:true) — this IS the silent accept the class closes');
      assertEqual(mock.sent.length, beforeProbe + 1, 'and the driver put a (garbage) tempo frame on the wire');

      const afterProbe = mock.sent.length;
      const res = await app.inject({ method: 'POST', url: '/tempo', payload: { bpm: 'abc' } });
      assertEqual(res.statusCode, 400, 'POST /tempo with a non-numeric bpm → 400 (silent accept closed)');
      assertEqual(mock.sent.length, afterProbe, 'the rejected request sent NOTHING to the device');

      const ok = await app.inject({ method: 'POST', url: '/tempo', payload: { bpm: 121 } });
      assertEqual(ok.statusCode, 200, 'a valid bpm still → 200');
      assertEqual(mock.sent.length, afterProbe + 1, 'and it does reach the device');
    } finally {
      await app.close();
    }
  }

  // ── 6. P9 — the /fc/state NaN address, proven against the REAL FM3 driver ──
  // The defect: `Number('abc')` → NaN made fcReadState's computed `config` NaN, and its `enc14`
  // (`n & 0x7f`) encoded NaN as [0, 0] — so every field was read from pid 0 and the route answered 200.
  // Prove the driver now REFUSES to encode such an address (throws) and puts NOTHING on the wire, while a
  // valid address still issues reads (so the driver backstop is not over-broad).
  {
    const { app, registry, mock } = await buildTestApp(0x11); // REAL FM3 driver over MockTransport
    const real = await registry.driver();
    try {
      const before = mock.sent.length;
      let threw = false;
      try { await real.fcReadState!(NaN, NaN, NaN); } catch { threw = true; }
      assert(threw, 'fcReadState(NaN,NaN,NaN) must THROW — not silently encode [0,0] and read pid 0');
      assertEqual(mock.sent.length, before, 'and the refused NaN address sent NOTHING to the device');

      const after = mock.sent.length;
      await real.fcReadState!(0, 0, 0); // valid config 0 still reads
      assert(mock.sent.length > after, 'a valid FC address still issues reads (the backstop is not over-broad)');
    } finally {
      await app.close();
    }
  }
}
