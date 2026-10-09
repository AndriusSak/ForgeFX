// GATE-CONTRACT — the `?dryRun=true` contract for EVERY device-write route on BOTH route tables.
//
// THE BUG CLASS THIS PREVENTS (third-party review 2026-10-09): `PUT /preset/%70erform/1` REACHED THE
// HANDLER on a read-only server (the gate compared the raw url while the router decodes before
// matching), and `?dryRun=true` on that encoded path ran the read-modify-write LIVE instead of
// previewing. Those two bugs are fixed; THIS suite is the class guard — it walks every (method, path)
// pair on both surfaces and pins the invariant per route, so no single route can regress and no new
// device-write can be added without a coverage entry.
//
// For a device-write route (method, path) the contract is:
//   (a) `?dryRun=true` must NEVER reach the unit — with the MockTransport, ZERO frames are sent.
//   (b) It must answer EITHER 200 { dryRun:true, frames:[hex,…] } (a preview) OR the exact
//       DRY_RUN_UNSUPPORTED_BODY at 400 (a read-modify-write cannot be previewed). It must NEVER 500
//       (the signature of an unhandled error or a bypassed gate). A capability/state refusal (501/503)
//       is a LEGITIMATE answer a device may give, but the request must still have been GATED — i.e. it
//       carries the `dryRun:true` capture marker — so a bypass (which would either send frames or drop
//       the marker) still fails here.
//   (c) The decision is CONSISTENT WITH writeGate.ts's NOT_DRY_RUNNABLE: `isDryRunnable(method, path)`
//       false → the exact 400 unsupported; true → a capture was acquired (dryRun:true). A route that
//       behaves the other way is a real defect and this suite reports it.
//   (d) The PERCENT-ENCODED spelling of one literal segment (e.g. `/preset/blocks/…` →
//       `/preset/%62locks/…`) must produce the SAME verdict as the plain spelling on the SAME surface,
//       and must also send zero frames.
//
// Routes are enumerated AUTHORITATIVELY: the app table from Fastify's own `onRoute` hook (buildApp's
// test seam) and the router table from createRouter().listRoutes(); both filtered by
// isDeviceWrite(method, path). A device-write route with no SPECS entry FAILS the suite (a new route
// must be given a coverage entry), and a route whose spec is present but preview:false is reported as
// having no meaningful 200-preview verdict under the mock (see NON-PREVIEW ROUTES below).
//
// NO hardware: the REAL gen-3 FM3 driver runs over the MockTransport; `?dryRun=true` swaps in the
// registry's recording capture transport, so the driver still builds its real frames but nothing is
// sent. `mock.sent` is the ground truth that the unit was never touched.
import type { DeviceRegistry } from '../../src/drivers/registry.js';
import { createRouter } from '../../src/runtime/router.js';
import * as store from '../../src/store.js';
import { buildTestApp } from '../helpers/api.js';
import { assert, assertEqual } from '../helpers/mock.js';
import { isDeviceWrite, isDryRunnable, DRY_RUN_UNSUPPORTED_BODY } from '../../src/runtime/writeGate.js';

const FM3 = 0x11;

/**
 * A well-formed request for one device-write route, plus whether the route MUST yield a
 * 200-with-at-least-one-captured-frame preview under the mock.
 *
 *  • preview:true  → 200, dryRun:true, frames.length ≥ 1 (a frame was actually built).
 *  • preview:false → the gate must still acquire the capture (dryRun:true) and never send a frame, but
 *                    the handler cannot reach a 200 preview under the mock (capability/state/ACK
 *                    reasons — see NON-PREVIEW ROUTES in the report); status is asserted ∉ {500} only.
 */
interface Spec {
  /** Concrete request path (params substituted), query included when the route needs one. */
  url: string;
  /** JSON body, or omitted for a body-less route. */
  body?: Record<string, unknown>;
  /** application/octet-stream body (routes that take raw .syx bytes). */
  octet?: number[];
  preview: boolean;
}

// A minimal, self-consistent FM3 preset-envelope .syx (F0 00 01 74 11 <fn> … F7) — enough for
// POST /preset/load to build its load frames. (A cab-IR container is NOT usable here: the upload is
// ACK-backed and the capture transport returns no ACKs — see /cab/ir/upload below.)
const SYX_PRESET = [0xf0, 0x00, 0x01, 0x74, FM3, 0x00, 0x00, 0xf7];
// A container-shaped blob for /cab/ir/upload that is refused at PARSE (before any ACK is needed).
const CAB_IR_REJECT = [0xf0, 0x00, 0x01, 0x74, FM3, 0x16, 0x00, 0xf7];

