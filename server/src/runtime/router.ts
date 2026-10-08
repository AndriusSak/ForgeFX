// Runtime request router — the browser-facing twin of the Fastify app (app.ts). Axis Browser Direct
// installs `handle()` as its transport: same paths, same JSON shapes, same status codes, same
// capability-gating (501 unsupported), because the NON-TRIVIAL handler bodies are the shared
// runtime/handlers.ts + runtime/localService.ts + services/backups.ts code both surfaces call — only
// thin request-shape glue lives here (mirrored 1:1 from app.ts; the parity suite
// test/api/router.test.ts proves status+body equality over a shared fake registry + store).
//
// Differences by design:
//   • no /events SSE — `subscribe()` replaces it (a browser runtime consumes DeviceEvents directly);
//     PUT /store/config/:id still fans the config event out via the shared putStoreDoc().
//   • no /am4/* aliases (removed; the deprecated alias surface is gone) → they 404 naturally.
//   • services absent from deps answer their server "disabled" shapes: no `local` → the
//     unconfigured-root responses; no `cloud` → the AXIS_CLOUD=off /cloud/status + /remote/status
//     stubs (the other /cloud/* routes don't exist then — 404, exactly like app.ts); no `telemetry`
//     → the unconfigured telemetryStatus shape and the 503 upload error.
// NO fastify/node:/transport imports here or in anything this pulls in — must bundle for the browser.
import type { DeviceRegistry } from '../drivers/registryCore.js';
import type { DeviceEvent, CabIrUploadOptions, CabSlotQueryOptions } from '../drivers/types.js';
import { cabIrUserSlot, cabIrScratchpad } from 'forgefx-midi/devices/gen3';
import * as backups from '../services/backups.js';
import * as convert from '../services/convert.js';
import type { ConverterPreset } from 'forgefx-midi/convert';
import * as deviceCache from '../services/deviceCache.js';
import * as editorCacheImport from '../services/editorCacheImport.js';
import * as cloudProfiles from '../services/cloudProfiles.js';
import { blockHelpBySlug, helpIndex } from '../help.js';
import { createUnifiedHandlers, cabSlotTargetFromQuery, type RawQuery } from './handlers.js';
import { putStoreDoc } from './services.js';
import { createLocalService } from './localService.js';
import type { FolderAdapter } from './folderAdapter.js';
import type { ScanCachePersistence } from './localFolder.js';
import type { Store } from './store.js';
import type { CloudService } from './cloud.js';
import { isDeviceWrite, isDryRunRequest, frameHex, READ_ONLY_BODY } from './writeGate.js';

export interface RouterResponse {
  status: number;
  contentType: string;
  body: string | Uint8Array;
}

/** The /local/* bindings a runtime supplies (see runtime/localService.ts for each hook's contract).
 *  Node would pass createFsFolderAdapter + node:path checks; a browser passes its directory-handle
 *  adapter (root strings are opaque labels there) and a JS sha256. */
export interface RouterLocalDeps {
  adapterFor(root: string): FolderAdapter;
  isAbsolute(root: string): boolean;
  resolveRoot(root: string): string;
  scanCache: ScanCachePersistence;
  sha256Hex(bytes: Uint8Array): string;
}

/** Diagnostics upload surface (src/telemetry.ts shape). Absent → the "not configured" responses. */
export interface TelemetryService {
  status(): { enabled: boolean; faroUrl: string; key: string; uploadEnabled: boolean };
  report(body: Record<string, unknown>): Promise<{ path: string; bytes: number; stored: number }>;
}

export interface RuntimeDeps {
  registry: DeviceRegistry;
  store: Store;
  /** Read-only server (`--writes false`): every DEVICE-write endpoint answers 403. Default: writes on. */
  writes?: boolean;
  local?: RouterLocalDeps;
  cloud?: CloudService;
  telemetry?: TelemetryService;
}

// ── request plumbing ──
/** Per-request status recorder — the StatusSink the shared handlers code() into. */
class Reply {
  statusCode = 200;
  code(n: number): this { this.statusCode = n; return this; }
}

