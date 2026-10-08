// Unified route handlers — the NON-TRIVIAL handler bodies shared verbatim by the Fastify app
// (app.ts) and the browser-facing runtime router
// (runtime/router.ts). Each handler resolves the ACTIVE per-device driver from the registry and
// capability-gates optional driver methods: a device that can't do something answers
// `501 {error:'unsupported', capability}` instead of firing another model's frames at it. Handlers
// signal the HTTP status through the minimal StatusSink seam (FastifyReply satisfies it structurally;
// the router uses a tiny status recorder), so the exact same code produces the exact same
// status+body on both surfaces. NO node:/fastify imports — this module must load in a browser.
import type { DeviceRegistry } from '../drivers/registryCore.js';
import type { PerformSlotPatch } from '../drivers/types.js';

/** The one reply capability the shared handlers need: set the response status. FastifyReply's
 *  `code()` matches; the runtime router records the status into its RouterResponse. */
export interface StatusSink { code(statusCode: number): unknown }

/** A single-valued query parameter's raw value as the two HTTP surfaces deliver it. Fastify parses a
 *  repeated key (`?eid=1&eid=2`) into a string[]; a key given ONCE is a bare string, an absent key is
 *  undefined. The browser runtime router normalises its URLSearchParams into this same shape
 *  (router.ts `queryValue`), so one shared guard can police both surfaces identically. */
export type RawQuery = string | string[] | undefined;

/** Fail-closed single-valued query guard (the divergence is MEASURED, not assumed). Before this guard
 *  the two surfaces DISAGREED on a repeated key: Fastify parsed `?eid=1&eid=2` into the array ['1','2']
 *  and the shared handler's `Number(['1','2'])` → NaN → 400, while the browser router's
 *  `URLSearchParams.get()` took the FIRST value ('1') → 200. A repeated key is AMBIGUOUS — there is no
 *  defensible "first wins" or "last wins" — so BOTH surfaces now refuse it with 400 naming the
 *  parameter. A key given once, or absent (undefined), passes through unchanged. */
function singleQuery(reply: StatusSink, name: string, raw: RawQuery):
  { ok: true; value: string | undefined } | { ok: false; body: { error: string } } {
  if (Array.isArray(raw)) {
    reply.code(400);
    return { ok: false, body: { error: `query parameter "${name}" must be given at most once` } };
  }
  return { ok: true, value: raw };
}

/**
 * Resolve a `?user=N` / `?page=&index=` query into a cab-slot target, or an error string.
 *
 * Shared by BOTH surfaces so a clear request cannot be interpreted differently by them (the same
 * divergence class the repeated-query-key guard closed). `user` is 1..512 across the four user banks;
 * `page`/`index` address a raw slot for the scratchpad or an explicit bank.
 */
export function cabSlotTargetFromQuery(q: { user?: string; page?: string; index?: string }): { page: number; from: number; to: number } | { error: string } {
  if (q.user != null && q.user !== '') {
    const n = Number(q.user);
    if (!Number.isInteger(n) || n < 1 || n > 512) return { error: `user slot ${q.user} is outside 1..512` };
    const page = 0x10 + Math.floor((n - 1) / 128);
    const index = (n - 1) % 128;
    return { page, from: index, to: index };
  }
  if (q.page != null && q.page !== '') {
    const page = Number(q.page);
    const index = q.index != null && q.index !== '' ? Number(q.index) : 0;
    if (!Number.isInteger(page) || !Number.isInteger(index) || index < 0) {
      return { error: `page/index must be non-negative integers (got page=${q.page} index=${q.index ?? 0})` };
    }
    return { page, from: index, to: index };
  }
  return { error: 'a destination is required: ?user=N (1..512) or ?page=&index=' };
}