const DEVICE_WRITES: Record<string, Spec> = {
  // ── unified block / param writes ──
  'PUT /preset/blocks/:eid/params/:paramId': { url: '/preset/blocks/58/params/7', body: { value: 0.5, continuous: true }, preview: true },
  'POST /preset/blocks/:eid/bypass': { url: '/preset/blocks/58/bypass', body: { bypassed: true }, preview: true },
  'POST /preset/blocks/:eid/channel': { url: '/preset/blocks/58/channel', body: { channel: 'B' }, preview: true },
  'POST /preset/blocks/:eid/type': { url: '/preset/blocks/58/type', body: { value: 3 }, preview: true },
  // ── grid editing ──
  'PUT /preset/grid/cell': { url: '/preset/grid/cell', body: { row: 1, col: 1, blockId: 1 }, preview: true },
  'POST /preset/grid/cable': { url: '/preset/grid/cable', body: { srcRow: 1, srcCol: 2, destRow: 2 }, preview: true },
  'POST /preset/grid/select': { url: '/preset/grid/select', body: { row: 1, col: 2 }, preview: true },
  // ── preset / scene / tempo / modifier writes ──
  'POST /preset/select': { url: '/preset/select', body: { number: 3 }, preview: true },
  'POST /preset/store': { url: '/preset/store', body: { number: 3 }, preview: true },
  'POST /preset/name': { url: '/preset/name', body: { name: 'GateContract' }, preview: true },
  'POST /preset/load': { url: '/preset/load', octet: SYX_PRESET, preview: true },
  // restoreDump is not a capability of the FM3 driver → 501 unsupported (still gated).
  'POST /preset/restore': { url: '/preset/restore', body: { bytes: [0xf0, 0x11, 0xf7] }, preview: false },
  // ── read-modify-write writes: NOT_DRY_RUNNABLE — must be the exact 400 unsupported ──
  'PUT /preset/perform/:slot': { url: '/preset/perform/1', body: { effectId: 62 }, preview: false },
  'PUT /preset/switches/:index': { url: '/preset/switches/1', body: { actionCode: 1 }, preview: false },
  // ── cab writes ──
  // The IR upload is ACK-backed; the capture transport answers no ACKs, so only the PARSE refusal is
  // reachable under the mock (400, still gated, zero frames). See report.
  'POST /cab/ir/upload': { url: '/cab/ir/upload?user=1', octet: CAB_IR_REJECT, preview: false },
  // clearCabSlot builds its blank container + close frame up front → a real preview (2 frames).
  'POST /cab/slots/clear': { url: '/cab/slots/clear?user=1', preview: true },
  // ── scene / tempo / modifier ──
  'POST /scene': { url: '/scene', body: { index: 2 }, preview: true },
  'POST /scene/name': { url: '/scene/name', body: { index: 1, name: 'S' }, preview: true },
  'POST /tempo': { url: '/tempo', body: { bpm: 121 }, preview: true },
  'POST /tempo/tap': { url: '/tempo/tap', preview: true },
  'POST /mod/bind': { url: '/mod/bind', body: { slot: 1, targetEffectId: 1, targetParam: 2, source: 3 }, preview: true },
  // looperControl needs a live loop-state read the capture cannot answer → 200 {ok:false}, no frames.
  'POST /preset/looper/control': { url: '/preset/looper/control', body: { eid: 58, action: 'record' }, preview: false },
  // deviceParams capability is absent on the FM3 driver → 501 unsupported.
  'PUT /device/param': { url: '/device/param', body: { key: 'amp.gain', value: 1 }, preview: false },
  // version control needs a STORED snapshot; seeding it would leak into the shared default store
  // (cross-suite contamination), so the harness deliberately provides none → 503 version not found.
  'POST /version/:id/load': { url: '/version/gate-contract-none/load', preview: false },
  'POST /version/:id/restore': { url: '/version/gate-contract-none/restore', preview: false },
  // a device-cache build needs a detected firmware (fn 0x08) the mock does not supply → 503.
  'POST /device/cache/build': { url: '/device/cache/build', body: { mode: 'read-only' }, preview: false }
};

/** Every device-write route the two tables currently expose. */
const GATE_CONTRACT_ROUTE_COUNT = Object.keys(DEVICE_WRITES).length;
/** Requests the suite makes: every route × {plain, percent-encoded} × {app, router}. */
export const GATE_CONTRACT_CASE_COUNT = GATE_CONTRACT_ROUTE_COUNT * 4;

