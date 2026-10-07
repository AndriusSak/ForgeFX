// Unified route handlers — the NON-TRIVIAL handler bodies shared verbatim by the Fastify app
// (app.ts, including its deprecated /am4/* aliases) and the browser-facing runtime router
// (runtime/router.ts). Each handler resolves the ACTIVE per-device driver from the registry and
// capability-gates optional driver methods: a device that can't do something answers
// `501 {error:'unsupported', capability}` instead of firing another model's frames at it. Handlers
// signal the HTTP status through the minimal StatusSink seam (FastifyReply satisfies it structurally;
// the router uses a tiny status recorder), so the exact same code produces the exact same
// status+body on both surfaces. NO node:/fastify imports — this module must load in a browser.
import type { DeviceRegistry } from '../drivers/registryCore.js';

/** The one reply capability the shared handlers need: set the response status. FastifyReply's
 *  `code()` matches; the runtime router records the status into its RouterResponse. */
export interface StatusSink { code(statusCode: number): unknown }

export function createUnifiedHandlers(registry: DeviceRegistry) {
  const driver = () => registry.driver();

  // ── write-input seam guards (shared by BOTH surfaces) ─────────────────────────────────────────
  // The class this closes: a garbage route input must answer 400, NOT (a) an unhandled 500 from a
  // codec encode14 throw, and NOT (b) a SILENT 200 where the codec happily encodes the bad value into
  // a frame the device accepts (the P5 lesson — e.g. a float-valued SET encodes NaN without throwing).
  const EID_MAX = 0x3fff;
  /** A gen-3 effect/param/block id: an integer in the codec's 14-bit 0..16383 space. */
  const isEid = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= EID_MAX;
  /** The device's routed grid shape: its declared `grid`, the AM4's 1×slotCount linear chain, else the
   *  codec's 14-wide / 6-row ceiling. Used to bound row/col BEFORE the codec (which would 500 on them). */
  const gridShape = (caps: { grid?: { rows: number; cols: number }; slotModel?: string; slotCount?: number }) =>
    caps.grid ?? (caps.slotModel === 'linear' ? { rows: 1, cols: caps.slotCount ?? 4 } : { rows: 6, cols: 14 });

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
  // Unified param write: {value, continuous}. continuous:true → the driver's normalized write
  // (gen-3 continuous SET; AM4 SET_NORM with value as 0..1), continuous:false → discrete ordinal.
  const setParamH = async (reply: StatusSink, addr: number, paramId: number, value: number, continuous: boolean) => {
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
  const presetNameH = async (n: number) => {
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

  return {
    driver, unsupported, decodeFail,
    gridH, blocksH, sceneStateH, blockParamsH, setParamH, bypassH, sceneSetH,
    presetSelectH, presetStoreH, presetNameH, locationsH,
    backupH, restoreH, fwValidateH, deviceParamH, modModelH,
    telemetryConfigH, telemetrySetH,
    channelH, typeH, gridCellH, gridCableH, gridSelectH, tempoH, sceneNameH, presetRenameH, modBindH,
    decodeH, decodeBytes
  };
}