export function createUnifiedHandlers(registry: DeviceRegistry) {
  const driver = () => registry.driver();

  // ── write-input seam guards (shared by BOTH surfaces) ─────────────────────────────────────────
  // The class this closes: a garbage route input must answer 400, NOT (a) an unhandled 500 from a
  // codec encode14 throw, and NOT (b) a SILENT 200 where the codec happily encodes the bad value into
  // a frame the device accepts (the P5 lesson — e.g. a float-valued SET encodes NaN without throwing).
  const EID_MAX = 0x3fff;
  /** The per-preset Performance Page always holds ten editor slots (see the codec's PERFORM_SLOTS). */
  const PERFORM_SLOT_COUNT = 10;
  /** A gen-3 effect/param/block id: an integer in the codec's 14-bit 0..16383 space. */
  const isEid = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= EID_MAX;
  /** The device's routed grid shape: its declared `grid`, the AM4's 1×slotCount linear chain, else the
   *  codec's 14-wide / 6-row ceiling. Used to bound row/col BEFORE the codec (which would 500 on them). */
  const gridShape = (caps: { grid?: { rows: number; cols: number }; slotModel?: string; slotCount?: number }) =>
    caps.grid ?? (caps.slotModel === 'linear' ? { rows: 1, cols: caps.slotCount ?? 4 } : { rows: 6, cols: 14 });
  /** A preset slot number: the SAME 14-bit 0..16383 space as an eid. The codec's buildRequestPresetDump
   *  / buildStorePreset carries the slot in an enc14 field, so a :n outside it is unrepresentable —
   *  a WRITE's codec guard throws (→ the seam's 400) and a READ's driver-side enc14 silently wraps it to
   *  the wrong slot (a silent mis-read). Either way `:n` is MALFORMED outside 0..16383, exactly as the
   *  write routes (presetSelectH/presetStoreH) already treat it. */
  const isPresetNumber = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= EID_MAX;

  /** Capability-gate reply: the active driver doesn't implement this optional method. */
  const unsupported = (reply: StatusSink, capability: string) => {
    reply.code(501);
    return { error: 'unsupported', capability };
  };

  // Decode-path errors are surfaced to the client AND logged (console.error → the desktop debug log),
  // so a failing grid/blocks decode (e.g. on Axe-Fx III presets) shows WHY in the user's log, not just 503.
  const decodeFail = (reply: StatusSink, where: string, e: unknown) => {
    const err = e as Error;
    console.error(`[forgefx] ${where} failed: ${err?.message ?? e}${err?.stack ? `\n${err.stack}` : ''}`);
    reply.code(503);
    return { error: err?.message ?? String(e) };
  };

  const gridH = async (reply: StatusSink) => {
    try { return await (await driver()).grid(); } catch (e) { return decodeFail(reply, 'grid decode', e); }
  };
  const blocksH = async (reply: StatusSink) => {
    try {
      const d = await driver();
      if (!d.placedBlocks) return unsupported(reply, 'placedBlocks');
      return await d.placedBlocks();
    } catch (e) { return decodeFail(reply, 'blocks decode', e); }
  };
  // Lightweight per-block bypass+channel (no preset dump) — the UI applies this to its cached grid on a
  // scene change instead of re-dumping. 501 on drivers without it → the client falls back to a full load.
  const sceneStateH = async (reply: StatusSink) => {
    try {
      const d = await driver();
      if (!d.sceneState) return unsupported(reply, 'sceneState');
      return await d.sceneState();
    } catch (e) { return decodeFail(reply, 'scene-state', e); }
  };
  const blockParamsH = async (reply: StatusSink, addr: number) => {
    if (!isEid(addr)) { reply.code(400); return { error: 'eid must be an integer 0..16383' }; }
    try {
      const d = await driver();
      if (!d.blockParams) return unsupported(reply, 'blockParams');
      return await d.blockParams(addr);
    } catch (e) { reply.code(404); return { error: (e as Error).message }; }
  };
  // ── read-input seam guards (shared by BOTH surfaces) ─────────────────────────────────────────
  // Same class as the write guards below, one step milder: a READ never mutates the unit, but a
  // MALFORMED address still mis-fires on the wire — the driver's own `enc14` (readParams/readRange/
  // rawBlock) masks a non-integer/garbage eid to `[n & 0x7f, (n >> 7) & 0x7f]` and requests the WRONG
  // block with a 200 and no throw (silent mis-read). So a non-integer / out-of-14-bit address is
  // MALFORMED → 400. A WELL-FORMED address (integer 0..16383) that names no present block/slot is a
  // different case entirely and is deliberately LEFT to the driver — it already answers it (an empty
  // read, `{error:'not a cab block'}`, or a 503), and blanket-400ing it would hide that distinction.
  /** pids[] guard: the param ids a read addresses ride the SAME 14-bit enc14 field as the eid, so a
   *  non-integer/out-of-range pid reads a wrong pid silently. Omitted/null → [] (a no-op read). */
  const isPidList = (v: unknown): v is number[] => Array.isArray(v) && (v as unknown[]).every((p) => isEid(p));
  /** GET /preset/blocks/:eid/raw — raw bulk param values (FC eid 199 / Modifier eid 3). */
  const rawBlockH = async (reply: StatusSink, eid: number) => {
    if (!isEid(eid)) { reply.code(400); return { error: 'eid must be an integer 0..16383' }; }
    try {
      const d = await driver();
      if (!d.rawBlock) return unsupported(reply, 'rawBlock');
      return await d.rawBlock(eid);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  /** GET /preset/blocks/:eid/cab — cab state for the IR picker. A well-formed eid that is not a cab
   *  block is left to the driver's `{error:'not a cab block'}` (absent-as-a-cab, not malformed). */
  const cabStateH = async (reply: StatusSink, eid: number) => {
    if (!isEid(eid)) { reply.code(400); return { error: 'eid must be an integer 0..16383' }; }
    const d = await driver();
    if (!d.cabState) return unsupported(reply, 'cabState');
    return d.cabState(eid);
  };
  /** POST /preset/blocks/:eid/read — per-pid read of an effect's parameter values, NORMALIZED 0..1.
   *  The driver routes this through the sub-0x1a range op (the plain 01 00 per-pid GET is dead on fw13
   *  — it answers a canned template that decodes to the denormal 2.085e-41, i.e. 0.0000). A pid the
   *  device cannot answer is omitted, never fabricated; a driver failure is a 503. */
  const readParamsH = async (reply: StatusSink, eid: number, pids?: number[] | null) => {
    if (!isEid(eid)) { reply.code(400); return { error: 'eid must be an integer 0..16383' }; }
    if (pids != null && !isPidList(pids)) { reply.code(400); return { error: 'pids must be an array of integers 0..16383' }; }
    try {
      const d = await driver();
      if (!d.readParams) return unsupported(reply, 'readParams');
      return await d.readParams(eid, pids ?? []);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  /** POST /preset/blocks/:eid/readrange — sub 0x1a range-read returning the normalized value per pid. */
  const readRangeH = async (reply: StatusSink, eid: number, pids?: number[] | null) => {
    if (!isEid(eid)) { reply.code(400); return { error: 'eid must be an integer 0..16383' }; }
    if (pids != null && !isPidList(pids)) { reply.code(400); return { error: 'pids must be an array of integers 0..16383' }; }
    try {
      const d = await driver();
      if (!d.readRange) return unsupported(reply, 'readRange');
      return await d.readRange(eid, pids ?? []);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  /** GET /presets/:n/summary — non-disruptive decode of one stored slot. A malformed :n is 400; a
   *  well-formed-but-empty slot is left to the driver's own dump failure (503). */
  const presetSummaryH = async (reply: StatusSink, n: number, full: boolean) => {
    if (!isPresetNumber(n)) { reply.code(400); return { error: 'preset number must be an integer 0..16383' }; }
    try {
      const d = await driver();
      if (!d.presetSummary) return unsupported(reply, 'presetDump');
      return await d.presetSummary(n, full);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  /** GET /presets/:n/params — full per-block decoded params for one slot. */
  const presetParamsH = async (reply: StatusSink, n: number) => {
    if (!isPresetNumber(n)) { reply.code(400); return { error: 'preset number must be an integer 0..16383' }; }
    try {
      const d = await driver();
      if (!d.presetParams) return unsupported(reply, 'presetDump');
      return { blocks: await d.presetParams(n) };
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  // Query-string reads: an ADDRESSED eid query (integer 0..16383) — garbage → 400 rather than silently
  // widening/altering the read. An ABSENT/empty eid keeps its documented "no filter" meaning.
  const liveMonitorsH = async (reply: StatusSink, rawEid?: RawQuery) => {
    const q = singleQuery(reply, 'eid', rawEid);
    if (!q.ok) return q.body;
    let eid: number | undefined;
    if (q.value != null && q.value !== '') {
      const n = Number(q.value);
      if (!isEid(n)) { reply.code(400); return { error: 'eid must be an integer 0..16383' }; }
      eid = n;
    }
    try {
      const d = await driver();
      if (!d.liveMonitors) return unsupported(reply, 'liveMonitors');
      return await d.liveMonitors(eid);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  const looperTelemetryH = async (reply: StatusSink, rawEid?: RawQuery) => {
    const q = singleQuery(reply, 'eid', rawEid);
    if (!q.ok) return q.body;
    const eid = q.value != null && q.value !== '' ? Number(q.value) : NaN;
    if (!isEid(eid)) { reply.code(400); return { error: 'eid required (integer 0..16383)' }; }
    try {
      const d = await driver();
      if (!d.looperTelemetry) return unsupported(reply, 'looperTelemetry');
      return await d.looperTelemetry(eid);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  // GET /fc/state?layout&view&switch — FC current-switch state (fcReadState, sub-0x1b value channel).
  // The three axes address one FC config as `layout*configsPerLayout + view*switches + sw`. A MALFORMED
  // axis is 400 BEFORE driver(): `Number('abc')` → NaN makes the driver's computed config NaN, which its
  // `enc14` then encodes as `[0,0]` (JS bitwise ops on NaN → 0) — reading pid 0 for EVERY field with a
  // silent 200 (the same silent-misread class as the read routes; the driver now also throws as a
  // backstop). A non-integer/negative is the same class, and an axis past the model's own geometry
  // ALIASES another switch (view*switches wraps into the next layout), so it is malformed too, not merely
  // absent. Bound each axis to the device's declared FC geometry when the profile carries it (FM3:
  // 9 layouts × 4 views × 3 switches); an axis the model does not declare is only integer/non-negative
  // checked, so we reject what we can prove and never guess a maximum we cannot.
  const fcStateH = async (reply: StatusSink, rawLayout?: RawQuery, rawView?: RawQuery, rawSwitch?: RawQuery) => {
    // A repeated axis (`?layout=0&layout=1`) is ambiguous → 400 naming that axis, on BOTH surfaces.
    const lq = singleQuery(reply, 'layout', rawLayout);
    if (!lq.ok) return lq.body;
    const vq = singleQuery(reply, 'view', rawView);
    if (!vq.ok) return vq.body;
    const sq = singleQuery(reply, 'switch', rawSwitch);
    if (!sq.ok) return sq.body;
    const axis = (raw?: string): number => (raw == null || raw === '' ? 0 : Number(raw));
    const layout = axis(lq.value);
    const view = axis(vq.value);
    const sw = axis(sq.value);
    if (!Number.isInteger(layout) || layout < 0 || !Number.isInteger(view) || view < 0
      || !Number.isInteger(sw) || sw < 0) {
      reply.code(400);
      return { error: 'layout, view and switch must be non-negative integers' };
    }
    const m = registry.profile.fcModel;
    if (m && ((m.layouts != null && layout >= m.layouts) || (m.views != null && view >= m.views)
      || (m.switches != null && sw >= m.switches))) {
      reply.code(400);
      return { error: `layout/view/switch out of range for this device (layout ${layout}/${m.layouts ?? '?'}, view ${view}/${m.views ?? '?'}, switch ${sw}/${m.switches ?? '?'})` };
    }
    try {
      const d = await driver();
      if (!d.fcReadState) return unsupported(reply, 'fcLiveRead');
      return await d.fcReadState(layout, view, sw);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  // Unified param write: {value, continuous}. continuous:true → the driver's normalized write
  // (gen-3 continuous SET; AM4 SET_NORM with value as 0..1), continuous:false → discrete ordinal.
  //
  // `continuous` is REQUIRED at this boundary and FAILS CLOSED: omitting it is a 400, never a guess.
  // The two opcodes carry DIFFERENT units — continuous takes the client's NORMALIZED 0..1 (raw 0.25 →
  // 25%), discrete takes PERCENT/ordinal (raw 40 → 40%) — so an omitted flag has NO safe default: a
  // direct caller sending `{value:1}` for a knob at maximum silently got 1% via the old `?? false`,
  // while the Axis client's own helper defaulted the SAME omission to `continuous:true` (→ 100%). The
  // two sides of the wire disagreed on what an omission MEANS. Forcing the caller to state it removes
  // the ambiguity. THIS IS AN INTENTIONAL API CHANGE (W2.4): every in-tree caller was checked and the
  // Axis client always sends the field; test helpers that pinned the old `?? false` default are updated.
  const setParamH = async (reply: StatusSink, addr: number, paramId: number, value: number, continuous: boolean | undefined) => {
    if (typeof continuous !== 'boolean') {
      reply.code(400);
      return { error: 'continuous is required: send continuous:true for a normalized 0..1 knob value, or continuous:false for a discrete ordinal/percent value (an omitted flag is ambiguous — it selected opposite units on the two sides of the wire)' };
    }
    // 400 (not an unhandled 500) on a non-integer/out-of-range address or param id — the codec's
    // encode14 throws on these, so a bad route param must be mapped to Bad Request at the seam.
    if (!Number.isInteger(addr) || addr < 0 || addr > 0x3fff || !Number.isInteger(paramId) || paramId < 0 || paramId > 0x3fff) {
      reply.code(400);
      return { error: 'eid and paramId must be integers in 0..16383' };
    }
    // `value` is validated at the seam too. Unlike eid/paramId it is NOT caught downstream: the gen-3
    // codec encodes it as a 5-septet float32 and happily encodes NaN / a fraction / a huge ordinal into
    // a garbage frame (it does not throw), and the continuous path clamp01()s it — so a bad ordinal used
    // to reach the device as a malformed value with a 200. Require a finite number always; for a DISCRETE
    // write (continuous === false) require an integer read-roster ORDINAL in the same 14-bit 0..16383
    // space as the effect/param ids (the file's convention). A continuous value stays any finite number
    // (the driver clamps it into 0..1).
    if (!Number.isFinite(value)) {
      reply.code(400);
      return { error: 'value must be a finite number' };
    }
    if (!continuous && (!Number.isInteger(value) || value < 0 || value > 0x3fff)) {
      reply.code(400);
      return { error: 'discrete value must be an integer ordinal in 0..16383 (send continuous:true for a normalized knob value)' };
    }
    const d = await driver();
    if (!d.setParam) return unsupported(reply, 'setParam');
    return d.setParam(addr, paramId, value, continuous);
  };
  // 400 (not a silent 200) on a garbage eid or a NON-BOOLEAN `bypassed`: the gen-3 codec's encode14
  // throws on a bad eid (→ unhandled 500 without this), and `bypassed ? 1 : 0` coerces ANY truthy value
  // to "bypassed" — so `{bypassed:"false"}` quietly ENGAGED the bypass with a 200 and a bad frame.
  const bypassH = async (reply: StatusSink, addr: number, bypassed: boolean) => {
    if (!isEid(addr) || typeof bypassed !== 'boolean') {
      reply.code(400);
      return { error: 'eid must be an integer 0..16383 and bypassed must be a boolean' };
    }
    const d = await driver();
    if (!d.setBypass) return unsupported(reply, 'setBypass');
    return d.setBypass(addr, bypassed);
  };
  // A non-integer scene index makes the codec's buildSetScene throw (→ 500); guard it to 400. An
  // in-range-but-unavailable integer is deliberately handed to the driver, whose documented reject
  // shape is `{ok:false}` at 200 (see api/write-safety) — that is an EXPLICIT reject, not a silent accept.
  const sceneSetH = async (reply: StatusSink, index: number) => {
    if (!Number.isInteger(index)) { reply.code(400); return { error: 'index must be an integer scene index' }; }
    const d = await driver();
    if (!d.setScene) return unsupported(reply, 'scenes');
    return d.setScene(index);
  };
  const presetSelectH = async (reply: StatusSink, number: number) => {
    // 400 (not an unhandled 500) on a missing/non-integer slot — the codec's encode14 guard throws on
    // anything outside 0..16383 (e.g. 20000), so validate at the seam before reaching the driver.
    if (!Number.isInteger(number) || number < 0 || number > 0x3fff) {
      reply.code(400);
      return { error: 'number required (integer 0..16383)' };
    }
    const d = await driver();
    if (!d.selectPreset) return unsupported(reply, 'selectPreset');
    const r = await d.selectPreset(number);
    // `code` is ADDITIVE: the AM4 reports its bank-letter location code (e.g. "C02"); gen-3 doesn't.
    return { ok: r.ok, number, ...(r.code != null ? { code: r.code } : {}) };
  };
  const presetStoreH = async (reply: StatusSink, number?: number) => {
    const d = await driver();
    if (!d.store) return unsupported(reply, 'supportsSave');
    // number omitted → store to the CURRENT slot (needs a live preset-number query).
    const n = number ?? (d.presetRef ? (await d.presetRef()).number : undefined);
    // integer 0..16383: the codec's buildStorePreset encode14 guard throws on a fraction or >16383
    // (a silent-accept / 500 without this seam check).
    if (n == null || !Number.isInteger(n) || n < 0 || n > EID_MAX) { reply.code(400); return { error: 'number required (integer 0..16383)' }; }
    return d.store(n); // gen-3: {ok}; AM4 additionally carries {location, code}
  };
  // Stored preset name: driver-backed where supported (AM4 → {number, name, code}); the gen-3
  // drivers don't implement it, so they keep the pre-Phase-6 {number, name:''} stub byte-identically.
  // A malformed :n (non-integer / out of the 14-bit slot space) is 400 — previously `Number('abc')`
  // became NaN and the gen-3 stub answered `{number:NaN,name:''}` with a 200 (a silent accept).
  const presetNameH = async (reply: StatusSink, n: number) => {
    if (!isPresetNumber(n)) { reply.code(400); return { error: 'preset number must be an integer 0..16383' }; }
    const d = await driver();
    if (d.storedPresetName) {
      try { return await d.storedPresetName(n); } catch { /* device unreachable → stub below */ }
    }
    return { number: n, name: '' };
  };
  const locationsH = async (reply: StatusSink) => {
    const d = await driver();
    if (!d.scanPresets) return unsupported(reply, 'presets.canScanNames');
    try {
      const r = await d.scanPresets();
      return { count: r.count, locations: r.presets };
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  const backupH = async (reply: StatusSink, location?: number) => {
    const d = await driver();
    if (!d.backupPreset) return unsupported(reply, 'backupDump');
    if (location != null && !isEid(location)) { reply.code(400); return { error: 'location must be an integer 0..16383' }; }
    try { return await d.backupPreset(location); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  const restoreH = async (reply: StatusSink, bytes?: number[]) => {
    if (!Array.isArray(bytes) || !bytes.length) { reply.code(400); return { error: 'bytes[] of one preset dump required' }; }
    // Uint8Array.from would SILENTLY wrap/clamp out-of-byte or fractional elements — reject them so a
    // malformed body can't become a mis-framed dump the device half-accepts.
    if (!bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 0xff)) { reply.code(400); return { error: 'bytes[] elements must be integers 0..255' }; }
    const d = await driver();
    if (!d.restorePreset) return unsupported(reply, 'restoreDump');
    try { return await d.restorePreset(bytes); } catch (e) { reply.code(400); return { error: (e as Error).message }; }
  };
  const fwValidateH = async (reply: StatusSink, bytes?: number[]) => {
    if (!Array.isArray(bytes) || !bytes.length) { reply.code(400); return { error: 'bytes[] of a firmware .syx required' }; }
    if (!bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 0xff)) { reply.code(400); return { error: 'bytes[] elements must be integers 0..255' }; }
    const d = await driver();
    if (!d.validateFirmware) return unsupported(reply, 'firmwareValidate');
    return d.validateFirmware(bytes);
  };
  const deviceParamH = async (reply: StatusSink, key?: string, value?: number) => {
    // key must be a non-empty string and value a FINITE number — a NaN/Infinity value was previously
    // passed straight to the driver's encoder (silent accept); the AM4 continuous path clamps NaN to 0.
    if (!key || typeof key !== 'string' || value == null || typeof value !== 'number' || !Number.isFinite(value)) {
      reply.code(400); return { error: 'key (non-empty string) + finite numeric value required' };
    }
    const d = await driver();
    if (!d.setParamByKey) return unsupported(reply, 'deviceParams');
    try { return await d.setParamByKey(key, value); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  const modModelH = async () => {
    const d = await driver();
    return d.modifierModel ? d.modifierModel() : null;
  };
  // Telemetry cadence-mode control (registry-level, no driver needed). GET serves the current mode +
  // its resolved cadence + the mode list; PUT switches the mode (400 on an unknown value) and the
  // setter emits a `telemetryConfig` event so every live UI reflects it.
  const telemetryConfigH = () => registry.getTelemetryConfig();
  const telemetrySetH = (reply: StatusSink, mode?: string) => {
    if (mode == null || !registry.telemetryModes().includes(mode as never)) {
      reply.code(400);
      return { error: 'unknown mode', modes: registry.telemetryModes() };
    }
    return registry.setTelemetryMode(mode);
  };
  // Offline preset decode with model-byte dispatch: sniff frame[4] of the first F0 frame. 0x15 →
  // the AM4 offline decoder (works whatever unit is attached — decode touches no transport);
  // anything else → the active driver's gen-3 decode, byte-identical to the pre-Phase-6 behavior.
  const decodeH = async (reply: StatusSink, bytes: Uint8Array) => {
    const f0 = bytes.indexOf(0xf0);
    const model = f0 >= 0 ? bytes[f0 + 4] : undefined;
    if (model === 0x15) {
      try { return { model: 'am4', ...registry.am4().decodeSyx([...bytes]) }; }
      catch (e) { reply.code(400); return { error: (e as Error).message }; }
    }
    const d = await driver();
    if (!d.decodePresetBytes) return unsupported(reply, 'presetDump');
    try { return d.decodePresetBytes(bytes); } catch (e) { reply.code(422); return { error: (e as Error).message }; }
  };
  // Same model-byte dispatch as decodeH, but THROWING instead of reply-coding — for callers that
  // decode many files in one request (the local Presets/ scan) and must not touch the route reply.
  const decodeBytes = async (bytes: Uint8Array): Promise<Record<string, unknown>> => {
    const f0 = bytes.indexOf(0xf0);
    const model = f0 >= 0 ? bytes[f0 + 4] : undefined;
    if (model === 0x15) return { model: 'am4', ...registry.am4().decodeSyx([...bytes]) } as Record<string, unknown>;
    const d = await driver();
    if (!d.decodePresetBytes) throw new Error('unsupported: presetDump');
    return d.decodePresetBytes(bytes) as Record<string, unknown>;
  };

  // ── the rest of the write seam: channel / type / grid edit / scene-rename / preset-rename / tempo /
  //    modifier-bind. Same reasoning as bypassH/setParamH: validate at the seam so a garbage input is a
  //    400 on BOTH surfaces, never a silent 200 (the driver's encoder accepts any number into a frame)
  //    and never an unhandled 500 (the codec's guards throw). ──────────────────────────────────────
  const channelH = async (reply: StatusSink, eid: number, channel: string) => {
    // gen-3's setChannel calls `channel.toUpperCase()` (throws a 500 on a non-string) and the codec
    // throws on a bad eid; an unknown LETTER returns {ok:false} but a non-letter crashed instead.
    if (!isEid(eid) || typeof channel !== 'string' || !/^[a-dA-D]$/.test(channel)) {
      reply.code(400);
      return { error: 'eid must be an integer 0..16383 and channel must be A, B, C or D' };
    }
    const d = await driver();
    if (!d.setChannel) return unsupported(reply, 'channels');
    return d.setChannel(eid, channel);
  };
  const typeH = async (reply: StatusSink, eid: number, value: number) => {
    // The type ordinal rides a float-valued SET: the codec encodes ANY value (a fraction, NaN) without
    // throwing → a silent 200 with a bad frame. Require the read-roster ORDINAL the file's convention
    // uses (integer 0..16383, same space as the effect/param ids).
    if (!isEid(eid) || !isEid(value)) {
      reply.code(400);
      return { error: 'eid and value must be integers in 0..16383' };
    }
    const d = await driver();
    if (!d.setType) return unsupported(reply, 'setType');
    return d.setType(eid, value);
  };
  const gridCellH = async (reply: StatusSink, row: number, col: number, blockId: number) => {
    const d = await driver();
    const { rows, cols } = gridShape(d.capabilities);
    // bound to THIS device's grid shape (the codec's backstop is the III's 6×14 — an FM3 col of 13
    // would pass it and encode a gridPos outside the unit's own grid).
    if (!Number.isInteger(row) || row < 1 || row > rows || !Number.isInteger(col) || col < 1 || col > cols
      || !Number.isInteger(blockId) || blockId < 0 || blockId > EID_MAX) {
      reply.code(400);
      return { error: `row/col must be integers in 1..${rows} / 1..${cols} and blockId an integer 0..16383` };
    }
    if (!d.placeCell) return unsupported(reply, 'gridEdit');
    return d.placeCell(row, col, blockId);
  };
  const gridCableH = async (reply: StatusSink, srcRow: number, srcCol: number, destRow: number, connect: boolean) => {
    const d = await driver();
    const { rows, cols } = gridShape(d.capabilities);
    // the dest column is implicit (srcCol + 1), so srcCol must leave room for it.
    if (!Number.isInteger(srcRow) || srcRow < 1 || srcRow > rows
      || !Number.isInteger(srcCol) || srcCol < 1 || srcCol > cols - 1
      || !Number.isInteger(destRow) || destRow < 1 || destRow > rows
      || typeof connect !== 'boolean') {
      reply.code(400);
      return { error: `srcRow/destRow must be integers 1..${rows}, srcCol an integer 1..${cols - 1}, connect a boolean` };
    }
    if (!d.cable) return unsupported(reply, 'gridEdit');
    return d.cable(srcRow, srcCol, destRow, connect);
  };
  const gridSelectH = async (reply: StatusSink, row: number, col: number) => {
    const d = await driver();
    const { rows, cols } = gridShape(d.capabilities);
    if (!Number.isInteger(row) || row < 1 || row > rows || !Number.isInteger(col) || col < 1 || col > cols) {
      reply.code(400);
      return { error: `row/col must be integers in 1..${rows} / 1..${cols}` };
    }
    if (!d.selectCell) return unsupported(reply, 'gridEdit');
    return d.selectCell(row, col);
  };
  const tempoH = async (reply: StatusSink, bpm: number) => {
    // setTempo packs the bpm as a float32 — a non-finite/garbage bpm encoded silently into a tempo
    // frame with a 200 {ok:true} (the P5 lesson verbatim).
    if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm <= 0 || bpm > 1000) {
      reply.code(400);
      return { error: 'bpm must be a finite number in (0, 1000]' };
    }
    const d = await driver();
    if (!d.setTempo) return unsupported(reply, 'setTempo');
    return d.setTempo(bpm);
  };
  const sceneNameH = async (reply: StatusSink, index: number, name: string) => {
    if (!Number.isInteger(index) || typeof name !== 'string') {
      reply.code(400);
      return { error: 'index must be an integer and name a string' };
    }
    const d = await driver();
    if (!d.setSceneName) return unsupported(reply, 'scenes');
    return d.setSceneName(index, name);
  };
  const presetRenameH = async (reply: StatusSink, name: string) => {
    if (typeof name !== 'string') { reply.code(400); return { error: 'name must be a string' }; }
    const d = await driver();
    if (!d.setPresetName) return unsupported(reply, 'setPresetName');
    return d.setPresetName(name);
  };
  const modBindH = async (reply: StatusSink, b?: { slot?: number; targetEffectId?: number; targetParam?: number; source?: number }) => {
    const { slot, targetEffectId, targetParam, source } = b ?? {};
    // previously only a null-presence check: a non-integer slot flowed into Math.floor()→NaN and the
    // encoder; target ids were unvalidated. Slot is 1-based (see gen-3 bindModifier).
    if (!Number.isInteger(slot) || (slot as number) < 1
      || !isEid(targetEffectId) || !isEid(targetParam)
      || !Number.isInteger(source) || (source as number) < 0) {
      reply.code(400);
      return { ok: false, error: 'slot (integer >=1), targetEffectId, targetParam (integers 0..16383), source (integer >=0) required' };
    }
    const d = await driver();
    if (!d.bindModifier) return unsupported(reply, 'modifiers.bind');
    try { return await d.bindModifier(slot as number, targetEffectId as number, targetParam as number, source as number); }
    catch (e) { reply.code(503); return { ok: false, error: (e as Error).message }; }
  };

  /** Per-preset PERFORMANCE PAGE of the CURRENT edit buffer (§2.2) — READ-ONLY, one preset dump.
   *  Capability-gated (a device without `performPage` answers 501 unsupported). A dump/decode failure
   *  is surfaced as 503 with the real message, never a fabricated empty page. */
  const performPageH = async (reply: StatusSink) => {
    const d = await driver();
    if (!d.performPage) return unsupported(reply, 'performPage');
    // undefined (no page in the body) is coerced to null so BOTH surfaces answer a JSON body
    // (`null`), never an empty payload a client would fail to parse.
    try { return (await d.performPage()) ?? null; }
    catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };

  /** Write ONE slot of the CURRENT edit buffer's per-preset PERFORMANCE PAGE (§2.2) — the WRITE side.
   *  Capability-gated. `slot` is 1..10 and at least one patch field is required; a patch the driver
   *  could not confirm by read-back comes back as the driver's `{ok:false, reason}` — the route never
   *  reports a write as successful on anything weaker than a read-back. */
  const performSlotH = async (reply: StatusSink, slot: number, b?: PerformSlotPatch) => {
    if (!Number.isInteger(slot) || slot < 1 || slot > PERFORM_SLOT_COUNT) {
      reply.code(400); return { ok: false, error: `slot must be an integer 1..${PERFORM_SLOT_COUNT}` };
    }
    const p: PerformSlotPatch = b ?? {};
    if (p.effectId === undefined && p.paramId === undefined && p.effectLabel === undefined && p.paramLabel === undefined) {
      reply.code(400); return { ok: false, error: 'at least one of effectId, paramId, effectLabel, paramLabel is required' };
    }
    // ids are effect/param ids shared with every other route's guard; labels must be strings (the codec
    // truncates them to the 32-byte window, it does not resize it).
    if ((p.effectId !== undefined && !isEid(p.effectId)) || (p.paramId !== undefined && !isEid(p.paramId))) {
      reply.code(400); return { ok: false, error: 'effectId/paramId must be integers 0..16383' };
    }
    if ((p.effectLabel !== undefined && typeof p.effectLabel !== 'string') || (p.paramLabel !== undefined && typeof p.paramLabel !== 'string')) {
      reply.code(400); return { ok: false, error: 'effectLabel/paramLabel must be strings' };
    }
    const d = await driver();
    if (!d.setPerformSlot) return unsupported(reply, 'setPerformSlot');
    try { return await d.setPerformSlot(slot, p); }
    catch (e) { reply.code(503); return { ok: false, error: (e as Error).message }; }
  };

  return {
    driver, unsupported, decodeFail,
    gridH, blocksH, sceneStateH, blockParamsH, setParamH, bypassH, sceneSetH,
    rawBlockH, cabStateH, readParamsH, readRangeH, presetSummaryH, presetParamsH,
    liveMonitorsH, looperTelemetryH, fcStateH,
    presetSelectH, presetStoreH, presetNameH, locationsH,
    backupH, restoreH, fwValidateH, deviceParamH, modModelH,
    telemetryConfigH, telemetrySetH,
    channelH, typeH, gridCellH, gridCableH, gridSelectH, tempoH, sceneNameH, presetRenameH, modBindH,
    decodeH, decodeBytes, performPageH, performSlotH
  };
}