const routeKey = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

/** Encode the first character of the first LITERAL segment of a route (never a `:param`), so the
 *  router must DECODE it back and match the same handler — the exact `%70erform` class. */
function encodedSpelling(concreteUrl: string, template: string): string {
  const qi = concreteUrl.indexOf('?');
  const path = qi >= 0 ? concreteUrl.slice(0, qi) : concreteUrl;
  const query = qi >= 0 ? concreteUrl.slice(qi) : '';
  const csegs = path.split('/');
  const tsegs = template.split('/');
  for (let i = 0; i < tsegs.length; i++) {
    const t = tsegs[i];
    if (!t || t.startsWith(':') || t.length < 2) continue;
    const c = csegs[i];
    if (!c || c.length < 2) continue;
    csegs[i] = `%${c.charCodeAt(0).toString(16).padStart(2, '0')}${c.slice(1)}`;
    return csegs.join('/') + query;
  }
  throw new Error(`no literal segment to encode in ${template}`);
}

const withDryRun = (url: string) => (url.includes('?') ? `${url}&dryRun=true` : `${url}?dryRun=true`);

interface Verdict {
  status: number;
  /** The response carries the dry-run capture marker — the gate ACQUIRED a capture (it did not bypass). */
  gated: boolean;
  /** The response IS the exact DRY_RUN_UNSUPPORTED_BODY (a read-modify-write refusal). */
  unsupported: boolean;
  frames: number;
  note: string;
}

function parseJson(text: string): Record<string, unknown> | null {
  try { const j = JSON.parse(text) as unknown; return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null; } catch { return null; }
}

function toVerdict(status: number, bodyText: string): Verdict {
  const j = parseJson(bodyText);
  const unsupported = j != null && JSON.stringify(j) === JSON.stringify(DRY_RUN_UNSUPPORTED_BODY);
  return {
    status,
    gated: j != null && j.dryRun === true,
    unsupported,
    frames: j != null && Array.isArray(j.frames) ? (j.frames as unknown[]).length : -1,
    note: String(j?.error ?? (j == null ? bodyText.slice(0, 80) : ''))
  };
}

