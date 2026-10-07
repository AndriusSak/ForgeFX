// ForgeFX HTTP API — the Fastify app factory (Phase 6: unified device-agnostic API).
//
// Routes resolve the ACTIVE per-device driver from the registry (`await registry.driver()` — lazy
// one-time detection) and capability-gate optional driver methods: a device that can't do something
// answers `501 {error:'unsupported', capability}` instead of firing another model's frames at it.
// Connection/system concerns (ports, detect, SSE bus, telemetry supervisor) live on the registry.
//
// The gen-3 routes ARE the unified surface: every pre-Phase-6 gen-3 route keeps its path and a
// byte-identical response for FM3 (additive fields only). The deprecated /am4/* alias surface has
// been removed (the client's calls to it were dropped); everything routes through the unified paths.
//
// `buildApp(registry)` exists so the API tests can `app.inject()` against an ISOLATED mocked
// registry without listening; the production entry (index.ts) builds the app over the singleton
// registry and listens — identical behavior to the pre-factory module.
//
// The NON-TRIVIAL handler bodies (grid/blocks/param writes/preset ops/decode) live in
// runtime/handlers.ts and are shared verbatim with the browser-facing runtime router
// (runtime/router.ts) — this module keeps only the Fastify wiring, SSE, static UI and the
// Node-gated cloud/remote/telemetry surface.
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import type { DeviceRegistry } from './drivers/registry.js';
import * as backups from './services/backups.js';
import * as convert from './services/convert.js';
import type { ConverterPreset } from 'forgefx-midi/convert';
import * as deviceCache from './services/deviceCache.js';
import * as editorCacheImport from './services/editorCacheImport.js';
import * as editorCacheDiscovery from './services/editorCacheDiscovery.js';
import * as cloudProfiles from './services/cloudProfiles.js';
import * as store from './store.js';
import { createUnifiedHandlers } from './runtime/handlers.js';
import { putStoreDoc } from './runtime/services.js';
import { registerLocalRoutes } from './localStore.js';
import { registerHelpRoutes } from './help.js';
import { telemetryStatus, uploadDebugReport, type DebugReport } from './telemetry.js';
import { isDeviceWrite, isDryRunRequest, frameHex, READ_ONLY_BODY } from './runtime/writeGate.js';