interface Ctx {
  params: Record<string, string>;
  query: URLSearchParams;
  /** Parsed JSON body ({} for empty, like app.ts's tolerant parser). */
  body: unknown;
  /** Raw bytes for the octet-stream routes (body arrived as Uint8Array). */
  raw: Uint8Array | null;
  reply: Reply;
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;
interface Route { method: string; path: string; segs: string[]; octet: boolean; handler: Handler }

const JSON_TYPE = 'application/json; charset=utf-8';
const OCTET_TYPE = 'application/octet-stream';

/** A query parameter's raw value in the SAME shape Fastify delivers (handlers.ts `RawQuery`): a key
 *  given once is a bare string, a repeated key (`?eid=1&eid=2`) is a string[], an absent key is
 *  undefined. URLSearchParams.getAll() always yields an array, so normalise it here — 0 → absent,
 *  1 → the string, 2+ → the array (a repeated key). This is what lets the shared singleQuery guard
 *  reject a repeated key identically on both surfaces instead of silently taking the first value. */
const queryValue = (query: URLSearchParams, name: string): RawQuery => {
  const all = query.getAll(name);
  return all.length === 0 ? undefined : all.length === 1 ? all[0] : all;
};

export function createRouter(deps: RuntimeDeps): {
  handle(method: string, path: string, body?: string | Uint8Array): Promise<RouterResponse>;
  subscribe(fn: (e: DeviceEvent) => void): () => void;
  /** The registered (method, path) table — for the route-parity drift guard
   *  (test/api/route-parity.test.ts) so it can diff this table against app.ts without re-parsing. */
  listRoutes(): Array<{ method: string; path: string }>;
} {
  const { registry, store } = deps;
  const h = createUnifiedHandlers(registry);
  const { driver, unsupported } = h;

  // /local/* — the shared route service over the runtime's folder bindings. Without `local` deps the
  // config/gate methods still answer, backed by a stub adapter whose root never exists — exactly the
  // server's unconfigured-root behavior (configured:false, 409 gates), and PUT with a path fails its
  // absolute-root check.
  const local = createLocalService({
    adapterFor: deps.local?.adapterFor ?? (() => UNAVAILABLE_ADAPTER),
    isAbsolute: deps.local?.isAbsolute ?? (() => false),
    resolveRoot: deps.local?.resolveRoot ?? ((r) => r),
    scanCache: deps.local?.scanCache ?? { load: () => ({}), save: () => {} },
    sha256Hex: deps.local?.sha256Hex ?? (() => ''),
    store,
    decode: h.decodeBytes
  });

  const routes: Route[] = [];
  const on = (method: string, path: string, handler: Handler, opts?: { octet?: boolean }) =>
    routes.push({ method, path, segs: path.split('/').filter(Boolean), octet: !!opts?.octet, handler });

  // ── system ──
  // /healthz carries the unified-API version handshake (mirrored as apiVersion on /device).
  on('GET', '/healthz', async () => {
    const hz = await registry.health();
    return { ok: hz.ok, api: { version: 2 }, device: hz.device };
  });
  // full connection diagnostic
  on('GET', '/diag', async () => registry.diagnostics());
  // Diagnostic (READ-ONLY): which RANGE row serves a family's param — the Axis Range Trace panel's
  // source. Mirrors app.ts (merged `ranges` vs the catalogue `staticRanges`), so a param dropped from
  // /preset/blocks/:eid/params can be traced to the row that dropped it in browser-direct mode too.
  on('GET', '/diag/ranges', (c) => {
    const profile = registry.profile;
    const family = (c.query.get('family') ?? 'CABINET').toUpperCase();
    const merged = profile.ranges[family] ?? {};
    const catalogue = (profile.staticRanges ?? profile.ranges)[family] ?? {};
    const defs = new Map((profile.params[family] ?? []).map((p) => [p.paramId, p]));
    const pidQ = c.query.get('pid');
    const pid = pidQ != null ? Number(pidQ) : null;
    const ids = pid != null ? [pid] : Object.keys(merged).map(Number).sort((a, b) => a - b);
    const row = (r?: { kind: string; displayMin: number; displayMax: number }) =>
      r ? { kind: r.kind, min: r.displayMin, max: r.displayMax } : null;
    return {
      profile: profile.key,
      model: `0x${profile.model.toString(16)}`,
      family,
      count: ids.length,
      rows: ids.map((id) => ({
        pid: id,
        name: defs.get(id)?.name ?? null,
        unit: defs.get(id)?.unit ?? null,
        serving: row(merged[id]),
        catalogue: row(catalogue[id])
      }))
    };
  });
  // debug probe (raw SysEx round-trip; for FC read-decode RE) — mirrors app.ts, incl. its 503 on a
  // malformed/missing body (the handler throws → the catch maps it, identical on both surfaces).
  on('POST', '/debug/raw', async (c) => {
    try { const bytes = ((c.body as { hex: string }).hex.match(/../g) ?? []).map((x) => parseInt(x, 16)); return { frames: await registry.rawRequest(bytes) }; }
    catch (e) { c.reply.code(503); return { error: (e as Error).message }; }
  });
  on('GET', '/device', () => registry.deviceInfo());
  on('GET', '/ports', () => registry.connections()); // serial + MIDI connections (Fractal flagged) + chosen + override
  on('POST', '/ports/select', (c) => {
    const b = (c.body ?? {}) as { transport?: 'serial' | 'midi'; id?: string | null; inId?: string | null; outId?: string | null; model?: string | null };
    const model = b.model; // undefined = leave the profile override as-is; 'auto'/'' = clear it; else force it
    // MIDI (Axe-Fx III / FM9, or an FM3 via a MIDI→USB adapter): separate input + output endpoints
    if (b?.transport === 'midi' && b.inId && b.outId) return registry.selectConnection({ transport: 'midi', id: b.id || b.inId, inId: b.inId, outId: b.outId }, model);
    if (b?.id) return registry.selectConnection({ transport: b.transport === 'midi' ? 'midi' : 'serial', id: b.id }, model);
    return registry.selectConnection(null, model); // clear the port back to auto (a forced profile can remain via `model`)
  });
  // auto-detect the connected Fractal unit (FM3/FM9/Axe-Fx/…) via the fn 0x00 handshake
  on('GET', '/device/detect', () => registry.detect());

  // ── device cache (on-connect self-describe build; capability selfDescribe) ──
  on('GET', '/device/cache', () => deviceCache.cacheStatus(store, registry));
  on('POST', '/device/cache/build', async (c) => {
    const body = c.body as { force?: boolean; mode?: 'read-only' | 'full' } | undefined;
    const r = await deviceCache.startCacheBuild(store, registry, { force: !!body?.force, mode: body?.mode });
    c.reply.code(r.code);
    return r.body;
  });
  on('POST', '/device/cache/cancel', () => deviceCache.cancelCacheBuild(registry));
  on('DELETE', '/device/cache', () => deviceCache.deleteCache(store, registry));
  // ── editor-cache import (SECOND cache source; capability cacheImport). Disk discovery is Node-only,
  //    so the browser twin returns an empty candidate list (discovery:'unavailable') + octet-only import. ──
  on('GET', '/device/cache/sources', async () => {
    const persisted = await editorCacheImport.isPersisted(store, registry);
    return { persisted, candidates: [], discovery: 'unavailable' };
  });
  on('POST', '/device/cache/import', async (c) => {
    if (!c.raw || !c.raw.length) { c.reply.code(400); return { error: 'POST the .cache bytes as application/octet-stream with ?name=<filename>' }; }
    const name = c.query.get('name');
    if (!name) { c.reply.code(400); return { error: 'missing ?name=<filename>' }; }
    const force = c.query.get('force') === '1' || c.query.get('force') === 'true';
    const r = await editorCacheImport.importEditorCache(registry, store, c.raw, { name, force });
    c.reply.code(r.code);
    return r.body;
  }, { octet: true });
  // ── shared device-definition profiles (THIRD cache source; services/cloudProfiles.ts). deps.cloud is
  //    optional — the GET always serves the disabled shape without it; pull/publish are registered only
  //    when it is present (parity with app.ts's AXIS_CLOUD gate — see below). ──
  on('GET', '/device/cache/cloud', () => cloudProfiles.cloudCacheCheck(deps.cloud ?? null, store, registry));
  // pull/publish exist ONLY when a cloud service is wired — exactly app.ts's AXIS_CLOUD=1 gate (its
  // cloud-off else-branch registers the disabled GET above but neither POST). Registering them always
  // made the router answer a `503 cloud disabled` shape where app.ts 404s; the route-table drift guard
  // (test/api/route-parity.test.ts) caught it.
  if (deps.cloud) {
    const cloud = deps.cloud;
    on('POST', '/device/cache/cloud/pull', async (c) => {
      const r = await cloudProfiles.cloudCachePull(cloud, store, registry);
      c.reply.code(r.code);
      return r.body;
    });
    on('POST', '/device/cache/cloud/publish', async (c) => {
      const r = await cloudProfiles.cloudCachePublish(cloud, store, registry);
      c.reply.code(r.code);
      return r.body;
    });
  }
  // Per-slot cab STATE read-back (READ-ONLY): populated flag + content region. ?user=N or ?page=&from=&to=
  on('GET', '/cab/slots', async (c) => {
    const d = await driver();
    if (!d.queryCabSlots) { c.reply.code(501); return { error: 'unsupported', capability: 'queryCabSlots' }; }
    const opts: CabSlotQueryOptions = {};
    const user = c.query.get('user');
    const page = c.query.get('page');
    if (user != null) {
      const n = Number(user);
      if (!Number.isInteger(n) || n < 1 || n > 512) { c.reply.code(400); return { error: `user slot ${user} is outside 1..512` }; }
      const dest = cabIrUserSlot(n);
      opts.page = dest.page;
      opts.from = dest.index;
      opts.to = dest.index;
    } else if (page != null) {
      opts.page = Number(page);
      const from = c.query.get('from');
      const to = c.query.get('to');
      opts.from = from != null ? Number(from) : 0;
      opts.to = to != null ? Number(to) : opts.from;
    }
    try {
      return await d.queryCabSlots(opts);
    } catch (e) { c.reply.code(400); return { error: (e as Error).message }; }
  });

  // CLEAR a user cab slot (DESTRUCTIVE): blank container + slot-state verification. ?user=N | ?page=&index=
  on('POST', '/cab/slots/clear', async (c) => {
    const d = await driver();
    if (!d.clearCabSlot) { c.reply.code(501); return { error: 'unsupported', capability: 'clearCabSlot' }; }
    const target = cabSlotTargetFromQuery({
      user: c.query.get('user') ?? undefined,
      page: c.query.get('page') ?? undefined,
      index: c.query.get('index') ?? undefined,
    });
    if ('error' in target) { c.reply.code(400); return { error: target.error }; }
    try {
      return await d.clearCabSlot(target);
    } catch (e) { c.reply.code(400); return { error: (e as Error).message }; }
  });

  // cab IR names per bank (Factory 1/2, Legacy, Scratchpad) — refresh lets a driver merge live per-device banks.
  on('GET', '/cab/irs', async (c) => {
    if (c.query.get('refresh') === '1') {
      const d = await driver();
      if (d.cabIrs) return d.cabIrs(true);
    }
    return registry.profile.cabIrs();
  });

  // ── block & parameter help (curated tooltips; see help.ts) ──
  on('GET', '/help', () => helpIndex(registry.profile));
  on('GET', '/help/blocks/:slug', (c) => {
    const dto = blockHelpBySlug(registry.profile, c.params.slug!);
    if (!dto) { c.reply.code(404); return { error: `no help for block "${c.params.slug}"` }; }
    return dto;
  });

  // ── preset ──
  on('GET', '/preset', async (c) => {
    const d = await driver();
    if (!d.presetRef) return unsupported(c.reply, 'presetRef');
    return d.presetRef();
  });
  // Stored preset name (driver-backed since Phase 6; gen-3 keeps the {number, name:''} stub).
  on('GET', '/presets/:n', (c) => h.presetNameH(c.reply, Number(c.params.n)));
  // Decode any preset by number (non-disruptive) → library summary: name, scenes, unique blocks.
  on('GET', '/presets/:n/summary', (c) => h.presetSummaryH(c.reply, Number(c.params.n), c.query.get('full') === '1'));
  // Full per-block decoded params for one preset (every family/param) — deep-search + browser detail.
  on('GET', '/presets/:n/params', (c) => h.presetParamsH(c.reply, Number(c.params.n)));
  // Decoded modifier assignments for the CURRENT edit buffer (source → target block+param + slot).
  on('GET', '/preset/modifiers', async (c) => {
    try {
      const d = await driver();
      if (!d.presetModifiers) return unsupported(c.reply, 'presetModifiers');
      return await d.presetModifiers();
    } catch (e) { c.reply.code(503); return { error: (e as Error).message }; }
  });
  // Per-preset Performance Page of the CURRENT edit buffer (§2.2) — READ-ONLY (see app.ts).
  on('GET', '/preset/perform', (c) => h.performPageH(c.reply));
  on('GET', '/presets/:n/grid', (c) => h.gridH(c.reply));
  on('GET', '/preset/grid', (c) => h.gridH(c.reply));
  on('GET', '/preset/blocks', (c) => h.blocksH(c.reply));
  on('GET', '/preset/scene-state', (c) => h.sceneStateH(c.reply));
  on('POST', '/preset/select', (c) => h.presetSelectH(c.reply, (c.body as { number: number }).number));
  on('POST', '/preset/store', (c) => h.presetStoreH(c.reply, (c.body as { number?: number } | undefined)?.number));
  // AM4 preset library scan → every stored location. Capability presets.canScanNames.
  on('GET', '/preset/locations', (c) => h.locationsH(c.reply));
  // Verbatim .syx dump of one preset (location omitted → active buffer). Capability backupDump.
  on('POST', '/preset/backup', (c) => h.backupH(c.reply, (c.body as { location?: number } | undefined)?.location));
  // Verbatim re-emit of a preset dump to its stored location. Capability restoreDump.
  on('POST', '/preset/restore', (c) => h.restoreH(c.reply, (c.body as { bytes?: number[] } | undefined)?.bytes));
  // Rename the working-buffer preset. Visible immediately; persist is a separate store.
  on('POST', '/preset/name', async (c) =>
    h.presetRenameH(c.reply, (c.body as { name: string }).name));

  // Decode an uploaded preset .syx → library summary. Offline (decode touches no transport).
  // Bodies: raw bytes (Uint8Array — the octet-stream shape) OR JSON {bytes:number[]}.
  // Model-byte-dispatched — an AM4 dump decodes via the AM4 offline decoder (see handlers.decodeH).
  on('POST', '/preset/decode', async (c) => {
    if (c.raw) {
      if (!c.raw.length) { c.reply.code(400); return { error: 'POST raw .syx bytes as application/octet-stream' }; }
      return h.decodeH(c.reply, c.raw);
    }
    const b = c.body as { bytes?: number[] } | undefined;
    const bytes = b && Array.isArray(b.bytes) ? b.bytes : null;
    if (!bytes || !bytes.length) { c.reply.code(400); return { error: 'POST raw .syx bytes as application/octet-stream, or JSON {bytes:number[]}' }; }
    return h.decodeH(c.reply, Uint8Array.from(bytes));
  }, { octet: true });
  // load arbitrary raw .syx bytes (e.g. a cloud/file preset) into the edit buffer
  on('POST', '/preset/load', async (c) => {
    if (!c.raw || !c.raw.length) { c.reply.code(400); return { error: 'POST raw .syx bytes as application/octet-stream' }; }
    try {
      const d = await driver();
      if (!d.loadPresetBytes) return unsupported(c.reply, 'loadPresetBytes');
      return await d.loadPresetBytes(c.raw);
    } catch (e) { c.reply.code(503); return { error: (e as Error).message }; }
  }, { octet: true });

  // upload a user-cab IR .syx container to the unit (§2.5). Mirrors app.ts: raw bytes or JSON
  // {bytes}; ?name= rewrites the 32 name slots, ?target=N&order=msb|lsb is the UNVERIFIED retarget
  // experiment, ?force=1 bypasses the FAIL-CLOSED gate. The gate is a measurement, not a hunch:
  // replaying a real FM3-Edit IR export drew a 0x64 on every frame (fn=0x7A → 0x16, fn=0x7B → 0x10 bad
  // message length) on fw 13, so without ?force=1 the request is 400 and NOTHING is sent. Even with it,
  // `{ok:true}` = frames sent, NOT stored — no cab-name read-back exists on this firmware.
  on('POST', '/cab/ir/upload', async (c) => {
    const body = (c.body ?? {}) as { bytes?: number[] };
    const bytes = c.raw && c.raw.length ? c.raw : Array.isArray(body.bytes) ? Uint8Array.from(body.bytes) : null;
    if (!bytes || !bytes.length) { c.reply.code(400); return { error: 'POST raw .syx bytes as application/octet-stream, or JSON {bytes:number[]}' }; }
    try {
      const d = await driver();
      if (!d.uploadCabIr) return unsupported(c.reply, 'uploadCabIr');
      const opts: CabIrUploadOptions = {};
      const q = c.query;
      const force = q.get('force');
      if (force === '1' || force === 'true') opts.allowUnverified = true; // the ONLY way past the gate
      const name = q.get('name');
      if (name != null) opts.name = name;
      // destination is REQUIRED (the export sentinel is measured-refused): ?user=N | ?scratchpad=N | ?page=&index=
      const user = q.get('user');
      const scratch = q.get('scratchpad');
      const page = q.get('page');
      const index = q.get('index');
      if (user != null) opts.dest = cabIrUserSlot(Number(user));
      else if (scratch != null) opts.dest = cabIrScratchpad(Number(scratch));
      else if (page != null && index != null) opts.dest = { page: Number(page), index: Number(index) };
      else { c.reply.code(400); return { error: 'a destination is required: ?user=N (1..512), ?scratchpad=N (1..16, refused by the unit) or ?page=&index=' }; }
      return await d.uploadCabIr(bytes, opts);
    } catch (e) { c.reply.code(400); return { error: (e as Error).message }; }
  }, { octet: true });

  // ── cross-device preset conversion (OFFLINE decode; the Convert dialog's endpoints) ──
  // Mirrors app.ts. `source.syx` (base64) → offline decode; omit `source` → the CONNECTED device's
  // current preset (capability-gated 501). 400 for an unknown target or an undecodable dump.
  on('POST', '/preset/convert', async (c) => {
    const b = (c.body ?? {}) as { targetDevice?: string; source?: { syx?: string } };
    const targetDevice = b.targetDevice;
    if (!convert.isConverterDeviceId(targetDevice)) {
      c.reply.code(400);
      return { error: 'unknown targetDevice', targetDevice: targetDevice ?? null, supported: convert.SUPPORTED_TARGETS };
    }
    const syxB64 = b.source?.syx;
    try {
      if (typeof syxB64 === 'string' && syxB64.length > 0) {
        return convert.convertFromSyx(base64ToBytes(syxB64), targetDevice);
      }
      const d = await driver();
      if (!d.capabilities.presetConvert) return unsupported(c.reply, 'presetConvert');
      return await convert.convertFromDriver(d, targetDevice);
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      c.reply.code(err.statusCode ?? 503);
      return { error: err.message ?? 'conversion failed' };
    }
  });
  // Author a target-device `.syx` from a converted preset by full-body synthesis (FM3 targets only,
  // 501 otherwise). `preset` (edited IR) preferred; else `source.syx` (base64); else the connected
  // device. Mirrors app.ts.
  on('POST', '/preset/convert/export', async (c) => {
    const b = (c.body ?? {}) as {
      targetDevice?: string; preset?: ConverterPreset; source?: { syx?: string };
      base?: { syx?: string }; name?: string; slot?: number;
    };
    const targetDevice = b.targetDevice;
    if (!convert.isConverterDeviceId(targetDevice)) {
      c.reply.code(400);
      return { error: 'unknown targetDevice', targetDevice: targetDevice ?? null, supported: convert.SUPPORTED_TARGETS };
    }
    const baseB64 = b.base?.syx;
    const base = typeof baseB64 === 'string' && baseB64.length > 0 ? base64ToBytes(baseB64) : undefined;
    const editedPreset = b.preset;
    const syxB64 = b.source?.syx;
    try {
      if (editedPreset && Array.isArray(editedPreset.blocks)) {
        return await convert.exportConvertedSyx({ targetDevice, preset: editedPreset, base, name: b.name, slot: b.slot });
      }
      if (typeof syxB64 === 'string' && syxB64.length > 0) {
        return await convert.exportConvertedSyx({ targetDevice, sourceSyx: base64ToBytes(syxB64), base, name: b.name, slot: b.slot });
      }
      const d = await driver();
      if (!d.capabilities.presetConvert) return unsupported(c.reply, 'presetConvert');
      return await convert.exportConvertedSyx({ targetDevice, driver: d, base, name: b.name, slot: b.slot });
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      c.reply.code(err.statusCode ?? 503);
      return { error: err.message ?? 'export failed' };
    }
  });
  // decompressed preset body (hex) — for per-block param-decode RE (offset diffs). Mirrors app.ts.
  on('GET', '/preset/body', async (c) => {
    try {
      const d = await driver();
      if (!d.presetBodyHex) return unsupported(c.reply, 'presetDump');
      return await d.presetBodyHex();
    } catch (e) { c.reply.code(503); return { error: (e as Error).message }; }
  });

  // ── catalog ──
  on('GET', '/blocks', async (c) => {
    const d = await driver();
    if (!d.blocksCatalog) return unsupported(c.reply, 'blocksCatalog');
    return d.blocksCatalog();
  });
  on('GET', '/blocks/:slug/types', async (c) => {
    const d = await driver();
    if (!d.blockTypes) return unsupported(c.reply, 'blockTypes');
    return d.blockTypes(c.params.slug!);
  });

  // ── live block params (addressed by the placed block's canonical address `addr`) ──
  on('GET', '/preset/blocks/:eid/params', (c) => h.blockParamsH(c.reply, Number(c.params.eid)));
  on('PUT', '/preset/blocks/:eid/params/:paramId', (c) => {
    const b = c.body as { value: number; continuous?: boolean };
    return h.setParamH(c.reply, Number(c.params.eid), Number(c.params.paramId), b.value, b.continuous);
  });
  on('POST', '/preset/blocks/:eid/bypass', (c) => h.bypassH(c.reply, Number(c.params.eid), (c.body as { bypassed: boolean }).bypassed));
  on('POST', '/preset/blocks/:eid/channel', (c) =>
    h.channelH(c.reply, Number(c.params.eid), (c.body as { channel: string }).channel));
  on('POST', '/preset/blocks/:eid/type', (c) =>
    h.typeH(c.reply, Number(c.params.eid), (c.body as { value: number }).value));
  // raw param values for an effect (for FC eid 199 / Modifier eid 3, whose params have no display range)
  on('GET', '/preset/blocks/:eid/raw', (c) => h.rawBlockH(c.reply, Number(c.params.eid)));
  // read specific paramIds, NORMALIZED 0..1 (per-pid range read, sub 0x1a — the plain 01 00 GET is
  // dead on fw13: it answers a canned template → denormal 0.0000; the fn=0x1F bulk path doesn't cover FC)
  on('POST', '/preset/blocks/:eid/read', (c) =>
    h.readParamsH(c.reply, Number(c.params.eid), (c.body as { pids?: number[] } | undefined)?.pids));
  // FC read path: sub 0x1a range-read returning the normalized (0..1) value per pid
  on('POST', '/preset/blocks/:eid/readrange', (c) =>
    h.readRangeH(c.reply, Number(c.params.eid), (c.body as { pids?: number[] } | undefined)?.pids));
  // current state of a cab block (mode / per-slot bank + IR + dyna type) for the picker
  on('GET', '/preset/blocks/:eid/cab', (c) => h.cabStateH(c.reply, Number(c.params.eid)));

  // per-block meter + swipe-control values for the always-on grid level fill
  on('POST', '/preset/meters', async (c) => {
    try {
      const d = await driver();
      if (!d.meters) return unsupported(c.reply, 'meters');
      return await d.meters((c.body as { wants?: Record<string, number[]> } | undefined)?.wants ?? {});
    } catch (e) { c.reply.code(503); return { error: (e as Error).message }; }
  });

  // ── grid editing (1-indexed row/col, matching FM-Edit) ──
  on('PUT', '/preset/grid/cell', async (c) => {
    const b = c.body as { row: number; col: number; blockId: number };
    return h.gridCellH(c.reply, b.row, b.col, b.blockId);
  });
  on('POST', '/preset/grid/cable', async (c) => {
    const b = c.body as { srcRow: number; srcCol: number; destRow: number; connect?: boolean };
    return h.gridCableH(c.reply, b.srcRow, b.srcCol, b.destRow, b.connect ?? true);
  });
  on('POST', '/preset/grid/select', async (c) => {
    const b = c.body as { row: number; col: number };
    return h.gridSelectH(c.reply, b.row, b.col);
  });

  // ── telemetry cadence-mode control (GET/PUT /telemetry/config) ──
  on('GET', '/telemetry/config', () => h.telemetryConfigH());
  on('PUT', '/telemetry/config', (c) => h.telemetrySetH(c.reply, (c.body as { mode?: string } | undefined)?.mode));

  // ── telemetry: tuner · tempo · scene ──
  on('POST', '/tuner', (c) => registry.setTuner(!!(c.body as { on?: boolean } | undefined)?.on));
  on('GET', '/tempo', async (c) => {
    const d = await driver();
    if (!d.getTempo) return unsupported(c.reply, 'getTempo');
    return d.getTempo();
  });
  on('POST', '/tempo', async (c) => h.tempoH(c.reply, (c.body as { bpm: number }).bpm));
  on('POST', '/tempo/tap', async (c) => {
    const d = await driver();
    if (!d.tapTempo) return unsupported(c.reply, 'tapTempo');
    return d.tapTempo();
  });
  on('GET', '/scene', async (c) => {
    const d = await driver();
    if (!d.getScene) return unsupported(c.reply, 'scenes');
    return d.getScene();
  });
  on('POST', '/scene', (c) => h.sceneSetH(c.reply, (c.body as { index: number }).index));
  // Rename a scene (0-based index) in the working buffer. Visible immediately; persist is a separate store.
  on('POST', '/scene/name', async (c) => {
    const b = c.body as { index: number; name: string };
    return h.sceneNameH(c.reply, b.index, b.name);
  });

  // ── FC / Modifier / monitors ──
  on('GET', '/fc/model', () => registry.profile.fcModel ?? null);
  // Modifier address model — unified superset DTO (always carries `bindingSupported`).
  on('GET', '/mod/model', () => h.modModelH());
  // Per-block monitor (meter) param table — read-only pids Axis renders meters from. {} if none.
  on('GET', '/preset/monitors', () => registry.profile.monitorParams ?? {});
  // Live per-block audio meters: reads each placed monitored block's level (normalized 0..1) + dB.
  on('GET', '/preset/monitors/live', (c) => h.liveMonitorsH(c.reply, queryValue(c.query, 'eid')));
  on('GET', '/preset/looper', (c) => h.looperTelemetryH(c.reply, queryValue(c.query, 'eid')));
  on('POST', '/preset/looper/control', async (c) => {
    const { eid, action, on: onv } = (c.body ?? {}) as { eid?: number; action?: string; on?: boolean };
    try {
      const d = await driver();
      if (!d.looperControl) return unsupported(c.reply, 'looperControl');
      if (!Number.isFinite(eid as number) || !action) { c.reply.code(400); return { error: 'eid + action required' }; }
      return await d.looperControl(eid as number, action, onv !== false);
    } catch (e) { c.reply.code(503); return { error: (e as Error).message }; }
  });
  // FC current switch state for one (layout,view,switch), via the sub-0x1b value channel (see app.ts).
  // layout/view/switch are validated in the SHARED fcStateH (malformed → 400 before driver()).
  on('GET', '/fc/state', (c) => h.fcStateH(c.reply,
    queryValue(c.query, 'layout'), queryValue(c.query, 'view'), queryValue(c.query, 'switch')));
  // bind a modifier slot to a target parameter (writes targetEffectId + targetParam + source on the slot eid)
  on('POST', '/mod/bind', async (c) => {
    const b = c.body as { slot?: number; targetEffectId?: number; targetParam?: number; source?: number } | undefined;
    return h.modBindH(c.reply, b);
  });

  // Validate a firmware .syx (integrity check only, NOT a flasher). Capability firmwareValidate.
  on('POST', '/firmware/validate', (c) => h.fwValidateH(c.reply, (c.body as { bytes?: number[] } | undefined)?.bytes));
  // Device/global param write by catalog key (e.g. the AM4's 'amp.gain'). Capability deviceParams.
  on('PUT', '/device/param', (c) => {
    const b = c.body as { key?: string; value?: number } | undefined;
    return h.deviceParamH(c.reply, b?.key, b?.value);
  });

  // ── persistent store: documents (Axis config · library metadata · layouts) ──
  on('GET', '/store/:c', (c) => ({ docs: store.listDocs(c.params.c!) }));
  on('GET', '/store/:c/:id', (c) => {
    const d = store.getDoc(c.params.c!, c.params.id!);
    if (!d) { c.reply.code(404); return { error: 'not found' }; }
    return d;
  });
  // Config writes fan out to every live UI (router subscribers, like the host's SSE) — shared putStoreDoc.
  on('PUT', '/store/:c/:id', (c) => {
    const b = c.body as { data?: unknown; origin?: string } | undefined;
    return putStoreDoc(store, registry, c.params.c!, c.params.id!, b?.data, b?.origin);
  });
  on('DELETE', '/store/:c/:id', (c) => { store.delDoc(c.params.c!, c.params.id!); return { ok: true }; });

  // ── local storage folder (Presets/ library + Sync/ mirror; shared service — see localService.ts) ──
  on('GET', '/local/config', async (c) => send(c, await local.config()));
  on('PUT', '/local/config', async (c) => send(c, await local.setConfig((c.body as { root?: string | null } | undefined)?.root)));
  on('GET', '/local/presets', async (c) => send(c, await local.presets(c.query.get('refresh') === '1')));
  on('GET', '/local/presets/file', async (c) => send(c, await local.presetFile(c.query.get('path') ?? undefined)));
  on('POST', '/local/presets', async (c) => send(c, await local.writePreset(c.body as Parameters<typeof local.writePreset>[0])));
  on('POST', '/local/sync', async (c) => send(c, await local.sync()));
  on('POST', '/local/restore', async (c) => send(c, await local.restore()));

  // ── backups + version control ──
  // snapshot one preset (version control)
  on('POST', '/backup/preset/:n', async (c) => {
    try {
      const d = await driver();
      if (!d.dumpRaw) return unsupported(c.reply, 'presetDump');
      const v = await backups.backupPreset(store, d, Number(c.params.n));
      if (!v) { c.reply.code(422); return { error: 'empty/invalid preset' }; }
      return { version: v };
    } catch (e) { c.reply.code(503); return { error: (e as Error).message }; }
  });
  // full-device backup (long-running): body { label, from?, to? }
  on('POST', '/backup/device', async (c) => {
    try {
      const d = await driver();
      if (!d.dumpRaw) return unsupported(c.reply, 'presetDump');
      const b = c.body as { label?: string; from?: number; to?: number } | undefined;
      return await backups.backupDevice(store, d, b?.label ?? 'Device backup', b?.from ?? 0, b?.to ?? 511);
    } catch (e) { c.reply.code(503); return { error: (e as Error).message }; }
  });
  on('GET', '/backups', () => ({ backups: store.listBackups() }));
  // load a stored version into the EDIT BUFFER (play it without occupying a slot)
  on('POST', '/version/:id/load', async (c) => {
    try {
      const d = await driver();
      if (!d.loadPresetBytes) return unsupported(c.reply, 'loadPresetBytes');
      return await backups.loadVersion(store, d, c.params.id!);
    } catch (e) { c.reply.code(503); return { error: (e as Error).message }; }
  });
  // restore a snapshot to its origin slot (load + commit to that slot — destructive for the slot)
  on('POST', '/version/:id/restore', async (c) => {
    try {
      const d = await driver();
      if (!d.loadPresetBytes || !d.store) return unsupported(c.reply, 'loadPresetBytes');
      return await backups.restoreVersion(store, d, c.params.id!);
    } catch (e) { c.reply.code(503); return { error: (e as Error).message }; }
  });
  // version history (all, or for one slot via ?location=)
  on('GET', '/versions', (c) => {
    const loc = c.query.get('location');
    return { versions: store.listPresetVersions(loc != null ? Number(loc) : undefined) };
  });
  // download a stored snapshot's raw .syx
  on('GET', '/version/:id/syx', (c) => {
    const bytes = store.getPresetVersionBytes(c.params.id!);
    if (!bytes) { c.reply.code(404); return { error: 'not found' }; }
    return bytes; // Uint8Array → application/octet-stream
  });

  // ── cloud sync + remote + telemetry ── absent services answer the server's "disabled" stubs; the
  // gated /cloud/* routes only exist when a cloud service is supplied (parity with AXIS_CLOUD=1).
  if (deps.cloud) {
    const cloud = deps.cloud;
    type Creds = { email: string; password: string };
    on('GET', '/cloud/status', () => cloud.status());
    on('POST', '/cloud/register', async (c) => { const b = c.body as Creds; try { return await cloud.register(b.email, b.password); } catch (e) { c.reply.code(400); return { error: (e as Error).message }; } });
    on('POST', '/cloud/login', async (c) => { const b = c.body as Creds; try { return await cloud.login(b.email, b.password); } catch (e) { c.reply.code(401); return { error: (e as Error).message }; } });
    on('POST', '/cloud/logout', () => cloud.logout());
    on('POST', '/cloud/delete-account', async (c) => { try { return await cloud.deleteAccount(); } catch (e) { c.reply.code(500); return { error: (e as Error).message }; } });
    on('POST', '/cloud/sync', async (c) => { try { return await cloud.sync((c.body as { scopes?: { config?: boolean; presets?: boolean } } | undefined)?.scopes); } catch (e) { c.reply.code(503); return { error: (e as Error).message }; } });
    on('GET', '/cloud/index', async (c) => { try { return await cloud.cloudIndex(); } catch (e) { c.reply.code(503); return { error: (e as Error).message }; } });
    // The Realtime remote HOST agent is a Node/Fastify concern (remote.ts) — a browser runtime IS the
    // UI, so it never hosts. Status mirrors the host's "off" answer; enabling is not available.
    on('GET', '/remote/status', () => ({ enabled: false, connected: false, userId: null }));
    on('POST', '/remote/enable', (c) => { c.reply.code(503); return { error: 'remote host not available in this runtime' }; });
  } else {
    on('GET', '/cloud/status', () => ({ enabled: false, user: null })); // so Axis can gate its UI without erroring
    on('GET', '/remote/status', () => ({ enabled: false, connected: false, userId: null }));
  }

  // status is always served (so Axis gates its UI without erroring); the report upload works whenever
  // a telemetry service is supplied — absent, it fails with the server's "not configured" 503.
  on('GET', '/telemetry/status', () => deps.telemetry?.status() ?? { enabled: false, faroUrl: '', key: '', uploadEnabled: false });
  on('POST', '/telemetry/report', async (c) => {
    try {
      if (!deps.telemetry) throw new Error('cloud storage not configured (SUPABASE_URL / SUPABASE_ANON_KEY unset)');
      return await deps.telemetry.report((c.body ?? {}) as Record<string, unknown>);
    } catch (e) { c.reply.code(503); return { error: (e as Error).message }; }
  });

  // ── dispatch ──
  const match = (route: Route, segs: string[]): Record<string, string> | null => {
    if (route.segs.length !== segs.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < segs.length; i++) {
      const pat = route.segs[i]!;
      if (pat.startsWith(':')) params[pat.slice(1)] = decodeURIComponent(segs[i]!);
      else if (pat !== segs[i]) return null;
    }
    return params;
  };

  const respond = (status: number, body: unknown): RouterResponse =>
    body instanceof Uint8Array
      ? { status, contentType: OCTET_TYPE, body }
      : { status, contentType: JSON_TYPE, body: JSON.stringify(body) };

  const handle = async (method: string, path: string, body?: string | Uint8Array): Promise<RouterResponse> => {
    const m = method.toUpperCase();
    const qi = path.indexOf('?');
    const pathname = qi >= 0 ? path.slice(0, qi) : path;
    const query = new URLSearchParams(qi >= 0 ? path.slice(qi + 1) : '');
    const segs = pathname.split('/').filter(Boolean);

    for (const route of routes) {
      if (route.method !== m) continue;
      const params = match(route, segs);
      if (!params) continue;

      // Body decode mirrors app.ts's parsers: Uint8Array = application/octet-stream on the raw-bytes
      // routes; everything else is JSON (empty/absent → {}, like the tolerant empty-JSON parser).
      let raw: Uint8Array | null = null;
      let json: unknown = {};
      if (body instanceof Uint8Array && route.octet) raw = body;
      else if (body != null) {
        const s = typeof body === 'string' ? body : new TextDecoder().decode(body);
        if (s.length) {
          try { json = JSON.parse(s); }
          catch { return respond(400, { statusCode: 400, error: 'Bad Request', message: 'Body is not valid JSON' }); }
        }
      }

      const ctx: Ctx = { params, query, body: json, raw, reply: new Reply() };
      // write-safety gates (writeGate.ts) — identical to app.ts so the twins stay in parity.
      if (deps.writes === false && isDeviceWrite(m, pathname)) return respond(403, READ_ONLY_BODY);
      let dry: { frames: number[][]; release: () => void } | null = null;
      if (isDryRunRequest(path) && isDeviceWrite(m, pathname)) {
        await driver().catch(() => {}); // activate on the real transport before capturing
        dry = await registry.acquireDryRun();
      }
      try {
        const out = await route.handler(ctx);
        const status = ctx.reply.statusCode;
        if (dry) {
          const hex = dry.frames.map(frameHex);
          const body = out && typeof out === 'object' && !Array.isArray(out)
            ? { ...(out as Record<string, unknown>), dryRun: true, frames: hex }
            : { result: out, dryRun: true, frames: hex };
          return respond(status, body);
        }
        return respond(status, out);
      } catch (e) {
        // uncaught handler error → Fastify's default 500 envelope
        return respond(500, { statusCode: 500, error: 'Internal Server Error', message: (e as Error).message });
      } finally {
        dry?.release();
      }
    }
    // Fastify's default not-found body, verbatim
    return respond(404, { message: `Route ${m}:${pathname} not found`, error: 'Not Found', statusCode: 404 });
  };

  return {
    handle,
    subscribe: (fn) => registry.subscribe(fn),
    listRoutes: () => routes.map((r) => ({ method: r.method, path: r.path }))
  };
}

/** Local-folder responses map onto the reply exactly like localStore.ts's `send` (bytes stay bytes). */
function send(c: Ctx, r: { status: number; body: unknown }): unknown {
  c.reply.code(r.status);
  return r.body;
}

/** Base64 → bytes WITHOUT Buffer (a Node global, absent in the browser this file must bundle for).
 *  `atob` is a global in browsers AND in Node ≥16, so the same code runs on both surfaces. */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Stub adapter behind the no-`local`-deps case: nothing exists, nothing is writable — every gated
 *  route answers exactly like the server with no root configured. */
const UNAVAILABLE_ADAPTER: FolderAdapter = {
  key: (rel) => rel,
  list: async () => { throw new Error('local folder unavailable'); },
  exists: async () => false,
  readFile: async () => { throw new Error('local folder unavailable'); },
  writeFile: async () => { throw new Error('local folder unavailable'); },
  mkdir: async () => { throw new Error('local folder unavailable'); },
  remove: async () => { throw new Error('local folder unavailable'); }
};