export async function runGateContractTests(): Promise<void> {
  // Hermetic: no cloud, no static SPA — the same configuration route-parity compares in.
  delete process.env.AXIS_CLOUD;
  delete process.env.FORGEFX_STATIC;

  const appRoutes: Array<{ method: string; path: string }> = [];
  const { app, registry, mock } = await buildTestApp(FM3, undefined, {
    onRoute: (method, path) => appRoutes.push({ method, path })
  });
  const router = createRouter({ registry, store: store.defaultStore });

  try {
    // ── 1. AUTHORITATIVE enumeration: both tables, filtered by the writeGate predicate ──
    const appWrites = [...new Set(appRoutes.filter((r) => isDeviceWrite(r.method, r.path)).map(routeKey))].sort();
    const routerWrites = [...new Set(router.listRoutes().filter((r) => isDeviceWrite(r.method, r.path)).map(routeKey))].sort();

    // The two surfaces must agree on the device-write SET (a one-table route is the route-parity bug).
    assertEqual(
      appWrites.join(' | '),
      routerWrites.join(' | '),
      'the app and the runtime router must expose the SAME device-write routes'
    );
    assertEqual(appWrites.length, GATE_CONTRACT_ROUTE_COUNT, `device-write route count drifted (expected ${GATE_CONTRACT_ROUTE_COUNT})`);

    // COVERAGE: every device-write route must have a spec — a new route fails here until it is covered.
    const missing = appWrites.filter((k) => !DEVICE_WRITES[k]);
    assertEqual(missing.length, 0, `device-write route(s) with no gate-contract coverage — add a spec (and a preview/reason):\n  ${missing.join('\n  ')}`);

    // ── 2. per-route × spelling × surface invariant ──
    const nonPreview: string[] = [];
    let previewed = 0;

    for (const k of appWrites) {
      const spec = DEVICE_WRITES[k]!;
      const [method, path] = k.split(' ') as [string, string];
      const dryRunnable = isDryRunnable(method, path);
      const encodedUrl = encodedSpelling(spec.url, path);
      assert(encodedUrl !== spec.url && encodedUrl.includes('%'), `${k}: the encoded spelling must differ from the plain one`);
      const spellings: Array<[string, string]> = [['plain', spec.url], ['encoded', encodedUrl]];

      const verdicts = new Map<string, Verdict>();

      for (const [spelling, url] of spellings) {
        const q = withDryRun(url);
        for (const surface of ['app', 'router'] as const) {
          const before = mock.sent.length;
          let status: number;
          let bodyText: string;
          if (surface === 'app') {
            const res = spec.octet
              ? await app.inject({ method: method as 'POST', url: q, payload: Buffer.from(spec.octet), headers: { 'content-type': 'application/octet-stream' } })
              : await app.inject({ method: method as 'POST', url: q, payload: (spec.body ?? {}) as Record<string, unknown> });
            status = res.statusCode;
            bodyText = res.payload;
          } else {
            const body = spec.octet ? new Uint8Array(spec.octet) : spec.body !== undefined ? JSON.stringify(spec.body) : undefined;
            const routed = await router.handle(method, q, body);
            status = routed.status;
            bodyText = typeof routed.body === 'string' ? routed.body : '';
          }
          const tag = `${k} [${surface}/${spelling}]`;

          // (a) ZERO frames may reach the unit.
          assertEqual(mock.sent.length, before, `${tag}: ?dryRun=true must send ZERO frames to the unit`);

          const v = toVerdict(status, bodyText);
          verdicts.set(`${surface}/${spelling}`, v);

          // (b) never an unhandled 500.
          assert(status !== 500, `${tag}: must NEVER answer 500 (unhandled error / bypassed gate) — got ${status} ${bodyText.slice(0, 160)}`);

          if (!dryRunnable) {
            // (c) on the NOT_DRY_RUNNABLE list → the exact 400 unsupported.
            assertEqual(status, 400, `${tag}: a NOT_DRY_RUNNABLE route must answer 400 (got ${status} ${bodyText.slice(0, 160)})`);
            assert(v.unsupported, `${tag}: a NOT_DRY_RUNNABLE route must answer the exact DRY_RUN_UNSUPPORTED_BODY (got ${bodyText.slice(0, 160)})`);
          } else {
            // (c) a dry-runnable route must NOT be refused as unsupported, and MUST have been captured.
            assert(!v.unsupported, `${tag}: a dry-runnable route must NOT be refused as dry-run-unsupported`);
            assert(
              v.gated,
              `${tag}: the gate must acquire a capture (dryRun:true) — otherwise the request neither previewed nor was refused. Got ${status} ${bodyText.slice(0, 160)}`
            );
            if (spec.preview) {
              assertEqual(status, 200, `${tag}: a previewable dry-runnable route must answer 200 (got ${status} ${bodyText.slice(0, 160)})`);
              assert(v.frames >= 1, `${tag}: a preview must carry at least one captured frame (got ${v.frames})`);
            } else {
              nonPreview.push(`${k} [${surface}/${spelling}] → ${status}${v.note ? ` ${v.note}` : ''}`);
            }
          }
          if (spec.preview) previewed += 1;
        }
      }

      // (d) the percent-encoded spelling must yield the SAME verdict as the plain one (per surface).
      for (const surface of ['app', 'router'] as const) {
        const p = verdicts.get(`${surface}/plain`)!;
        const e = verdicts.get(`${surface}/encoded`)!;
        assertEqual(e.status, p.status, `${k} [${surface}]: percent-encoded spelling must yield the SAME status as the plain one`);
        assertEqual(e.unsupported, p.unsupported, `${k} [${surface}]: encoded spelling must yield the same gate refusal verdict`);
        assertEqual(e.gated, p.gated, `${k} [${surface}]: encoded spelling must be captured/refused identically`);
      }
      // app ↔ router parity for each spelling (the twins must agree).
      for (const spelling of ['plain', 'encoded'] as const) {
        const a = verdicts.get(`app/${spelling}`)!;
        const r = verdicts.get(`router/${spelling}`)!;
        assertEqual(r.status, a.status, `${k} [${spelling}]: app/router status parity`);
        assertEqual(r.unsupported, a.unsupported, `${k} [${spelling}]: app/router gate-refusal parity`);
        assertEqual(r.gated, a.gated, `${k} [${spelling}]: app/router capture parity`);
      }
      assertEqual(verdicts.size, 4, `${k}: expected 4 verdicts (2 spellings × 2 surfaces)`);
    }

    assert(previewed >= 1, 'at least one device-write route must produce a captured-frame preview');
    // Every preview:true route must have previewed on all four (spelling×surface) combinations.
    const expectedPreviews = appWrites.filter((k) => DEVICE_WRITES[k]!.preview).length * 4;
    assertEqual(previewed, expectedPreviews, `expected ${expectedPreviews} previews across the previewable routes`);
  } finally {
    await app.close();
  }
}