export async function buildApp(
  registry: DeviceRegistry,
  opts?: {
    writes?: boolean;
    /** TEST-ONLY seam: invoked once per registered route with its (method, path). Lets the
     *  route-parity drift guard (test/api/route-parity.test.ts) enumerate THIS table authoritatively
     *  (registerHelpRoutes/localStore included) instead of re-parsing the source. */
    onRoute?: (method: string, path: string) => void;
  },
): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  // Hook FIRST so it observes every route registered below (help/local/SSE included).
  if (opts?.onRoute) {
    const collect = opts.onRoute;
    app.addHook('onRoute', (routeOptions) => {
      const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];
      for (const m of methods) collect(m, routeOptions.url);
    });
  }
  await app.register(cors, { origin: true });
  // tolerate an empty JSON body (no-body POSTs like /cloud/sync, /cloud/logout, /tempo/tap send
  // content-type: application/json with no payload → Fastify would 400 by default).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const s = body as string;
    if (!s || !s.length) return done(null, {});
    try { done(null, JSON.parse(s)); } catch (e) { done(e as Error); }
  });
  // accept raw .syx bytes (preset files) on POST /preset/decode
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  // The unified handler bodies + capability gate — shared with the runtime router (see handlers.ts).
  const {
    driver, unsupported,
    gridH, blocksH, sceneStateH, blockParamsH, setParamH, bypassH, sceneSetH,
    rawBlockH, cabStateH, readParamsH, readRangeH, presetSummaryH, presetParamsH,
    liveMonitorsH, looperTelemetryH,
    presetSelectH, presetStoreH, presetNameH, locationsH,
    backupH, restoreH, fwValidateH, deviceParamH, modModelH,
    telemetryConfigH, telemetrySetH,
    channelH, typeH, gridCellH, gridCableH, gridSelectH, tempoH, sceneNameH, presetRenameH, modBindH,
    decodeH, decodeBytes
  } = createUnifiedHandlers(registry);

  // ── write-safety gates (docs/write-protocol.md:37-39 is the authority; Axis/docs/ROADMAP.md is
  //    banner-stale — see the parity audit instead) ─────────────────────────────────────────────
  //  • `--writes false` → read-only: every DEVICE-write endpoint answers 403; reads and the LOCAL
  //    config store (/store, /local) are untouched because they never touch the unit. The same
  //    predicate gates the browser runtime router, so the two surfaces stay in parity.
  //  • `?dryRun=true` on a device write → the handler runs against a RECORDING transport, so the exact
  //    frames it would send are captured and nothing reaches the device. The real handler still runs,
  //    so validation still happens (a rejected request stays rejected); the hex is spliced into the
  //    JSON response additively as { dryRun:true, frames:[hex,…] }.
  const writesEnabled = opts?.writes !== false;
  const barePath = (url: string) => url.split('?')[0] || url;
  app.addHook('onRequest', async (req, reply) => {
    if (!writesEnabled && isDeviceWrite(req.method, barePath(req.url))) return reply.code(403).send(READ_ONLY_BODY);
  });
  const dryRuns = new WeakMap<FastifyRequest, { frames: number[][]; release: () => void }>();
  app.addHook('onRequest', async (req) => {
    if (!writesEnabled) return;
    if (!isDryRunRequest(req.url) || !isDeviceWrite(req.method, barePath(req.url))) return;
    await driver().catch(() => {}); // activate the driver on the REAL transport before capturing
    dryRuns.set(req, await registry.acquireDryRun());
  });
  app.addHook('onSend', async (req, _reply, payload) => {
    const dry = dryRuns.get(req);
    if (!dry) return payload;
    try {
      const parsed = typeof payload === 'string' && payload.length ? (JSON.parse(payload) as unknown) : {};
      const out = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { result: parsed };
      out.dryRun = true;
      out.frames = dry.frames.map(frameHex);
      return JSON.stringify(out);
    } catch { return payload; }
  });
  app.addHook('onResponse', (req, _reply, done) => {
    const dry = dryRuns.get(req);
    if (dry) { dryRuns.delete(req); dry.release(); }
    done();
  });

  // ── block & parameter help (curated tooltips; see help.ts) ──
  registerHelpRoutes(app, registry);

  // ── debug probe (raw SysEx round-trip; for FC read-decode RE) ──
  app.post<{ Body: { hex: string } }>('/debug/raw', async (req, reply) => {
    try { const bytes = (req.body.hex.match(/../g) ?? []).map((x) => parseInt(x, 16)); return { frames: await registry.rawRequest(bytes) }; }
    catch (e) { reply.code(503); return { error: (e as Error).message }; }
  });

  // ── system ──
  // /healthz carries the unified-API version handshake (mirrored as apiVersion on /device).
  app.get('/healthz', async () => {
    const h = await registry.health();
    return { ok: h.ok, api: { version: 2 }, device: h.device };
  });
  // full connection diagnostic for the desktop debug log
  app.get('/diag', async () => registry.diagnostics());
  // Diagnostic (READ-ONLY): which RANGE row serves a family's param. Merged rows come from the device's
  // on-connect self-describe cache where it has them (see runtimeProfileFrom) and can differ in KIND
  // from the catalogue, so a param missing from /preset/blocks/:eid/params can be traced to the row
  // that dropped it. `?family=CABINET&pid=25` for one param, else the whole family.
  app.get<{ Querystring: { family?: string; pid?: string } }>('/diag/ranges', async (req) => {
    const profile = registry.profile;
    const family = (req.query.family ?? 'CABINET').toUpperCase();
    const merged = profile.ranges[family] ?? {};
    const catalogue = (profile.staticRanges ?? profile.ranges)[family] ?? {};
    const defs = new Map((profile.params[family] ?? []).map((p) => [p.paramId, p]));
    const pid = req.query.pid != null ? Number(req.query.pid) : null;
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
  app.get('/device', () => registry.deviceInfo());
  app.get('/ports', () => registry.connections()); // serial + MIDI connections (Fractal flagged) + chosen + override
  app.post<{ Body: { transport?: 'serial' | 'midi'; id?: string | null; inId?: string | null; outId?: string | null; model?: string | null } }>('/ports/select', (req) => {
    const b = req.body ?? {};
    const model = b.model; // undefined = leave the profile override as-is; 'auto'/'' = clear it; else force it
    // MIDI (Axe-Fx III / FM9, or an FM3 via a MIDI→USB adapter): separate input + output endpoints
    if (b?.transport === 'midi' && b.inId && b.outId) return registry.selectConnection({ transport: 'midi', id: b.id || b.inId, inId: b.inId, outId: b.outId }, model);
    if (b?.id) return registry.selectConnection({ transport: b.transport === 'midi' ? 'midi' : 'serial', id: b.id }, model);
    return registry.selectConnection(null, model); // clear the port back to auto (a forced profile can remain via `model`)
  }); // manual pick

  // ── device cache (on-connect self-describe build; capability selfDescribe) ──
  // Status: current key + existence + live build progress + stored-doc meta.
  app.get('/device/cache', () => deviceCache.cacheStatus(store.defaultStore, registry));
  // Start a background build (501 no selfDescribe, 503 no device/firmware, 409 already building).
  app.post<{ Body: { force?: boolean; mode?: 'read-only' | 'full' } }>('/device/cache/build', async (req, reply) => {
    const r = await deviceCache.startCacheBuild(store.defaultStore, registry, { force: req.body?.force, mode: req.body?.mode });
    reply.code(r.code);
    return r.body;
  });
  // Cancel the running build (idempotent).
  app.post('/device/cache/cancel', () => deviceCache.cancelCacheBuild(registry));
  // Delete the current key's stored cache.
  app.delete('/device/cache', () => deviceCache.deleteCache(store.defaultStore, registry));

  // ── editor-cache import (SECOND cache source: an official-editor effectDefinitions_*.cache file;
  //    capability cacheImport). See services/editorCacheImport.ts + editorCacheDiscovery.ts. ──
  // Sources: is a cache already persisted for the attached device + which on-disk editor caches exist.
  app.get('/device/cache/sources', async () => {
    const persisted = await editorCacheImport.isPersisted(store.defaultStore, registry);
    return { persisted, candidates: editorCacheDiscovery.discoverEditorCaches() };
  });
  // Import: raw octet-stream of the .cache file + ?name=<filename> (& ?force=1), OR JSON { path } to
  // read a discovered candidate off disk. 501 no cacheImport, 409 model/firmware mismatch (force skips fw).
  app.post<{ Body: Buffer | { path?: string }; Querystring: { name?: string; force?: string } }>('/device/cache/import', async (req, reply) => {
    const force = req.query.force === '1' || req.query.force === 'true';
    const b = req.body;
    let bytes: Uint8Array;
    let name: string;
    if (b && !Buffer.isBuffer(b) && typeof b.path === 'string' && b.path) {
      try { const read = editorCacheDiscovery.readCandidateFile(b.path); bytes = read.bytes; name = read.name; }
      catch (e) { reply.code(400); return { error: 'cannot read path', message: (e as Error).message }; }
    } else if (Buffer.isBuffer(b)) {
      const nm = req.query.name;
      if (!nm) { reply.code(400); return { error: 'missing ?name=<filename> for the uploaded .cache bytes' }; }
      bytes = new Uint8Array(b); name = nm;
    } else {
      reply.code(400); return { error: 'POST the .cache bytes as application/octet-stream with ?name=<filename>, or JSON { path }' };
    }
    const r = await editorCacheImport.importEditorCache(registry, store.defaultStore, bytes, { name, force });
    reply.code(r.code);
    return r.body;
  });

  // ── unified handlers ──────────────────────────────────────────────────────────────────────────
  // Every capability-gated handler below is a named function from createUnifiedHandlers; the
  // Fastify route and its browser-runtime twin call the SAME function — no fastify inject.

  // ── preset ──
  app.get('/preset', async (_req, reply) => {
    const d = await driver();
    if (!d.presetRef) return unsupported(reply, 'presetRef');
    return d.presetRef();
  });
  // Stored preset name (driver-backed since Phase 6; gen-3 keeps the {number, name:''} stub).
  app.get<{ Params: { n: string } }>('/presets/:n', (req, reply) => presetNameH(reply, Number(req.params.n)));
  // Decode any preset by number (non-disruptive) → library summary: name, scenes, unique blocks.
  app.get<{ Params: { n: string }; Querystring: { full?: string } }>('/presets/:n/summary', (req, reply) =>
    presetSummaryH(reply, Number(req.params.n), req.query.full === '1'));
  // Full per-block decoded params for one preset (every family/param) — deep-search + browser detail.
  app.get<{ Params: { n: string } }>('/presets/:n/params', (req, reply) => presetParamsH(reply, Number(req.params.n)));
  // Decoded modifier assignments for the CURRENT edit buffer (source → target block+param + slot).
  // The modifier editor's read-back source; curve values come from the slot's /raw block.
  app.get('/preset/modifiers', async (_req, reply) => {
    try {
      const d = await driver();
      if (!d.presetModifiers) return unsupported(reply, 'presetModifiers');
      return await d.presetModifiers();
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  });
  // ── persistent store: documents (Axis config · library metadata · layouts) ──
  app.get<{ Params: { c: string } }>('/store/:c', (req) => ({ docs: store.listDocs(req.params.c) }));
  app.get<{ Params: { c: string; id: string } }>('/store/:c/:id', (req, reply) => {
    const d = store.getDoc(req.params.c, req.params.id);
    if (!d) { reply.code(404); return { error: 'not found' }; }
    return d;
  });
  // Config writes fan out to every live UI (host SSE + remote relay) — see runtime/services.ts.
  app.put<{ Params: { c: string; id: string }; Body: { data: unknown; origin?: string } }>('/store/:c/:id', (req) =>
    putStoreDoc(store.defaultStore, registry, req.params.c, req.params.id, req.body?.data, req.body?.origin));
  app.delete<{ Params: { c: string; id: string } }>('/store/:c/:id', (req) => { store.delDoc(req.params.c, req.params.id); return { ok: true }; });

  // ── local storage folder (Presets/ library + Sync/ plain-syx mirror; see localStore.ts) ──
  registerLocalRoutes(app, decodeBytes);

  // ── backups + version control ──
  // snapshot one preset (version control); body optional { source }
  app.post<{ Params: { n: string } }>('/backup/preset/:n', async (req, reply) => {
    try {
      const d = await driver();
      if (!d.dumpRaw) return unsupported(reply, 'presetDump');
      const v = await backups.backupPreset(store.defaultStore, d, Number(req.params.n));
      return v ? { version: v } : (reply.code(422), { error: 'empty/invalid preset' });
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  });
  // full-device backup (long-running): body { label, from?, to? }
  app.post<{ Body: { label?: string; from?: number; to?: number } }>('/backup/device', async (req, reply) => {
    try {
      const d = await driver();
      if (!d.dumpRaw) return unsupported(reply, 'presetDump');
      return await backups.backupDevice(store.defaultStore, d, req.body?.label ?? 'Device backup', req.body?.from ?? 0, req.body?.to ?? 511);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  });
  app.get('/backups', () => ({ backups: store.listBackups() }));
  // load a stored version into the EDIT BUFFER (play it without occupying a slot)
  app.post<{ Params: { id: string } }>('/version/:id/load', async (req, reply) => {
    try {
      const d = await driver();
      if (!d.loadPresetBytes) return unsupported(reply, 'loadPresetBytes');
      return await backups.loadVersion(store.defaultStore, d, req.params.id);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  });
  // restore a snapshot to its origin slot (load + commit to that slot — destructive for the slot)
  app.post<{ Params: { id: string } }>('/version/:id/restore', async (req, reply) => {
    try {
      const d = await driver();
      if (!d.loadPresetBytes || !d.store) return unsupported(reply, 'loadPresetBytes');
      return await backups.restoreVersion(store.defaultStore, d, req.params.id);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  });
  // load arbitrary raw .syx bytes (e.g. a cloud/file preset) into the edit buffer
  app.post('/preset/load', async (req, reply) => {
    const buf = req.body as Buffer | undefined;
    if (!buf || !buf.length) { reply.code(400); return { error: 'POST raw .syx bytes as application/octet-stream' }; }
    try {
      const d = await driver();
      if (!d.loadPresetBytes) return unsupported(reply, 'loadPresetBytes');
      return await d.loadPresetBytes(new Uint8Array(buf));
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  });
  // version history (all, or for one slot via ?location=)
  app.get<{ Querystring: { location?: string } }>('/versions', (req) => ({ versions: store.listPresetVersions(req.query.location != null ? Number(req.query.location) : undefined) }));
  // download a stored snapshot's raw .syx
  app.get<{ Params: { id: string } }>('/version/:id/syx', (req, reply) => {
    const bytes = store.getPresetVersionBytes(req.params.id);
    if (!bytes) { reply.code(404); return { error: 'not found' }; }
    reply.header('content-type', 'application/octet-stream');
    return Buffer.from(bytes);
  });

  // Decode an uploaded preset .syx → library summary. Offline (decode touches no transport).
  // Bodies: raw bytes as application/octet-stream (pre-Phase-6, byte-identical for gen-3 dumps)
  // OR JSON {bytes:number[]} (Phase 6). Model-byte-dispatched — an AM4 dump decodes via the AM4
  // offline decoder (see decodeH).
  app.post<{ Body: Buffer | { bytes?: number[] } }>('/preset/decode', async (req, reply) => {
    const b = req.body;
    if (Buffer.isBuffer(b)) {
      if (!b.length) { reply.code(400); return { error: 'POST raw .syx bytes as application/octet-stream' }; }
      return decodeH(reply, new Uint8Array(b));
    }
    const bytes = b && Array.isArray(b.bytes) ? b.bytes : null;
    if (!bytes || !bytes.length) { reply.code(400); return { error: 'POST raw .syx bytes as application/octet-stream, or JSON {bytes:number[]}' }; }
    return decodeH(reply, Uint8Array.from(bytes));
  });

  // Cross-device preset conversion. `source.syx` (base64) → OFFLINE decode of the uploaded dump
  // (gen-3 + AM4, model-byte dispatched; touches no device). `source` omitted → the CONNECTED device's
  // current preset, capability-gated (501 when the active driver's `presetConvert` is false). 400 for
  // an unknown target or an undecodable dump; the codec engine's per-decision events + severity summary
  // ride the 200 body. All codec calls live in services/convert.ts.
  app.post<{ Body: { targetDevice?: string; source?: { syx?: string } } }>('/preset/convert', async (req, reply) => {
    const targetDevice = req.body?.targetDevice;
    if (!convert.isConverterDeviceId(targetDevice)) {
      reply.code(400);
      return { error: 'unknown targetDevice', targetDevice: targetDevice ?? null, supported: convert.SUPPORTED_TARGETS };
    }
    const syxB64 = req.body?.source?.syx;
    try {
      if (typeof syxB64 === 'string' && syxB64.length > 0) {
        return convert.convertFromSyx(new Uint8Array(Buffer.from(syxB64, 'base64')), targetDevice);
      }
      const d = await driver();
      if (!d.capabilities.presetConvert) return unsupported(reply, 'presetConvert');
      return await convert.convertFromDriver(d, targetDevice);
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      reply.code(err.statusCode ?? 503);
      return { error: err.message ?? 'conversion failed' };
    }
  });

  // Author a target-device preset `.syx` from a converted preset by FULL-BODY SYNTHESIS onto the codec's
  // bundled default FM3 scaffold. `source.syx` (base64) → OFFLINE source; omit `source` → the CONNECTED
  // device's current preset (capability-gated). `base.syx` (base64) is OPTIONAL — when supplied it must be a
  // valid FM3 dump and is used as the scaffold override (400 otherwise); when omitted the bundled scaffold is
  // used so NO base is needed. FM3 targets only (501 otherwise). NOTE: the returned bytes are FILE-level
  // valid only — a hardware load test on a real FM3 is still required.
  app.post<{ Body: { targetDevice?: string; preset?: ConverterPreset; source?: { syx?: string }; base?: { syx?: string }; name?: string; slot?: number } }>(
    '/preset/convert/export',
    async (req, reply) => {
      const targetDevice = req.body?.targetDevice;
      if (!convert.isConverterDeviceId(targetDevice)) {
        reply.code(400);
        return { error: 'unknown targetDevice', targetDevice: targetDevice ?? null, supported: convert.SUPPORTED_TARGETS };
      }
      const baseB64 = req.body?.base?.syx;
      const base =
        typeof baseB64 === 'string' && baseB64.length > 0
          ? new Uint8Array(Buffer.from(baseB64, 'base64'))
          : undefined;
      const editedPreset = req.body?.preset;
      const syxB64 = req.body?.source?.syx;
      try {
        // PREFERRED: an edited converter IR from the UI — author it DIRECTLY so the user's grid
        // routing/cables + block/param edits are carried verbatim (no re-convert from source).
        if (editedPreset && Array.isArray(editedPreset.blocks)) {
          return await convert.exportConvertedSyx({
            targetDevice,
            preset: editedPreset,
            base,
            name: req.body?.name,
            slot: req.body?.slot,
          });
        }
        if (typeof syxB64 === 'string' && syxB64.length > 0) {
          return await convert.exportConvertedSyx({
            targetDevice,
            sourceSyx: new Uint8Array(Buffer.from(syxB64, 'base64')),
            base,
            name: req.body?.name,
            slot: req.body?.slot,
          });
        }
        const d = await driver();
        if (!d.capabilities.presetConvert) return unsupported(reply, 'presetConvert');
        return await convert.exportConvertedSyx({ targetDevice, driver: d, base, name: req.body?.name, slot: req.body?.slot });
      } catch (e) {
        const err = e as { statusCode?: number; message?: string };
        reply.code(err.statusCode ?? 503);
        return { error: err.message ?? 'export failed' };
      }
    },
  );

  app.get('/preset/grid', async (_req, reply) => gridH(reply));
  app.get<{ Params: { n: string } }>('/presets/:n/grid', async (_req, reply) => gridH(reply));
  app.get('/preset/blocks', async (_req, reply) => blocksH(reply));
  // Lightweight per-block bypass+channel (no preset dump) — Axis applies it to its cached grid on a scene change.
  app.get('/preset/scene-state', async (_req, reply) => sceneStateH(reply));
  app.post<{ Body: { number: number } }>('/preset/select', async (req, reply) => presetSelectH(reply, req.body.number));
  app.post<{ Body: { number?: number } }>('/preset/store', async (req, reply) => presetStoreH(reply, req.body?.number));
  // AM4 preset library scan → every stored location {location, code, name, isEmpty}. Capability
  // presets.canScanNames (gen-3 → 501 for now — a 512-slot name scan needs its own paced path).
  app.get('/preset/locations', async (_req, reply) => locationsH(reply));
  // Verbatim .syx dump of one preset (location omitted → active buffer). Capability backupDump.
  app.post<{ Body: { location?: number } }>('/preset/backup', async (req, reply) => backupH(reply, req.body?.location));
  // Verbatim re-emit of a preset dump to its stored location. Capability restoreDump.
  app.post<{ Body: { bytes?: number[] } }>('/preset/restore', async (req, reply) => restoreH(reply, req.body?.bytes));

  // ── catalog ──
  app.get('/blocks', async (_req, reply) => {
    const d = await driver();
    if (!d.blocksCatalog) return unsupported(reply, 'blocksCatalog');
    return d.blocksCatalog();
  });
  app.get<{ Params: { slug: string } }>('/blocks/:slug/types', async (req, reply) => {
    const d = await driver();
    if (!d.blockTypes) return unsupported(reply, 'blockTypes');
    return d.blockTypes(req.params.slug);
  });

  // ── live block params (addressed by the placed block's canonical address `addr`: gen-3 = the
  //    effect id, AM4 = the block's pidLow — exactly what each device's grid/blocks report) ──
  app.get<{ Params: { eid: string } }>('/preset/blocks/:eid/params', async (req, reply) => blockParamsH(reply, Number(req.params.eid)));
  app.put<{ Params: { eid: string; paramId: string }; Body: { value: number; continuous?: boolean } }>(
    '/preset/blocks/:eid/params/:paramId',
    async (req, reply) => setParamH(reply, Number(req.params.eid), Number(req.params.paramId), req.body.value, req.body.continuous ?? false)
  );
  app.post<{ Params: { eid: string }; Body: { bypassed: boolean } }>('/preset/blocks/:eid/bypass', async (req, reply) => bypassH(reply, Number(req.params.eid), req.body.bypassed));
  app.post<{ Params: { eid: string }; Body: { channel: string } }>('/preset/blocks/:eid/channel', (req, reply) =>
    channelH(reply, Number(req.params.eid), req.body.channel));
  app.post<{ Params: { eid: string }; Body: { value: number } }>('/preset/blocks/:eid/type', (req, reply) =>
    typeH(reply, Number(req.params.eid), req.body.value));

  // ── grid editing (1-indexed row/col, matching FM-Edit) ──
  app.put<{ Body: { row: number; col: number; blockId: number } }>('/preset/grid/cell', (req, reply) =>
    gridCellH(reply, req.body.row, req.body.col, req.body.blockId));
  app.post<{ Body: { srcRow: number; srcCol: number; destRow: number; connect?: boolean } }>('/preset/grid/cable', (req, reply) =>
    gridCableH(reply, req.body.srcRow, req.body.srcCol, req.body.destRow, req.body.connect ?? true));
  app.post<{ Body: { row: number; col: number } }>('/preset/grid/select', (req, reply) =>
    gridSelectH(reply, req.body.row, req.body.col));

  // ── telemetry cadence-mode control (GET/PUT /telemetry/config) ──
  app.get('/telemetry/config', () => telemetryConfigH());
  app.put<{ Body: { mode?: string } }>('/telemetry/config', (req, reply) => telemetrySetH(reply, req.body?.mode));

  // ── telemetry: tuner · tempo · scene ──
  app.post<{ Body: { on: boolean } }>('/tuner', (req) => registry.setTuner(!!req.body?.on));
  app.get('/tempo', async (_req, reply) => {
    const d = await driver();
    if (!d.getTempo) return unsupported(reply, 'getTempo');
    return d.getTempo();
  });
  app.post<{ Body: { bpm: number } }>('/tempo', async (req, reply) => tempoH(reply, req.body.bpm));
  app.post('/tempo/tap', async (_req, reply) => {
    const d = await driver();
    if (!d.tapTempo) return unsupported(reply, 'tapTempo');
    return d.tapTempo();
  });
  app.get('/scene', async (_req, reply) => {
    const d = await driver();
    if (!d.getScene) return unsupported(reply, 'scenes');
    return d.getScene();
  });
  app.post<{ Body: { index: number } }>('/scene', async (req, reply) => sceneSetH(reply, req.body.index));
  // Rename a scene (0-based index) in the working buffer. Visible immediately; persist is a separate store.
  app.post<{ Body: { index: number; name: string } }>('/scene/name', async (req, reply) =>
    sceneNameH(reply, req.body.index, req.body.name));
  // Rename the working-buffer preset. Visible immediately; persist is a separate store.
  app.post<{ Body: { name: string } }>('/preset/name', async (req, reply) => presetRenameH(reply, req.body.name));

  // auto-detect the connected Fractal unit (FM3/FM9/Axe-Fx/…) via the fn 0x00 handshake
  app.get('/device/detect', () => registry.detect());

  // cab IR names per bank (Factory 1/2, Legacy, Scratchpad) — refresh lets a driver merge live per-device banks.
  app.get<{ Querystring: { refresh?: string } }>('/cab/irs', async (req) => {
    if (req.query.refresh === '1') {
      const d = await driver();
      if (d.cabIrs) return d.cabIrs(true);
    }
    return registry.profile.cabIrs();
  });

  // Foot Controller + Modifier address models (field bases + config formula + enums). FM3-decoded;
  // null where the device's model isn't decoded yet. The client computes (eid,pid) from these and
  // reads/writes via the normal raw-read + setParam path.
  app.get('/fc/model', () => registry.profile.fcModel ?? null);
  // Modifier address model — unified superset DTO (always carries `bindingSupported`: gen-3 true,
  // AM4 false). Driver-backed since Phase 6; offline it serves the provisional profile's model.
  app.get('/mod/model', async () => modModelH());
  // Per-block monitor (meter) param table: paramName → {family, pid, role, min/maxDb}. Read-only pids
  // that ride the normal per-block read; Axis renders a meter per placed block from these. {} if none.
  app.get('/preset/monitors', () => registry.profile.monitorParams ?? {});
  // Live per-block audio meters: reads each placed monitored block's level (normalized 0..1) + dB.
  // ?eid= (optional) narrows to one block; an ADDRESSED but malformed eid is 400 (see liveMonitorsH).
  app.get('/preset/monitors/live', (req, reply) => liveMonitorsH(reply, (req.query as { eid?: string }).eid));
  // Looper page telemetry (waveform envelope + playhead position + level). Empty for non-looper blocks.
  app.get('/preset/looper', (req, reply) => looperTelemetryH(reply, (req.query as { eid?: string }).eid));
  // Toggle a looper transport control (record/play/stop/overdub/undo/once/reverse/half).
  app.post<{ Body: { eid?: number; action?: string; on?: boolean } }>('/preset/looper/control', async (req, reply) => {
    const { eid, action, on } = req.body ?? {};
    try {
      const d = await driver();
      if (!d.looperControl) return unsupported(reply, 'looperControl');
      if (!Number.isFinite(eid as number) || !action) { reply.code(400); return { error: 'eid + action required' }; }
      return await d.looperControl(eid as number, action, on !== false);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  });
  // FC current switch state via the sub-0x01 structured config-selector read (the read FM3-Edit uses on
  // FC-page entry). Returns the decoded current state (category/function/display/color + labels) for one
  // (layout,view,switch), read via the sub-0x1b value channel that tracks param edits (fcReadState).
  app.get<{ Querystring: { layout?: string; view?: string; switch?: string } }>('/fc/state', async (req, reply) => {
    const layout = Number(req.query.layout ?? 0);
    const view = Number(req.query.view ?? 0);
    const sw = Number(req.query.switch ?? 0);
    try {
      const d = await driver();
      if (!d.fcReadState) return unsupported(reply, 'fcLiveRead');
      return await d.fcReadState(layout, view, sw);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  });

  // decompressed preset body (hex) — for per-block param-decode RE (offset diffs)
  app.get('/preset/body', async (_req, reply) => {
    try {
      const d = await driver();
      if (!d.presetBodyHex) return unsupported(reply, 'presetDump');
      return await d.presetBodyHex();
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  });

  // Validate a firmware .syx (integrity check only, NOT a flasher). Capability firmwareValidate.
  app.post<{ Body: { bytes?: number[] } }>('/firmware/validate', async (req, reply) => fwValidateH(reply, req.body?.bytes));
  // Device/global param write by catalog key (e.g. the AM4's 'amp.gain'). Capability deviceParams.
  app.put<{ Body: { key?: string; value?: number } }>('/device/param', async (req, reply) => deviceParamH(reply, req.body?.key, req.body?.value));

  // bind a modifier slot to a target parameter (writes targetEffectId + targetParam + source on the slot eid)
  app.post<{ Body: { slot: number; targetEffectId: number; targetParam: number; source: number } }>('/mod/bind', async (req, reply) =>
    modBindH(reply, req.body));
  // raw param values for an effect (for FC eid 199 / Modifier eid 3, whose params have no display range)
  app.get<{ Params: { eid: string } }>('/preset/blocks/:eid/raw', (req, reply) => rawBlockH(reply, Number(req.params.eid)));
  // read specific paramIds via per-pid fn 0x01 GET (FC current state — the 0x1F bulk path doesn't cover FC)
  app.post<{ Params: { eid: string }; Body: { pids: number[] } }>('/preset/blocks/:eid/read', (req, reply) =>
    readParamsH(reply, Number(req.params.eid), req.body?.pids));
  // FC read path: sub 0x1a range-read returning the normalized (0..1) value per pid
  app.post<{ Params: { eid: string }; Body: { pids: number[] } }>('/preset/blocks/:eid/readrange', (req, reply) =>
    readRangeH(reply, Number(req.params.eid), req.body?.pids));
  // current state of a cab block (mode / per-slot bank + IR + dyna type) for the picker
  app.get<{ Params: { eid: string } }>('/preset/blocks/:eid/cab', (req, reply) => cabStateH(reply, Number(req.params.eid)));

  // per-block meter + swipe-control values for the always-on grid level fill
  app.post<{ Body: { wants?: Record<string, number[]> } }>('/preset/meters', async (req, reply) => {
    try {
      const d = await driver();
      if (!d.meters) return unsupported(reply, 'meters');
      return await d.meters(req.body?.wants ?? {});
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  });

  // ── live event stream (SSE): tuner / tempo / scene / cpu pushes ──
  app.get('/events', (req, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*'
    });
    raw.write(': connected\n\n');
    const unsub = registry.subscribe((e) => raw.write(`data: ${JSON.stringify(e)}\n\n`));
    const hb = setInterval(() => raw.write(': hb\n\n'), 15000);
    req.raw.on('close', () => {
      clearInterval(hb);
      unsub();
    });
  });

  // ── static UI (optional) ──
  // When FORGEFX_STATIC points at a built SPA (Axis), serve it for any non-API GET, with SPA
  // fallback to index.html. Registered as the not-found handler so it never shadows API routes.
  // Used by the desktop app (loads http://localhost:PORT) and headless/Pi single-binary setups.
  const STATIC = process.env.FORGEFX_STATIC;
  if (STATIC) {
    const root = resolve(STATIC);
    const MIME: Record<string, string> = {
      '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
      '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
      '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json', '.wasm': 'application/wasm'
    };
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET') return reply.code(404).send({ error: 'not found' });
      const urlPath = decodeURIComponent(req.url.split('?')[0] ?? '/');
      let file = join(root, urlPath === '/' ? 'index.html' : urlPath);
      if (!resolve(file).startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
      if (!existsSync(file)) return reply.code(404).send({ error: 'not found' });
      return reply.type(MIME[extname(file).toLowerCase()] ?? 'application/octet-stream').send(createReadStream(file));
    });
  }

  // ── cloud sync (GATED: only when AXIS_CLOUD=1; release builds never load supabase-js) ──
  if (process.env.AXIS_CLOUD === '1') {
    const { cloud } = await import('./cloud.js');
    type Creds = { email: string; password: string };
    app.get('/cloud/status', async () => cloud.status());
    app.post<{ Body: Creds }>('/cloud/register', async (req, reply) => { try { return await cloud.register(req.body.email, req.body.password); } catch (e) { reply.code(400); return { error: (e as Error).message }; } });
    app.post<{ Body: Creds }>('/cloud/login', async (req, reply) => { try { return await cloud.login(req.body.email, req.body.password); } catch (e) { reply.code(401); return { error: (e as Error).message }; } });
    app.post('/cloud/logout', async () => cloud.logout());
    app.post('/cloud/delete-account', async (_req, reply) => { try { return await cloud.deleteAccount(); } catch (e) { reply.code(500); return { error: (e as Error).message }; } });
    app.post<{ Body: { scopes?: { config?: boolean; presets?: boolean } } }>('/cloud/sync', async (req, reply) => { try { return await cloud.sync(req.body?.scopes); } catch (e) { reply.code(503); return { error: (e as Error).message }; } });
    app.get('/cloud/index', async (_req, reply) => { try { return await cloud.cloudIndex(); } catch (e) { reply.code(503); return { error: (e as Error).message }; } });

    // ── shared device-definition profiles (THIRD cache source; services/cloudProfiles.ts) ──
    app.get('/device/cache/cloud', async () => cloudProfiles.cloudCacheCheck(cloud, store.defaultStore, registry));
    app.post('/device/cache/cloud/pull', async (_req, reply) => { const r = await cloudProfiles.cloudCachePull(cloud, store.defaultStore, registry); reply.code(r.code); return r.body; });
    app.post('/device/cache/cloud/publish', async (_req, reply) => { const r = await cloudProfiles.cloudCachePublish(cloud, store.defaultStore, registry); reply.code(r.code); return r.body; });

    // ── Axis Cloud Remote — host agent (off by default; toggled by the Axis UI) ──
    const { RemoteHost } = await import('./remote.js');
    const remoteHost = new RemoteHost(app, () => cloud.remoteSession(), (fn) => registry.subscribe(fn));
    app.get('/remote/status', async () => remoteHost.status());
    app.post<{ Body: { on?: boolean } }>('/remote/enable', async (req, reply) => {
      try { return await remoteHost.enable(!!req.body?.on); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
    });
  } else {
    app.get('/cloud/status', async () => ({ enabled: false, user: null })); // so Axis can gate its UI without erroring
    app.get('/remote/status', async () => ({ enabled: false, connected: false, userId: null }));
    app.get('/device/cache/cloud', async () => ({ enabled: false, available: false })); // same non-erroring gate for the defs prompt
  }

  // ── telemetry / diagnostics ── status is always served (so Axis gates its UI without erroring). The
  // on-demand "Upload Debug Log" report is INDEPENDENT of live telemetry — it works whenever Supabase is
  // configured, as a per-incident explicit upload, even if the user declined live telemetry.
  app.get('/telemetry/status', async () => telemetryStatus());
  app.post<{ Body: DebugReport }>('/telemetry/report', async (req, reply) => {
    try { return await uploadDebugReport(req.body ?? {}); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  });

  return app;
}
