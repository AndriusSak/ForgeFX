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
// hook (buildApp's test-only `onRoute` seam, so registerHelpRoutes/registerLocalRoutes/am4 aliases are
// all included) and the router table from createRouter().listRoutes(). Nothing here runs a device.
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
  fcLiveRead: false,
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
    }
  } as DeviceDriver as FakeFm3;
}

// ── the documented, justified app-only differences (the claim is verified in the code, not assumed) ──
//  • /am4/* — the deprecated Phase-6 ALIASES. app.ts registers them with Deprecation/Sunset headers +
//    a /diag hit counter (see the `deprecated()` shim + the alias block in app.ts); router.ts's header
//    states plainly "no deprecated /am4/* aliases (v2 clients don't call them) → they 404 naturally".
//  • GET /events — the SSE stream. app.ts hijacks the socket (reply.hijack + text/event-stream); the
//    browser runtime replaces it with createRouter().subscribe() (router.ts header), so there is no
//    SSE route to register there.
function exceptionReason(key: string): string | null {
  const [method, path] = key.split(' ');
  if (path?.startsWith('/am4/')) {
    return 'deprecated /am4/* alias — Node host only; the browser runtime has no aliases (v2 clients never call them)';
  }
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
  { name: 'set param valid', method: 'PUT', url: '/preset/blocks/58/params/7', body: { value: 0.5, continuous: true }, expect: 200, callsDriver: true }
];

// drift-diff + documented-exceptions-used + ported-routes-present, plus one case per validation row
export const ROUTE_PARITY_CASE_COUNT = VALIDATION_ROWS.length + 3;

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

    // ── 2. every exception must actually correspond to a real app-only route (no stale excuses) ──
    const am4Aliases = appOnly.filter((k) => k.split(' ')[1]?.startsWith('/am4/'));
    assert(am4Aliases.length >= 15, `the /am4/* deprecated aliases must exist app-only (found ${am4Aliases.length})`);
    assert(appOnly.includes('GET /events'), 'GET /events must be an app-only difference');
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
}
