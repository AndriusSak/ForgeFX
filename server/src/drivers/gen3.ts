// Gen-3 device driver (Axe-Fx III / FM3 / FM9) — the shared grid codec driven through a per-device
// profile. Wire protocol + catalog/params/rosters/enums/cab-IRs all via forgefx-midi. One driver
// instance per model byte; EVERY frame is built by a codec bound to that byte
// (createModernFractalCodec), so nothing here can fall back to a defaulted model.
import {
  createModernFractalCodec,
  buildSetTempoViaParam,
  resolveEnumValues,
  ROUTING_OP_CONNECT,
  ROUTING_OP_DISCONNECT,
  buildBlockMonitorPoll,
  isBlockMonitorResponse,
  parseBlockMonitorNorm,
  parseOutputMeterRms,
  meterRmsToDb,
  buildLooperWaveformPoll,
  isLooperWaveformResponse,
  parseLooperWaveform,
  buildLooperControl,
  type ModernFractalCodec
} from 'forgefx-midi/gen3/axe-fx-iii';
import { wireToDisplay } from 'forgefx-midi/shared';
import {
  parsePresetDump, decodeRawPatch, decodeGen3Body,
  readBlockParamsForModel, modelsFromBlocks,
  effectRoster, blockRefForEid, slugForEffectId, blockInstances,
  retargetPresetDumpToEditBuffer,
  parseCabIrSyx, buildCabIrSyx, interpretCabIrAcks,
  buildCabSlotQuery, parseCabSlotState,
  CAB_IR_PAGE_SCRATCHPAD, CAB_IR_FN_DATA, CAB_IR_PAGE_USER_BANKS,
  CAB_IR_FN_END, CAB_IR_CLOSE_ACCEPTED, CAB_IR_CLOSE_MISMATCH, computeCabIrClosePayload,
  buildBlankCabIrContainer,
  type DecodedBlock, type Gen3Modifier
} from 'forgefx-midi/devices/gen3';
import { SLUG_FAMILY, resolvePseudoParamControls, KNOB_UNITS, type ServedParamRef, type DeviceProfile, type TypeModel, type DeviceLayout, type SelectorValues } from '../devices.js';
import { ENV } from './env.js';
import type {
  DeviceDriver, DriverCapabilities, DriverCtx,
  PresetGridDTO, PresetBlockDTO, PresetSummary, NamedParam, EnumParam, MeterVal,
  FcSwitchState, FcReadState, PresetModifier,
  CabIrUploadOptions, CabIrUploadResult,
  CabSlotQueryOptions, CabSlotStateResult, CabSlotClearResult
} from './types.js';

/** How long to keep listening for the device's frame-by-frame acks to an IR upload.
 *  Measured: the editor's own upload was acked within ~2 ms per frame, so this is generous. */
const ACK_WINDOW_MS = 1500;

/** Count the data frames in a built container (for the ack expectation). */
function countDataFrames(bytes: readonly number[]): number {
  let n = 0;
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] !== 0xf0) continue;
    const end = bytes.indexOf(0xf7, i);
    if (end < 0) break;
    if (bytes[i + 5] === CAB_IR_FN_DATA) n++;
    i = end;
  }
  return n;
}

/** Cap on a single `queryCabSlots` sweep. A user bank is 128 slots (one request each); the cap keeps a
 *  route call from turning into an unbounded device conversation. */
const MAX_CAB_SLOT_SWEEP = 128;

/** Per-query wait for a slot-state reply. The unit answers within a few ms (the editor's own refresh
 *  is acked ~2 ms per frame), so the settle window dominates the cost of a sweep: measured 8.0 s for
 *  128 slots at `quietMs: 60` — a full user bank would then take 32 s and outlive the client's 12 s
 *  request ceiling. These values keep one 128-slot call well inside that ceiling. */
const CAB_SLOT_QUERY_OPTS = { timeoutMs: 400, quietMs: 15 } as const;

// slug → { name, page=base effect id } from the authoritative codec base table (replaces the old
// defs.js pack lookup; block names + base ids are codec facts, not editor-cache definitions).
const BLOCK_META: Record<string, { name: string; page: number }> = (() => {
  const out: Record<string, { name: string; page: number }> = {};
  for (const e of effectRoster()) out[e.slug] = { name: e.name, page: e.page };
  return out;
})();

const EDIT_BUFFER = 0x3fff; // preset number sentinel = current edit buffer

// ── preset-dump decode (forgefx-midi devices/gen3 pipeline) ──
// Adapter producing the exact DTO the pre-Phase-4 server-local codec (fm3PresetGrid.ts
// decodePresetDump) returned — field-level parity was proven over 429 real FM3 dumps
// (scripts/diff-decoders.ts, Phase 2). The JSON shapes downstream are the HTTP contract
// Axis consumes and must not drift.

/** The old decodePresetDump DTO, byte-identical on the HTTP surface. */
interface DecodedDumpDTO {
  modelId: number;
  modelName: string;
  name: string;
  crcValid: boolean;
  /** Stored CRC16 of the preset body — a content fingerprint (changes when the preset changes). */
  crc: number;
  rows: number;
  cols: number;
  grid: { effectId: number; row: number; col: number; routeFlag: number; name: string; isShunt: boolean; fromRows: number[] }[];
  sceneNames: string[];
}
/** Decoded dump: the DTO plus the decompressed body (per-block param decode source). */
interface DecodedDump {
  dump: DecodedDumpDTO;
  body: Uint8Array;
  decompSize: number;
  /** Modifier assignments the codec decoded from the body (source/target name/param/origin). */
  modifiers: Gen3Modifier[];
}

/** Keep only the dump frames (0x77 header / 0x78 chunks / 0x79 footer) and flatten to the byte
 *  stream the package parser takes. The live request window can interleave unrelated frames
 *  (beacons, other replies) that the strict frame-walking parser would reject; the old decoder
 *  skipped them the same way. */
function dumpBytesFromFrames(frames: readonly (readonly number[])[]): Uint8Array {
  const keep: number[] = [];
  for (const f of frames) {
    if (f.length < 8 || f[0] !== 0xf0 || f[1] !== 0x00 || f[2] !== 0x01 || f[3] !== 0x74) continue;
    const fn = f[5];
    if (fn === 0x77 || fn === 0x78 || fn === 0x79) keep.push(...f);
  }
  return Uint8Array.from(keep);
}

/** Float32 from the 5×7-bit septets a per-pid read carries at body bytes 12-16.
 *
 *  Returns `null` for anything that could not be a real param value: non-finite, or a SUBNORMAL
 *  (`0 < |v| < 2^-126`). On FM3 firmware 13.0 the plain per-pid GET (fn 0x01 sub `01 00`) answers
 *  EVERY request — a virtual GLOBAL eid and a real block alike — with the same canned compiled-record
 *  template (identical bytes bar the echoed address in 8-11 and the checksum). Its value field is the
 *  constant septets `20 74 00 00 00`, which decode to the denormal 2.0851321149153278e-41; printed at
 *  four places that reads as `0.0000`, and a caller took it for the original value and "restored"
 *  it, turning the user's footswitch LED rings off (docs/decisions/0004, 0005). A subnormal is never
 *  a param value, so it is refused here rather than served. A genuine wire 0.0 is NOT subnormal and
 *  passes through — the guard must not mistrust a real read of zero. */
function paramF32FromSeptets(b: number[]): number | null {
  const v = (((b[0] ?? 0) | ((b[1] ?? 0) << 7) | ((b[2] ?? 0) << 14) | ((b[3] ?? 0) << 21) | ((b[4] ?? 0) << 28)) >>> 0);
  const f = new Float32Array(new Uint32Array([v]).buffer)[0]!;
  if (!Number.isFinite(f)) return null;
  if (f !== 0 && Math.abs(f) < 2 ** -126) return null; // subnormal — the canned-template signature
  return f;
}

// Pre-chain modifier table geometry — MUST mirror forgefx-midi/src/devices/gen3/presetBody.ts
// (extractPreChainModifiers). Used only to recover each decoded modifier's 1-based slot; if the codec's
// offsets ever move, the modifier-readback suite's cross-check fails loudly.
const MODIFIER_PRE_CHAIN_START = 0x240;
const MODIFIER_FIRST_WORD = 502;
const MODIFIER_ENTRY_SIZE = 48;
const MODIFIER_MAX_ENTRIES = 12;

/** Little-endian u16 read at a byte offset (0 when past the end). */
function u16(data: Uint8Array, off: number): number {
  return ((data[off] ?? 0) | ((data[off + 1] ?? 0) << 8)) & 0xffff;
}

/** Full dump decode via the package pipeline (parse → raw_patch/CRC/Huffman → structured body),
 *  mapped to the old server DTO. rows/cols/modelName come from the profile — the same values the
 *  old codec's DIMS dict held; the preset name is the raw_patch header ASCII at 0x08..0x28
 *  (NUL-stop, trimmed), exactly the old decoder's source. */
function decodeDump(frames: readonly (readonly number[])[], prof: DeviceProfile): DecodedDump {
  const parsed = parsePresetDump(dumpBytesFromFrames(frames), 0, prof.model);
  const raw = decodeRawPatch(parsed.chunkPayloads);
  const body3 = decodeGen3Body(raw.body, prof.model);
  let name = '';
  for (let i = 0x08; i < 0x28; i++) {
    const b = raw.rawPatch[i] ?? 0;
    if (b === 0) break;
    name += String.fromCharCode(b);
  }
  const grid = (body3.grid ?? []).map((c) => ({
    effectId: c.effect_id,
    row: c.row,
    col: c.col,
    routeFlag: c.route_flag,
    name: c.name,
    isShunt: c.is_shunt ?? false,
    fromRows: c.from_rows ?? []
  }));
  return {
    dump: {
      modelId: prof.model,
      modelName: prof.name,
      name: name.trim(),
      crcValid: raw.crcValid,
      crc: raw.storedCrc,
      rows: prof.rows,
      cols: prof.cols,
      grid,
      sceneNames: body3.scene_names ?? []
    },
    body: raw.body,
    decompSize: raw.decompSize,
    modifiers: body3.modifiers ?? []
  };
}

const CH_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

// catalog unit code → display label (blank = show the bare number)
const UNIT_LABEL: Record<string, string> = {
  db: 'dB', hz: 'Hz', ms: 'ms', seconds: 's', percent: '%', bipolar_percent: '%',
  degrees: '°', semitones: 'st', pf: 'pF', ratio: ':1'
};
// KNOB_UNITS (the musician-facing continuous-control unit allowlist) is the SINGLE source of truth,
// owned by devices.ts and imported above — NOT redefined here. It gates blockParams' `named` (knob)
// list AND devices.ts' Axe-Fx III float-vs-enum classifier; keeping two copies let them drift (a real
// unit present in one but not the other silently mis-branded controls). See the comment at its
// definition for WHY 'pf' must be included (the amp block's Bright Cap).
// Shared empty set for the optional layout-widget evidence maps (see DeviceProfile.layoutKnobIds).
const EMPTY_ID_SET: ReadonlySet<number> = new Set();
// Ceiling for an enum dropdown's option list — a guard against a bogus catalog row only. Real gen-3
// lists top out at 336 ordinals (Axe-Fx III amp type); the list is otherwise bounded by the param's
// device-true ordinal count, and a hard 128-cap used to silently truncate every longer list.
const MAX_ENUM_OPTIONS = 4096;

/** Append 1/2/3… to labels that repeat within a list (e.g. the cab's four "Low Cut" mic params),
 * so the UI can tell otherwise-identical controls apart. Mutates the items' `name`. */
function dedupeLabels(items: { name: string }[]): void {
  const total = new Map<string, number>();
  for (const it of items) total.set(it.name, (total.get(it.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const it of items) {
    if ((total.get(it.name) ?? 0) > 1) {
      const n = (seen.get(it.name) ?? 0) + 1;
      seen.set(it.name, n);
      it.name = `${it.name} ${n}`;
    }
  }
}
/** Friendly param label: the catalog displayLabel, else tidy the raw NAME (strip family prefix, _→space). */
function paramLabel(p: { displayLabel?: string; name: string }): string {
  return p.displayLabel ?? p.name.replace(/^[A-Z0-9]+_/, '').replace(/_/g, ' ');
}

class Gen3Driver implements DeviceDriver {
  #prof: DeviceProfile;
  #codec: ModernFractalCodec;
  #ctx: DriverCtx;
  readonly capabilities: DriverCapabilities;

  constructor(profile: DeviceProfile, ctx: DriverCtx) {
    this.#prof = profile;
    this.#codec = createModernFractalCodec(profile.model); // every frame carries THIS device's model byte
    this.#ctx = ctx;
    this.capabilities = {
      slotModel: 'grid',
      grid: { rows: profile.rows, cols: profile.cols },
      gridEdit: true,
      scenes: 8,
      channels: true,
      presetDump: true,
      presetConvert: true, // full gen-3 lift (routing grid + per-scene block state + amp knobs)
      blockParamDecode: profile.model === 0x11, // per-block body decode is FM3-only today
      telemetry: { tuner: true, outputMeters: true, cpu: true },
      fcModel: !!profile.fcModel,
      fcLiveRead: !!profile.fcModel?.liveState,
      modBind: !!profile.modModel,
      cabIrs: Object.keys(profile.cabIrs()).length > 0,
      editorLayouts: true, // FM3 / FM9 / Axe-Fx III all ship *_LAYOUTS (profile.layoutFor)
      supportsSave: true,
      // Live self-describe walk (fn 0x01 DEFINITION/ENUM-LABEL sweep) is HW-verified on the FM3 and
      // shares the gen-3 protocol on the FM9 / Axe-Fx III → the on-connect device-cache build is offered.
      selfDescribe: true,
      // Same buildCache path as the live walk → an official-editor .cache file can be imported too.
      cacheImport: true,
      // FULL-mode self-describe (write-sweep taper capture) is CaptureRig-proven on the trio the rig
      // sweeps: Axe-Fx III (0x10) / FM3 (0x11) / FM9 (0x12). Gated to those model bytes explicitly.
      fullCapture: profile.model === 0x10 || profile.model === 0x11 || profile.model === 0x12,
      // Device-edit reflection splits by whether the unit PUSHES front-panel edits:
      //  • FM9 / Axe-Fx III / VP4 push an unsolicited 0x74/0x75/0x76 burst → registry LISTENS (deviceEditPush).
      //  • FM3 (0x11) proven NOT to push (tap 2026-07-04: a front-panel knob emitted zero unsolicited
      //    frames) → registry POLLS the open block instead (deviceEditWatch → readDeviceEditState below),
      //    the same poll-fallback shape as the AM4. Disable in the field via FORGEFX_FM3_EDITSYNC=0.
      deviceEditPush: profile.model !== 0x11,
      deviceEditWatch: profile.model === 0x11 && ENV.FORGEFX_FM3_EDITSYNC !== '0'
    };
  }

  get modelId() { return this.#prof.model; }
  get key() { return this.#prof.key; }
  get name() { return this.#prof.name; }
  get profile() { return this.#prof; }

  /** Adopt a device-cache-derived runtime profile (device-true rosters / enum labels / ranges). The
   *  model byte is unchanged so the codec bound at construction stays valid; only the data the reads
   *  resolve through (#prof) is swapped. Idempotent — re-applying a fresh profile just replaces it. */
  applyRuntimeProfile(profile: DeviceProfile): void { this.#prof = profile; }

  #gridCache: { grid: PresetGridDTO; at: number } | null = null;
  #gridInflight: Promise<PresetGridDTO> | null = null;
  static GRID_TTL_MS = 500; // coalesce the grid()+presetBlocks() burst on a single load

  #conn() { return this.#ctx.transport(); }
  #emit: DriverCtx['emit'] = (e) => this.#ctx.emit(e);

  #channelSlice(
    family: string | undefined,
    bulk: { itemCount: number; values: readonly number[] },
    activeChannel: number,
  ): { stride: number; channelCount: number; base: number } {
    const tableStride = family ? this.#prof.rangeSections[family]?.stride : undefined;
    const stride = tableStride && tableStride > 0
      ? tableStride
      : (bulk.itemCount > 0 && bulk.itemCount % 4 === 0 ? bulk.itemCount / 4 : Math.max(1, bulk.values.length));
    const basis = bulk.itemCount > 0 ? bulk.itemCount : bulk.values.length;
    const channelCount = Math.max(1, Math.floor(basis / stride));
    return { stride, channelCount, base: Math.min(activeChannel, channelCount - 1) * stride };
  }

  /** Fire-and-forget write, serialized on the request chain (so it never injects mid-read). */
  async #send(bytes: number[]): Promise<{ ok: boolean }> {
    await (await this.#conn()).sendQueued(bytes);
    return { ok: true };
  }

  /** Write + watch a window for a 0x64 rejection. For structural ops where a reject matters.
   *
   *  Window = 250 ms, matched to forgefx-midi's writer (`writer.ts` sendAndWatchForError — the
   *  better-evidenced number): a SysEx round-trip is 30-60 ms, so the old 120 ms window could close
   *  before a genuine rejection arrived and report a rejected write as accepted. Since P1.1 the Axis
   *  client HONOURS `ok`, so that false "accepted" showed a successful save/value the device refused.
   *
   *  Which option actually gates the verdict (transport `#once`, src/transport/serial.ts): the promise
   *  resolves on (a) `match` — immediate, but `match` fires ONLY on a frame that would actually count
   *  as OUR rejection (`isOurReject`, by function byte — see below), so a FOREIGN-function 0x64 does
   *  NOT close the window early; (b) `quietMs` of silence after the last inbound frame; or (c) the
   *  `timeoutMs` hard cap. On ACCEPT the device is silent, so the quiet timer never starts and the
   *  write is declared accepted at `timeoutMs`; a stray inbound frame during the window (e.g. a
   *  foreign 0x64) starts the `quietMs` timer and the watch closes `quietMs` later, so our own late
   *  rejection can still land. So BOTH are set to the window: `timeoutMs` gates the
   *  silent-accept case, and `quietMs` stops an unrelated frame from cutting the watch short before a
   *  late rejection lands. `timeoutMs` caps the
   *  total wait at 250 ms in every case. Only this discrete-write confirmation path is widened — reads
   *  and the fire-and-forget `#send` path are untouched.
   *
   *  Attribution is by FUNCTION byte only: a 0x64 echoes `[echoedFn, resultCode]` and the wire carries
   *  no sub-action (write-protocol.md + parseMultipurposeResponse), so a rejection for one fn=0x01 op
   *  (setParam / setType / setSceneName / renamePreset / clearBlock / setGridCell / setGridRouting /
   *  switchPresetSysEx / store) is indistinguishable from another within the window. That residual is
   *  deliberately resolved CONSERVATIVELY — a matching-function 0x64 is treated as ours and reported
   *  {ok:false}, which errs toward "rejected" rather than a false "accepted". Count only a rejection
   *  that echoes THIS write's function, so a foreign-function 0x64 (a refused read, etc.) is not
   *  misattributed to this write. A 0x64 too short to carry an echoed function is treated as ours. */
  async #write(bytes: number[]): Promise<{ ok: boolean }> {
    const dev = await this.#conn();
    const fn = bytes[5];
    // ONE predicate for BOTH the early-exit `match` and the verdict. A frame counts as OUR rejection
    // iff it is a 0x64 that either echoes THIS write's function, or is too short to carry one (f[6]
    // undefined — conservative: absent an echoed function we cannot rule it out, so treat it as ours).
    // Using it in `match` too means the window closes early ONLY on a frame that would actually reject
    // us: a FOREIGN-function 0x64 (a refused read, etc.) leaves the window open on the `quietMs` timer,
    // so our own rejection arriving after it is still collected — before this fix a foreign 0x64 closed
    // the window immediately and a later genuine rejection was lost, reporting a refused write {ok:true}.
    const isOurReject = (f: number[]) => f[5] === 0x64 && (f[6] === undefined || f[6] === fn);
    const frames = await dev.request(bytes, { timeoutMs: 250, quietMs: 250, match: (fs) => fs.some(isOurReject) });
    const rejected = frames.some(isOurReject);
    return { ok: !rejected };
  }

  /** Current preset number + name (one query). */
  async presetRef(): Promise<{ number: number; name: string }> {
    const dev = await this.#conn();
    const frames = await dev.request(this.#codec.buildQueryPatchName('current'), {
      timeoutMs: dev.slow ? 4000 : 1200, // slow link: give the reply time to arrive (match returns early)
      match: (fs) => fs.some((f) => this.#codec.isQueryPatchNameResponse(f))
    });
    const f = frames.find((x) => this.#codec.isQueryPatchNameResponse(x));
    if (!f) return { number: -1, name: '' };
    const r = this.#codec.parseQueryPatchNameResponse(f);
    return { number: r.presetNumber, name: r.name };
  }

  /** Routing grid via the hardware-validated dump decoder. Deduped + short-TTL cached. */
  async grid(): Promise<PresetGridDTO> {
    if (this.#gridInflight) return this.#gridInflight; // coalesce concurrent callers
    if (this.#gridCache && Date.now() - this.#gridCache.at < Gen3Driver.GRID_TTL_MS) return this.#gridCache.grid;
    this.#gridInflight = this.#dumpGrid();
    try {
      const g = await this.#gridInflight;
      this.#gridCache = { grid: g, at: Date.now() };
      return g;
    } finally {
      this.#gridInflight = null;
    }
  }

  /** Read a preset dump, retrying when it arrives incomplete. On Windows USB-MIDI a big multi-packet
   *  dump (Axe-Fx III presets ≈ 18 frames / 32 KB) intermittently drops its 0x78 payload chunks between
   *  the 0x77 header and the 0x79 terminator → "no 0x78 chunks found". A re-read almost always succeeds. */
  async #dumpFrames(target: number): Promise<number[][]> {
    const dev = await this.#conn();
    // A slow link (5-pin MIDI) transfers each ~3082B dump chunk in ~1s, so a multi-chunk preset dump takes
    // several seconds with ~1s gaps between chunks. The USB-tuned windows (5s / 180ms quiet) give up mid
    // dump. Widen them so the transfer completes; the 0x79-terminator `match` still returns the instant the
    // dump is whole, so a fast link isn't slowed.
    const slow = dev.slow;
    let frames: number[][] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      frames = await dev.request(this.#codec.buildRequestPresetDump(target), {
        timeoutMs: slow ? 25000 : 5000,
        quietMs: slow ? 1500 : 180,
        match: (fs) => fs.some((f) => f[5] === 0x79) // 0x79 = dump terminator
      });
      const ok = frames.some((f) => f[5] === 0x78) && frames.some((f) => f[5] === 0x79);
      if (ok) return frames;
      console.log(`[forgefx] presetDump: incomplete attempt ${attempt}/3 (frames=${frames.length}, 0x78=${frames.some((f) => f[5] === 0x78)}, 0x79=${frames.some((f) => f[5] === 0x79)}) — retrying`);
    }
    return frames; // still incomplete → let decodePresetDump throw its clear error
  }

  async #dumpGrid(): Promise<PresetGridDTO> {
    const frames = await this.#dumpFrames(EDIT_BUFFER);
    // diagnostic: did the dump arrive? (Windows MIDI large-SysEx debugging) — frame count, the function
    // bytes seen, total bytes, and whether the 0x79 terminator came through.
    const fns = [...new Set(frames.map((f) => f[5]))].map((x) => '0x' + (x ?? 0).toString(16));
    const bytes = frames.reduce((n, f) => n + f.length, 0);
    console.log(`[forgefx] presetDump: frames=${frames.length} bytes=${bytes} fns=[${fns.join(',')}] terminator=${frames.some((f) => f[5] === 0x79)}`);
    const d = decodeDump(frames, this.#prof).dump;
    return {
      model: 'fm3',
      name: d.name,
      crcValid: d.crcValid,
      rows: d.rows,
      cols: d.cols,
      scenes: d.sceneNames,
      cells: d.grid.map((c) => ({ row: c.row, col: c.col, effectId: c.effectId, name: c.name, isShunt: c.isShunt, routeFlag: c.routeFlag, fromRows: c.fromRows })),
      source: 'dump'
    };
  }

  /** Decode any preset by number (non-disruptive — does NOT switch the active preset) into a
   *  library-friendly summary: name, scene names, and the unique effect blocks it contains. The
   *  foundation for a preset browser/library (search by block, collections, tags). Param-level facts
   *  (amp model etc.) are a follow-up once the per-block param decode lands. */
  async presetSummary(presetNumber: number, withParams = false): Promise<PresetSummary> {
    const frames = await this.#dumpFrames(presetNumber);
    const decoded = decodeDump(frames, this.#prof);
    const blocks = this.#decodeBlocks(decoded);
    const summary = this.#summarizeDump(decoded.dump, modelsFromBlocks(blocks), presetNumber);
    if (withParams) summary.params = blocks; // cache build: summary + full params in one dump
    return this.#withModifiers(decoded, summary);
  }

  /** Full per-block params (every family/param) for one device preset — the deep-search / detail source. */
  async presetParams(presetNumber: number): Promise<DecodedBlock[]> {
    const frames = await this.#dumpFrames(presetNumber);
    return this.#decodeBlocks(decodeDump(frames, this.#prof));
  }

  /** Raw .syx bytes (the backup blob) + decoded summary for one slot — the backups service's source. */
  async dumpRaw(n: number): Promise<{ bytes: Uint8Array; summary: PresetSummary }> {
    const frames = await this.#dumpFrames(n);
    const decoded = decodeDump(frames, this.#prof);
    const summary = this.#withModifiers(decoded, this.#summarizeDump(decoded.dump, modelsFromBlocks(this.#decodeBlocks(decoded)), n));
    return { bytes: Uint8Array.from(frames.flat()), summary };
  }

  /** Verbatim .syx dump for POST /preset/backup (capability `backupDump`) — the library's
   *  export-to-disk + audition source. Location omitted → the currently selected preset's slot
   *  (gen-3 dumps by slot; the raw edit-buffer stream is a different frame format, not a .syx). */
  async backupPreset(location?: number): Promise<{ location: number | null; code: string | null; name: string; bytes: number[] }> {
    const n = location ?? (await this.presetRef()).number;
    const { bytes, summary } = await this.dumpRaw(n);
    return { location: n, code: null, name: summary.name, bytes: Array.from(bytes) };
  }

  /** Decode a preset from raw .syx bytes (a saved/exported dump) — offline, no device needed. Splits
   *  the byte stream into F0..F7 SysEx frames and runs the same decoder. For a file-based library. */
  decodePresetBytes(bytes: Uint8Array): PresetSummary {
    const frames: number[][] = [];
    let cur: number[] | null = null;
    for (const b of bytes) {
      if (b === 0xf0) cur = [b];
      else if (cur) {
        cur.push(b);
        if (b === 0xf7) {
          frames.push(cur);
          cur = null;
        }
      }
    }
    const decoded = decodeDump(frames, this.#prof);
    const blocks = this.#decodeBlocks(decoded);
    const summary = this.#summarizeDump(decoded.dump, modelsFromBlocks(blocks), -1);
    summary.params = blocks; // offline files embed full params (few files → fine for search/storage)
    return this.#withModifiers(decoded, summary);
  }

  /** Attach decoded modifier assignments to a summary — gen-3 only, and only when the codec found
   *  any. `targetEffectId` is resolved from the placed grid (modifier targets name blocks through the
   *  same effectName table the grid uses); `slot` comes from the body's pre-chain modifier table. */
  #withModifiers(decoded: DecodedDump, summary: PresetSummary): PresetSummary {
    const modifiers = this.#decodeModifiers(decoded);
    if (modifiers.length) summary.modifiers = modifiers;
    return summary;
  }

  /** Decode the modifier assignments from the preset body into the driver DTO. Mirrors the codec's
   *  `decodeGen3Body().modifiers` for the source/target/param/origin, then enriches each with the
   *  resolved target effectId (from the grid) and — for pre-chain entries — the 1-based slot.
   *
   *  SLOT INFERENCE: the codec's extractPreChainModifiers walks a fixed 12-entry table at body offset
   *  0x240 (entry i at word 502 + i*48) and returns non-empty entries in table order, but drops the
   *  absolute index. We re-walk the SAME table (same constants + skip rule as
   *  forgefx-midi/src/devices/gen3/presetBody.ts) to recover each entry's index, and map index i → slot
   *  i+1 (the table is slot-indexed — factory presets leave gaps, e.g. slots 2/3/6 populated, 1/4/5
   *  empty). decodeGen3Body emits all pre-chain entries first, in the same order, so the k-th pre-chain
   *  modifier pairs with the k-th non-empty table index. This indexing is inferred, NOT
   *  hardware-verified; the modifier-readback suite cross-checks it against the codec on real dumps. */
  #decodeModifiers(decoded: DecodedDump): PresetModifier[] {
    const list = decoded.modifiers;
    if (!list.length) return [];
    const nameToEid = new Map<string, number>();
    for (const c of decoded.dump.grid) if (!c.isShunt && c.effectId) nameToEid.set(c.name, c.effectId);

    const slots: number[] = [];
    const body = decoded.body;
    for (let i = 0; i < MODIFIER_MAX_ENTRIES; i++) {
      const abs = MODIFIER_PRE_CHAIN_START + (MODIFIER_FIRST_WORD + i * MODIFIER_ENTRY_SIZE) * 2;
      if (abs + 12 * 2 > body.length) break;
      if (u16(body, abs) !== 25) break; // marker, same as the codec
      const sourceId = u16(body, abs + 2 * 2);
      const targetEid = u16(body, abs + 10 * 2);
      const paramNum = u16(body, abs + 11 * 2);
      if (targetEid === 0 && paramNum === 0 && sourceId === 0) continue; // empty entry
      slots.push(i + 1);
    }

    let pre = 0;
    return list.map((m) => ({
      source: m.source,
      target: m.target,
      targetEffectId: nameToEid.get(m.target) ?? null,
      param: m.param,
      origin: m.origin,
      slot: m.origin === 'pre-chain' ? (slots[pre++] ?? null) : null
    }));
  }

  /** Decoded modifier assignments for the CURRENT edit buffer — the modifier editor's read-back
   *  source (GET /preset/modifiers). One preset dump; no extra wire. */
  async presetModifiers(): Promise<{ modifiers: PresetModifier[] }> {
    const frames = await this.#dumpFrames(EDIT_BUFFER);
    const decoded = decodeDump(frames, this.#prof);
    return { modifiers: this.#decodeModifiers(decoded) };
  }

  /** Decode every placed block's full params from the preset body, table-driven via the universal
   *  layout (u16 array @ header+0x2e, paramId order) + the fractal-midi catalog (FM3_PARAMS/RANGES/
   *  ENUM_OVERRIDES/ROSTERS). `decoded` supplies the grid's placed effectIds so only placed blocks are
   *  read (rejects phantom headers). Empty for non-FM3. The model/type search index is derived from
   *  this via `modelsFromBlocks`. */
  #decodeBlocks(decoded: DecodedDump): DecodedBlock[] {
    if (decoded.dump.modelId !== 0x11) return []; // gate on the PRESET's model (not the connected device) — so
    try {                                         // an offline FM3 .syx decodes even when no FM3 is attached
      const placedEids = new Set<number>(decoded.dump.grid.filter((c) => !c.isShunt && c.effectId).map((c) => c.effectId));
      return readBlockParamsForModel(decoded.body, placedEids, decoded.dump.modelId);
    } catch {
      return [];
    }
  }

  #summarizeDump(d: DecodedDumpDTO, models: Record<string, string[]>, presetNumber: number): PresetSummary {
    const seen = new Map<number, { effectId: number; slug: string | null; name: string; instance: number | null }>();
    for (const c of d.grid) {
      if (c.isShunt || !c.effectId || seen.has(c.effectId)) continue;
      const ref = blockRefForEid(c.effectId);
      seen.set(c.effectId, { effectId: c.effectId, slug: ref?.slug ?? null, name: c.name, instance: ref?.instance ?? null });
    }
    return { number: presetNumber, name: d.name, model: d.modelName, crcValid: d.crcValid, crc: d.crc, scenes: d.sceneNames, blocks: [...seen.values()], models, amps: models.amp ?? [] };
  }

  /** Decompressed preset body as hex — for per-block param-decode RE (diff bodies across known param
   *  changes to locate offsets). Dumps the active edit buffer. */
  async presetBodyHex(): Promise<{ len: number; hex: string }> {
    const dev = await this.#conn();
    const frames = await dev.request(this.#codec.buildRequestPresetDump(EDIT_BUFFER), {
      timeoutMs: 5000,
      quietMs: 180,
      match: (fs) => fs.some((f) => f[5] === 0x79)
    });
    const parsed = parsePresetDump(dumpBytesFromFrames(frames), 0, this.#prof.model);
    const { body } = decodeRawPatch(parsed.chunkPayloads);
    return { len: body.length, hex: Buffer.from(body).toString('hex') };
  }

  async #statusByEffectId(): Promise<Map<number, { bypassed: boolean; channel: number }>> {
    const dev = await this.#conn();
    const map = new Map<number, { bypassed: boolean; channel: number }>();
    try {
      // fractal-midi's isStatusDumpResponse is locked to model 0x10 (III), so match the
      // 0x13 frame ourselves (any model) and parse the id-id-dd triples inline.
      const frames = await dev.request(this.#codec.buildStatusDump(), { timeoutMs: 1500, match: (fs) => fs.some((f) => f[5] === 0x13) });
      const f = frames.find((x) => x[5] === 0x13);
      if (f) {
        const payload = f.slice(6, f.length - 2);
        for (let i = 0; i + 2 < payload.length; i += 3) {
          const effectId = (payload[i]! & 0x7f) | ((payload[i + 1]! & 0x7f) << 7);
          const dd = payload[i + 2]! & 0x7f;
          map.set(effectId, { bypassed: (dd & 0x01) !== 0, channel: (dd >> 1) & 0x07 });
        }
      }
    } catch {
      /* status optional */
    }
    return map;
  }

  /** Live active-channel per placed block (effectId → channel 0-3), from the fn 0x13 status dump.
   *  Feeds the registry's front-panel channel-change watch. One small round-trip. */
  async getActiveChannels(): Promise<Map<number, number>> {
    const status = await this.#statusByEffectId();
    const out = new Map<number, number>();
    for (const [eid, st] of status) out.set(eid, st.channel);
    // W2.3: the status dump enumerates the PLACED blocks, so record it as the sweep's target list — the
    // registry's channel watch calls this every Nth meter tick, which makes the sweep's enumeration free.
    if (out.size > 0) this.#placedCache = { eids: [...out.keys()], at: Date.now() };
    return out;
  }

  /** Placed blocks: position + routing + live bypass/channel. */
  async placedBlocks(): Promise<PresetBlockDTO[]> {
    const g = await this.grid();
    const status = await this.#statusByEffectId();
    const out: PresetBlockDTO[] = [];
    for (const c of g.cells) {
      if (c.isShunt) continue;
      const slug = slugForEffectId(c.effectId) ?? '';
      const st = status.get(c.effectId);
      out.push({
        slug,
        name: c.name,
        effectId: c.effectId,
        row: c.row,
        col: c.col,
        fromRows: c.fromRows,
        bypassed: st ? st.bypassed : null,
        channel: st ? CH_LETTERS[st.channel] ?? null : null
      });
    }
    return out;
  }

  /** LIGHTWEIGHT per-block scene state — just bypass + active channel from the fn 0x13 status dump,
   *  NO preset dump. A scene switch never changes the grid STRUCTURE (block placement/routing is
   *  preset-level), only per-block bypass/channel/param values — so the UI can reuse its cached grid
   *  and re-apply just this. One small round-trip; keeps scene changes snappy and OFF the heavy,
   *  crash-prone dump path (a full dump right after a scene switch hits the device mid-rebuild). */
  async sceneState(): Promise<{ effectId: number; bypassed: boolean; channel: string | null }[]> {
    const status = await this.#statusByEffectId();
    // W2.2: an EMPTY status map means the fn-0x13 read failed/timed out (#statusByEffectId swallows the
    // error). A real preset always has ≥ Output blocks, so `[]` can never be a legitimate scene state —
    // returning it made the route answer 200 `[]` and Axis kept the previous scene's bypass/channel
    // forever. Throw so the route maps it to 503 and Axis's `.catch(() => null) → load()` fallback fires.
    if (status.size === 0) throw new Error('scene-state read failed (no status dump from the device)');
    return [...status].map(([effectId, s]) => ({ effectId, bypassed: s.bypassed, channel: CH_LETTERS[s.channel] ?? null }));
  }

  // ── catalog ──
  // Full placeable roster — one entry PER INSTANCE (Amp 1, …, Output 1, Output 2) so the palette can
  // place a specific instance instead of always re-sending instance 1 (which the device refuses once
  // that instance is on the grid). Instance count = the DEVICE-TRUE count from the profile
  // (`instanceLimits[slug]` else `defaultInstances`), clamped to the protocol's reserved ID range
  // (`blockInstances`). `page` is the exact effect id (firstId + instance-1).
  blocksCatalog() {
    const out: { slug: string; family: string; instance: number; name: string; page: number; paramCount: number; typeCount: number }[] = [];
    for (const e of effectRoster()) {
      const fam = SLUG_FAMILY[e.slug];
      const paramCount = fam ? (this.#prof.params[fam]?.length ?? 0) : 0;
      const typeCount = this.#prof.rosterFor(e.slug).length;
      const limit = this.#prof.instanceLimits[e.slug] ?? this.#prof.defaultInstances;
      const n = Math.max(1, Math.min(blockInstances(e.slug), limit));
      for (let i = 0; i < n; i++) {
        out.push({ slug: e.slug, family: e.slug, instance: i + 1, name: n > 1 ? `${e.name} ${i + 1}` : e.name, page: e.page + i, paramCount, typeCount });
      }
    }
    return out;
  }
  blockTypes(slug: string): TypeModel[] {
    return this.#prof.rosterFor(slug);
  }

  /**
   * Read a placed block's params via the fn=0x1F bulk read. The 0x75 body is
   * CHANNEL-BLOCKED: index = channel*stride + paramId, stride = paramCount,
   * channelCount = values.length/stride (per-block, NOT always 4). `norm` = raw/65534
   * (knob position); `value`/`unit` are the device-true DISPLAY reading via this.#prof.ranges
   * (e.g. 1.2k Hz, -12 dB) where the cache has a range, else the 0..10 position.
   */
  async blockParams(eid: number): Promise<{ block: string; slug: string; page: number; named: NamedParam[]; enums: EnumParam[]; type: { value: number; name: string } | null; layout?: DeviceLayout }> {
    this.#watchedEid = eid; // this is the block the user has open → the target the FM3 device-edit poll re-reads
    const codecSlug = slugForEffectId(eid) ?? ''; // audio blocks resolve via the codec
    // virtual effects (GLOBAL=1, Controllers=2, Modifier=3, FC=199) resolve via the profile's effectId map
    const family = SLUG_FAMILY[codecSlug.toLowerCase()] ?? this.#prof.familyForEffectId(eid);
    const slug = codecSlug || (family ? family.toLowerCase() : ''); // virtual effects key on the family name
    const meta = BLOCK_META[codecSlug];
    const blockName = meta?.name ?? family ?? slug;
    const page = meta?.page ?? -1;
    // Seed the editor-authentic layout with the family's fallback variant; once the block's CURRENT
    // type is read below we re-resolve to the type-matched (or firmware-pinned) variant.
    let layout = family ? this.#prof.layoutFor(family) : undefined;
    if (!family) {
      return { block: blockName, slug, page, named: [], enums: [], type: null, layout }; // no device-true param family mapped
    }
    const defs = this.#prof.params[family] ?? [];
    // The device's OWN layout widget evidence for this family (see DeviceProfile.layoutKnobIds): a
    // param the FM3 draws as 'knob' is continuous, one it draws as 'dropdown' is a selector — even when
    // the catalog row disagrees (an 'unverified'-unit float, or a selector mined as a float row).
    const layoutKnob = this.#prof.layoutKnobIds?.get(family) ?? EMPTY_ID_SET;
    const layoutDropdown = this.#prof.layoutDropdownIds?.get(family) ?? EMPTY_ID_SET;
    // Which range row actually SERVES a param. A device-cache row wins only when it can be served on
    // its own terms: an enum row always can, a float row only with a real display unit (KNOB_UNITS)
    // and a non-zero width. A cache row that fails that test would silently DELETE the param — both
    // filters drop it — so when the catalogue says the param IS a discrete selector, prefer the
    // catalogue: the device's own page still draws the control (e.g. the FM3 Cab's per-cab MUTE, pid
    // 25, which the cache describes as a float on a marker-unit def, making cab 2's Mute/Solo vanish).
    const catalogue = this.#prof.staticRanges ?? this.#prof.ranges;
    const rangeFor = (p: { paramId: number; unit?: string }) => {
      const merged = this.#prof.ranges[family]?.[p.paramId];
      if (merged?.kind !== 'float') return merged;
      if (KNOB_UNITS.has(p.unit ?? '')) return merged;
      const stat = catalogue[family]?.[p.paramId];
      return stat?.kind === 'enum' ? stat : merged;
    };
    // knob params = continuous, musician-facing: a float range + a real display unit
    // (drops enum selectors, internal 'numeric'/'unverified' params, and bypass flags).
    // knobs = every continuous param with a usable range. We expose ALL real controls (the UI
    // organizes them); only genuinely-dead params are dropped: no range (min===max) or the bypass flag.
    const seenIds = new Set<number>();
    const knobs = defs.filter((p) => {
      const range = rangeFor(p);
      if (range?.kind !== 'float') return false;
      // A device layout 'knob' is continuous evidence: honour it even when the catalog unit is a
      // non-display marker (the FM3 GLOBAL Brightness/Contrast 7115/7116 carry unit 'unverified').
      if (!KNOB_UNITS.has(p.unit ?? '') && !layoutKnob.has(p.paramId)) return false;
      if (/bypass/i.test(p.displayLabel ?? p.name)) return false;
      if (range.displayMin === range.displayMax) return false; // unusable (0..0) knob
      if (seenIds.has(p.paramId)) return false; // dedupe same wire paramId (first wins)
      seenIds.add(p.paramId);
      return true;
    });
    // enums = every discrete selector. The family TYPE selector is excluded (header retype palette),
    // plus the raw bypass flag; everything else (modes, slopes, mics, mic/cab pickers…) is shown.
    const typeId = this.#paramId(family, 'type');
    const enumDefs = defs.filter((p) => {
      const range = rangeFor(p);
      if (!range || p.paramId === typeId) return false;
      // A device layout 'dropdown' is selector evidence: honour it even when the catalog row is not an
      // enum (the FM3 GLOBAL FC default-layout ids 3602-3604 carry a mined float 1..9 row).
      if (range.kind !== 'enum' && !layoutDropdown.has(p.paramId)) return false;
      if (range.displayMax <= range.displayMin) return false;
      if (/^bypass$/i.test(p.displayLabel ?? p.name)) return false;
      return true;
    });
    const named: NamedParam[] = [];
    const enums: EnumParam[] = [];
    let type: { value: number; name: string } | null = null;
    {
      const dev = await this.#conn();
      try {
        // Read the block's CURRENT channel (A-D) so a channel switch actually reloads that channel's
        // params/type: the fn-0x1F body is channel-blocked and holds ALL channels, so we must slice the
        // active one, not always channel A. Costs one status round-trip per open — worth it for correctness.
        const activeCh = (await this.#statusByEffectId()).get(eid)?.channel ?? 0;
        this.#watchedChannel = activeCh; // keep the device-edit-burst diff on the same channel (see decodeEditBurst)
        const frames = await dev.request(this.#codec.buildBlockBulkReadPoll(eid), { timeoutMs: dev.slow ? 8000 : 2500, quietMs: dev.slow ? 600 : 120, match: (fs) => fs.some((f) => f[5] === 0x76) });
        const bulk = this.#codec.assembleGen3BlockBulkRead(frames);
        // A torn multi-frame read (a dropped 0x75 page) leaves fewer values than the 0x74 head
        // advertised. detect it HERE so the failure path below (not the `?? 0` reads) handles it:
        // otherwise the missing tail params are silently served as 0 and the block looks complete.
        if (bulk.values.length < bulk.itemCount) {
          throw new Error(`torn block bulk read for eid ${eid}: got ${bulk.values.length} of ${bulk.itemCount} values`);
        }
        const { base } = this.#channelSlice(family, bulk, activeCh);
        // The fn=0x1F body IS positional AND pid-indexed: record i is the param whose device-true
        // paramId is i, so `values[base + pid]` is that pid's own record. Measured on the real FM3
        // 2026-10-07 with scripts/dump-global.ts (read-only): the eid-1 GLOBAL body is 14,880 records
        // (head itemCount 14880, assembled 14880, ratio 1.000), so a GLOBAL `base + pid` is IN range,
        // not past the block. The front panel is the oracle for the indexing — Mini Display/Ring
        // Brightness at 100% read body[7115] = 65534, and after the user set it to 70% it read
        // body[7115] = 45874 (exactly 0.70 x 65534); Mini Display Contrast at 50% read body[7116] =
        // 32767 (exactly half of 65534); Ring Intensity Bright at 100% read body[110] = 65534. Three
        // independent panel values match by proportion, so pid == record ordinal. The raw field is
        // 16-bit with 65534 = 100% (the catalog's 0..100 display range, scale 1, is correct).
        //
        // A previous fix mis-read the catalog's SPARSE pids (173 pids, 91 of them >= the declared
        // stride 186, up to 65522) as evidence the body was NOT positional, and refused the WHOLE
        // family. That mechanism is REFUTED by the measurement above — the body is large (14,880)
        // and pid-indexed, and the catalog's "stride 186" simply does not describe this body's length.
        // Out-of-range is therefore PER PID, not per family: a pid whose record the body genuinely
        // does not carry (a short/torn tail) reads `null`, never a fabricated 0.
        //
        // WRITE UNITS ARE PER-OPCODE and are NOT a property of this read path. Measured on THIS path:
        // the eid-1 GLOBAL body is 14,880 records indexed by pid, body[7115] tracks the panel, and raw
        // 65534 = 100% — so `values[base + pid]` is that pid's own record (see above). The unit a write
        // carries depends on the OPCODE the caller chose: the CONTINUOUS set takes the client's
        // normalized 0..1; the DISCRETE set takes percent for a 0..100 param. See
        // docs/decisions/0006-units-are-per-opcode.md. A value written without an explicit `continuous`
        // flag is a CALLER error, not a device property — the omitted flag silently selects the other
        // opcode's unit. No unit conversion belongs in this driver.
        //
        // Prime the device-edit-push baseline with the OPEN channel's values so a later front-panel
        // edit's burst diffs cleanly to the moved param (no first-sight reload — see decodeEditBurst).
        // Slice from `base` to the END of the body (NOT base+stride): the diff keys on the body's actual
        // extent, so a GLOBAL pid >= the catalogue stride (Brightness 7115) still has its record compared.
        this.#editSnapshot.set(eid, bulk.values.slice(base));
        const readRaw = (pid: number): number | null => {
          const v = bulk.values[base + pid];
          return typeof v === 'number' ? v : null; // a record the body does not carry is UNKNOWN, never 0
        };
        const unresolvedReason = (pid: number): string =>
          `no fn=0x1F record at index ${base + pid} in the ${family} body (${bulk.values.length} values) to supply pid ${pid}`;
        for (const p of knobs) {
          const raw = readRaw(p.paramId);
          named.push(raw === null
            ? { id: p.paramId, name: paramLabel(p), value: null, norm: null, unresolved: unresolvedReason(p.paramId) }
            : { id: p.paramId, name: paramLabel(p), ...this.#display(family, p.paramId, raw) });
        }
        for (const p of enumDefs) {
          const range = rangeFor(p)!; // the SERVING row (see rangeFor), not the raw merged one
          const max = Math.round(range.displayMax);
          const min = Math.round(range.displayMin);
          const raw = readRaw(p.paramId);
          // The OPTION LIST is bounded by ordinals, not by display values. A scaled enum carries its
          // display range (PHASER_ORDER: scale 2, displayMin/Max 0..10) but only `enumCount` ordinals
          // (6), so listing min..displayMax offered 6..10 as phantom selectable ordinals with no label.
          const ordMax = range.enumCount != null ? min + range.enumCount - 1 : max;
          if (raw === null) { // record the body does not carry (short/torn tail) — null it, never a guessed ordinal
            enums.push({ id: p.paramId, name: paramLabel(p), value: null, options: this.#enumOptions(family, p.paramId, p.name, min, ordMax), unresolved: unresolvedReason(p.paramId) });
            continue;
          }
          // Discrete params store the ordinal; if the wire value looks 16-bit-scaled, unscale it. A
          // scaled enum's display span is `scale`× its ORDINAL span (the row's own metadata: display =
          // ordinal * scale — PHASER_ORDER's scale 2 over 6 ordinals spans display 0..10), so unscale
          // against the ordinal end (ordMax), not displayMax: otherwise the served value lands in
          // DISPLAY space (0..10) outside its own option list (0..5) and a write-back would send a
          // float where the device expects a discrete ordinal. ordMax === max for an unscaled enum, so
          // this is a no-op off the scaled rows. Clamp to ordMax so the served value is always a member.
          const value = raw > max ? Math.min(ordMax, Math.round((raw / 65534) * (ordMax - min)) + min) : raw;
          enums.push({ id: p.paramId, name: paramLabel(p), value, options: this.#enumOptions(family, p.paramId, p.name, min, ordMax) });
        }
        // current model/type (for EQ band layout etc.)
        if (typeId != null) {
          const roster = this.#prof.rosterFor(slug);
          const max = Math.max(0, roster.length - 1);
          const raw = readRaw(typeId);
          if (raw === null) {
            // Record the body does not carry — leave `type` null rather than fabricate a type 0 and
            // resolve the layout to the wrong variant.
            type = null;
          } else {
            const tv = raw > max ? Math.round((raw / 65534) * max) : raw;
            type = { value: tv, name: roster[tv]?.name ?? '' };
          }
        }
      } catch (e) {
        // Any mid-decode throw (malformed 0x75, a torn/short burst, a transport timeout) means the
        // block's state is UNKNOWN. The old code reset only `named` and fell through to a zero-filled
        // fallback, so the failure was swallowed: the handler saw a normal return and answered 200
        // with a valid-looking snapshot (knobs 0, no enums/type) for a read that never completed.
        // Reset EVERY decoded output (named, enums, type — the layout-selector map is derived from
        // these below) so no partial real/zero snapshot can leak, then RETHROW: blockParamsH already
        // maps a thrown error to 404 + {error} (the repo's existing failure shape), so the torn read is
        // surfaced to the client instead of silently served as a complete block.
        named.length = 0;
        enums.length = 0;
        type = null;
        throw e;
      }
    }
    // Current value of any page/control selector param, keyed by its editor symbol: the family type
    // selector answers with the type just decoded; other selectors (EQ type, drive type, …) with the
    // block's read enum/knob value. Lets layoutFor filter the served pages down to the ones the editor
    // would actually show — collapsing e.g. the amp's per-model 'Authentic' pages to the current model.
    const valueByPid = new Map<number, number>();
    for (const e of enums) if (e.value !== null) valueByPid.set(e.id, e.value);
    for (const n of named) if (typeof n.value === 'number') valueByPid.set(n.id, n.value);
    const selectors: SelectorValues = (selectorParamName) => {
      const pid = this.#paramId(family, selectorParamName);
      if (pid == null) return undefined;
      if (typeId != null && pid === typeId) return type?.value;
      return valueByPid.get(pid);
    };
    // Re-resolve the layout to the variant selected by the block's CURRENT type value (EQ band count,
    // amp firmware-pinned variant, etc.) and filter its pages to the current selector/firmware state;
    // falls back to the null/first variant when type is unknown.
    layout = this.#prof.layoutFor(family, type?.value, selectors);
    // disambiguate repeated labels within a block (e.g. the cab's 4× "Low Cut", amp's two "Depth")
    // so identical names get a 1/2/3 suffix the UI can tell apart.
    dedupeLabels(named);
    dedupeLabels(enums);
    // Bridge the device's `_BTN_` pseudo-param controls (the cab page's per-cab M / S buttons, whose
    // ids 65286… are never served) onto the REAL served params they drive (the `MUTE<n>` enum), so the
    // SERVED layout binds live ids and no client has to re-resolve by name (parity audit §3.6 item 4).
    // The served names are read AFTER dedupeLabels so the rewrite keys on exactly what the client sees.
    const defNameById = new Map(defs.map((d) => [d.paramId, d.name]));
    const served: ServedParamRef[] = [
      ...enums.map((e) => ({ id: e.id, servedName: e.name, paramName: defNameById.get(e.id) ?? e.name })),
      ...named.map((n) => ({ id: n.id, servedName: n.name, paramName: defNameById.get(n.id) ?? n.name })),
    ];
    layout = layout ? resolvePseudoParamControls(layout, served) : layout;
    return { block: blockName, slug, page, named, enums, type, layout };
  }

  /** Read specific paramIds of an effect as **normalized 0..1** values, keyed by pid.
   *
   *  The plain per-pid GET (fn 0x01, sub `01 00`) this method once used is **dead on FM3 fw13**: the
   *  device answers every such request with a canned compiled-record template whose value field is the
   *  constant septets `20 74 00 00 00` → the denormal 2.085e-41, which reads as `0.0000` (measured on a
   *  real FM3, fw 13.0, for a virtual GLOBAL eid AND a real block — docs/decisions/0005). It is not
   *  merely wrong for GLOBAL; it is unusable on this firmware generally, so it is not sent any more.
   *
   *  Reads through the **sub-0x1a range op** instead — the opcode FM3-Edit uses, which addresses by
   *  (eid, pid) and returns the value. UNIT CONTRACT: the value is the device's own NORMALIZED 0..1
   *  wire fraction, NOT a raw 16-bit count; a caller that needs a raw count must use the fn=0x1F bulk
   *  read. A pid the device does not answer, or answers with a non-value (a subnormal / non-finite —
   *  the canned-template signature), is OMITTED from the result — never fabricated as a number. */
  async readParams(eid: number, pids: number[]): Promise<Record<number, number>> {
    return this.readRange(eid, pids);
  }

  /** Per-pid range-read (sub 0x1a — the opcode FM3-Edit uses; the plain 01 00 GET returns junk, and
   *  is dead on fw13 — see `readParams`). The ~60-byte response carries a NORMALIZED 0..1 float32 at
   *  byte 12 (over the param's range). Returns {pid: norm}; logs the raw frame when FORGEFX_GETDUMP is
   *  set (calibration). A reply whose value is a subnormal / non-finite (the canned-template signature,
   *  `20 74 00 00 00` → 2.085e-41) is OMITTED — never served as a value. */
  async readRange(eid: number, pids: number[]): Promise<Record<number, number>> {
    const dev = await this.#conn();
    const out: Record<number, number> = {};
    const enc14 = (n: number) => [n & 0x7f, (n >> 7) & 0x7f];
    const buildGet = (e: number, p: number): number[] => {
      const f = [0xf0, 0x00, 0x01, 0x74, this.#prof.model, 0x01, 0x1a, 0x00, ...enc14(e), ...enc14(p), 0, 0, 0, 0, 0, 0, 0, 0, 0];
      let cs = 0;
      for (const b of f) cs ^= b;
      f.push(cs & 0x7f, 0xf7);
      return f;
    };
    for (const pid of pids) {
      try {
        const match = (f: number[]) => f[5] === 0x01 && f[6] === 0x1a && f[7] === 0x00 && (f[8]! | (f[9]! << 7)) === eid && (f[10]! | (f[11]! << 7)) === pid;
        const frames = await dev.request(buildGet(eid, pid), { timeoutMs: 800, quietMs: 50, match: (fs) => fs.some(match) });
        const f = frames.find(match);
        if (f) {
          if (ENV.FORGEFX_GETDUMP) console.log(`RANGEDUMP eid=${eid} pid=${pid} raw=${f.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
          const v = paramF32FromSeptets(f.slice(12, 17));
          if (v !== null) out[pid] = v; // a non-value (subnormal / non-finite) is OMITTED, never served
        }
      } catch {
        /* skip */
      }
    }
    return out;
  }

  /**
   * FC (eid 199) structured switch-config read — the per-switch read FM3-Edit uses on FC-page entry.
   *
   * Request: function 0x01, **sub-action 0x01** (NOT the per-pid 01-00 GET), addressed by a *config
   *   selector* (NOT a paramId): frame `F0 00 01 74 <model> 01 01 00 <sel:2×7bit LE> 0*9 cs F7`.
   *   selector = config*2 + side, side 0 = TAP, 1 = HOLD. (A windowed request form with the high
   *   selector byte = 8 returns the same record; the low form is used here.) config is the standard
   *   FC config index (layout*12 + view*3 + switch).
   *
   * Response: an **87-byte** frame whose body (the 78 bytes after `F0 00 01 74 <model> 01 01`) is:
   *   [0]      00
   *   [1..2]   selector echo (2×7bit LE) — equals the request selector
   *   [3..4]   00 00
   *   [5..9]   session/window context value (NOT per-switch; shared across all configs in a session —
   *            confirmed live: identical for every selector at a given moment, changes on window state,
   *            not on switch content). Ignored.
   *   [10..11] 00 00
   *   [12..13] 38 00  (record-format constant)
   *   [14]     config index (0..107) — echoes the selector's config, AUTHORITATIVE.
   *   [15]     side flag: bit 0x40 set = HOLD, clear = TAP — AUTHORITATIVE (confirmed live & in capture).
   *   [16..]   packed per-switch field record. The field byte offsets within this record are NOT yet
   *            decoded with confidence (see note) — the raw bytes are returned for the caller.
   *
   * ⚠ Field-offset note: the body[14]/[15] config+side echo is confirmed byte-exact against both the
   *   live device and the FM3-Edit capture. The interior field layout (category / value-slots / label)
   *   is NOT decoded: it is a packed format that is neither the 5×7bit-f32 used by writes nor plain
   *   7-bit-ASCII for the label, and it could not be validated on the live device because sub-0x09
   *   param writes to (eid 199, pid) do not surface in this read (exhaustively verified: writing any FC
   *   config param changes zero bytes of any selector's response — the structured read serves the
   *   device's compiled/active layout snapshot, decoupled from the param edit buffer). Until a ground-
   *   truth correlation is available, only `present`, `config`, `side` are trustworthy; `raw` carries
   *   the undecoded record so a future decode can be added without another wire round-trip.
   */
  async fcReadSwitch(layout: number, view: number, sw: number): Promise<FcSwitchState> {
    const dev = await this.#conn();
    const model = this.#prof.fcModel;
    if (!model) throw new Error('device has no decoded Foot Controller model');
    if (!model.liveState) throw new Error('live FC switch read is not supported for this device model (FM3 only); the address model is available via GET /fc/model');
    const config = layout * model.configsPerLayout! + view * model.switches! + sw;
    const enc14 = (n: number) => [n & 0x7f, (n >> 7) & 0x7f];
    const buildSelRead = (sel: number): number[] => {
      const f = [0xf0, 0x00, 0x01, 0x74, this.#prof.model, 0x01, 0x01, 0x00, ...enc14(sel), 0, 0, 0, 0, 0, 0, 0, 0, 0];
      let cs = 0;
      for (const b of f) cs ^= b;
      f.push(cs & 0x7f, 0xf7);
      return f;
    };
    // body = frame bytes after the 7-byte header (F0 00 01 74 <model> 01 01), minus checksum+F7
    const readSide = async (side: 0 | 1): Promise<{ present: boolean; raw: number[] }> => {
      const sel = config * 2 + side;
      try {
        const match = (f: number[]) =>
          f[5] === 0x01 && f[6] === 0x01 && f[7] === 0x00 && (f[8]! | (f[9]! << 7)) === sel && f.length >= 80;
        const frames = await dev.request(buildSelRead(sel), { timeoutMs: 800, quietMs: 50, match: (fs) => fs.some(match) });
        const f = frames.find(match);
        if (!f) return { present: false, raw: [] };
        const body = f.slice(7, -2);
        if (ENV.FORGEFX_GETDUMP) console.log(`FCDUMP sel=${sel} body=${body.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
        // validate the config/side echo (body[14]=config, body[15] bit 0x40 = HOLD)
        const echoCfg = body[14] ?? -1;
        const echoSide = (body[15] ?? 0) & 0x40 ? 1 : 0;
        const present = echoCfg === config && echoSide === side;
        return { present, raw: body };
      // (empty-slot heuristic computed by the caller from raw[16..]; see fcReadSwitch return)
      } catch {
        return { present: false, raw: [] };
      }
    };
    const tap = await readSide(0);
    const hold = await readSide(1);
    // Empty-slot heuristic: an unassigned switch returns its primary value region (body[18],[19]) as
    // 0,0 (confirmed live: an explicitly-unassigned switch reads 0,0 while an assigned/templated one
    // carries a non-zero value there). This is the one interior signal that is stable enough to surface;
    // it is a presence hint, not a field decode.
    const emptyOf = (b: number[]) => !b.length || ((b[18] ?? 0) === 0 && (b[19] ?? 0) === 0);
    return {
      effectId: model.effectId,
      layout,
      view,
      switch: sw,
      config,
      tap: { selector: config * 2, present: tap.present, empty: emptyOf(tap.raw), raw: tap.raw },
      hold: { selector: config * 2 + 1, present: hold.present, empty: emptyOf(hold.raw), raw: hold.raw }
    };
  }

  /**
   * FC current-state read via the **sub-0x1b value channel** — the one that actually reflects param
   * edits. Request `F0 00 01 74 <model> 01 1b 00 <eid:2×7bit> <pid:2×7bit> 0*9 cs F7`; the response
   * carries the field's **raw value as a little-endian 7-bit int at body byte 12** (ordinal for enums,
   * ASCII for label chars) — verified live (category→1=Bank, colour→ordinal) and against the FM3-Edit
   * capture (colour tracked 3/5/1). This is distinct from `readRange` (sub 0x1a → normalized 0..1) and
   * from `fcReadSwitch` (sub 0x01 → a compiled snapshot that does NOT track edits).
   */
  async fcReadState(layout: number, view: number, sw: number): Promise<FcReadState> {
    const dev = await this.#conn();
    const model = this.#prof.fcModel;
    if (!model) throw new Error('device has no decoded Foot Controller model');
    if (!model.liveState) throw new Error('live FC state read is not supported for this device model (FM3 only); the address model is available via GET /fc/model');
    const eid = model.effectId;
    const config = layout * model.configsPerLayout! + view * model.switches! + sw;
    // Address bound: a NaN / fractional / negative address (e.g. the route passing Number('abc') straight
    // through) computes a NaN config, and `enc14` below — `n & 0x7f` on NaN is 0 — would encode it as
    // [0, 0], silently reading pid 0 for EVERY field with a 200. An out-of-space address (> the device's
    // own config count) similarly wraps in enc14 to a different config's pids. NEVER encode either: throw
    // explicitly (same class as this driver's torn-read / absent-model throws) so the route surfaces a
    // clear failure instead of wrong data. The route seam rejects malformed input first (400); this is the
    // driver's own backstop so no caller can bypass it.
    if (!Number.isInteger(config) || config < 0 || config >= model.configs) {
      throw new Error(`FC address (layout=${layout}, view=${view}, switch=${sw}) resolves to an invalid config ${config} outside 0..${model.configs - 1}`);
    }
    const enc14 = (n: number) => [n & 0x7f, (n >> 7) & 0x7f];
    const build = (pid: number): number[] => {
      const f = [0xf0, 0x00, 0x01, 0x74, this.#prof.model, 0x01, 0x1b, 0x00, ...enc14(eid), ...enc14(pid), 0, 0, 0, 0, 0, 0, 0, 0, 0];
      let cs = 0;
      for (const b of f) cs ^= b;
      f.push(cs & 0x7f, 0xf7);
      return f;
    };
    const read = async (pid: number): Promise<number | null> => {
      const match = (f: number[]) =>
        f[5] === 0x01 && f[6] === 0x1b && f[7] === 0x00 && (f[8]! | (f[9]! << 7)) === eid && (f[10]! | (f[11]! << 7)) === pid;
      try {
        const frames = await dev.request(build(pid), { timeoutMs: 800, quietMs: 40, match: (fs) => fs.some(match) });
        const f = frames.find(match);
        return f ? (f[12]! | (f[13]! << 7)) : null; // raw ordinal / ASCII, LE 7-bit
      } catch {
        return null;
      }
    };
    const pidOf = (field: string, idx = 0): number => {
      const fd = model.fields[field];
      if (!fd || fd.base == null || fd.stride == null) throw new Error(`FC field '${field}' has no base/stride on this device`);
      return fd.base + config * fd.stride + idx;
    };
    const readLabel = async (field: string): Promise<string> => {
      let s = '';
      for (let i = 0; i < (model.labelLen ?? 0); i++) {
        const c = await read(pidOf(field, i));
        if (c && c > 0) s += String.fromCharCode(c); // 0 = NUL pad
      }
      return s;
    };
    const fields: Record<string, number | null> = {};
    for (const field of ['tapCategory', 'tapFunction', 'tapDisplay', 'holdCategory', 'holdFunction', 'holdDisplay', 'color']) {
      fields[field] = await read(pidOf(field));
    }
    return { effectId: eid, layout, view, switch: sw, config, fields, tapLabel: await readLabel('tapLabel'), holdLabel: await readLabel('holdLabel') };
  }

  /** Raw bulk-read of any effect's param values indexed by paramId — for FC (eid 199) / Modifier
   *  (eid 3), whose params carry no display range so blockParams returns them empty. Sparse
   *  (only non-zero pids), first channel. The client computes pids from the FC/Modifier model. */
  async rawBlock(eid: number): Promise<{ eid: number; values: Record<number, number> }> {
    const dev = await this.#conn();
    const frames = await dev.request(this.#codec.buildBlockBulkReadPoll(eid), {
      timeoutMs: 2500,
      quietMs: 120,
      match: (fs) => fs.some((f) => f[5] === 0x76)
    });
    const bulk = this.#codec.assembleGen3BlockBulkRead(frames);
    const values: Record<number, number> = {};
    bulk.values.forEach((v, i) => {
      if (v) values[i] = v;
    });
    return { eid, values };
  }

  /** Cab IR catalog. `refresh` is the API hook for live per-device USER/SCRATCHPAD reads; the live
   *  wire path is still RE-pending, so refresh currently preserves the bundled factory/legacy banks
   *  and fails soft instead of breaking the picker/cache build. */
  async cabIrs(refresh = false): Promise<Record<string, string[]>> {
    const base = Object.fromEntries(Object.entries(this.#prof.cabIrs()).map(([k, v]) => [k, [...v]]));
    if (!refresh) return base;
    try {
      const live = await this.#liveCabIrs();
      return { ...base, ...live };
    } catch {
      return base;
    }
  }

  /**
   * Read back the unit's OWN per-slot cab state (`fn=0x01 sub=0x4B`), one request per slot.
   *
   * WHY this is the honest answer to "did my IR land": fw 13 refuses the documented cab-name read
   * (`fn=0x12`), so an upload's acks were the only evidence available. This query gives an independent
   * one — a populated/empty flag plus a content-derived region that two slots holding the same IR share
   * byte for byte (measured: a fresh upload to slot 13 matched slots 1 and 12 exactly).
   *
   * READ-ONLY: it only ever sends this query, and it never writes a slot. A slot whose reply does not
   * parse is reported with `populated: null` — the caller must NOT read that as empty.
   *
   * A full user bank is 128 requests; the sweep is paced and bounded by `MAX_CAB_SLOT_SWEEP`.
   */
  async queryCabSlots(opts: CabSlotQueryOptions = {}): Promise<CabSlotStateResult[]> {
    const page = opts.page ?? CAB_IR_PAGE_USER_BANKS[0]!;
    const from = opts.from ?? 0;
    const to = opts.to ?? from;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
      throw new Error(`queryCabSlots: bad range ${from}..${to} (indices are 0-based within a page)`);
    }
    if (to - from + 1 > MAX_CAB_SLOT_SWEEP) {
      throw new Error(`queryCabSlots: range ${from}..${to} is ${to - from + 1} slots; the sweep is capped at ${MAX_CAB_SLOT_SWEEP} per call`);
    }
    if (page !== CAB_IR_PAGE_SCRATCHPAD && !CAB_IR_PAGE_USER_BANKS.includes(page)) {
      throw new Error(`queryCabSlots: page 0x${page.toString(16)} is not a user bank (0x10-0x13) or the scratchpad (0x20)`);
    }
    const dev = await this.#conn();
    const out: CabSlotStateResult[] = [];
    for (let index = from; index <= to; index++) {
      const q = buildCabSlotQuery(this.#prof.model, index, page);
      let frames: number[][] = [];
      try {
        frames = await dev.request(q, CAB_SLOT_QUERY_OPTS);
      } catch (e) {
        out.push({ index, page, populated: null, flag: null, nameRegion: [], note: `transport error: ${(e as Error).message}` });
        continue;
      }
      const reply = frames.find((f) => f.length >= 30 && f[5] === 0x01 && f[6] === 0x4b);
      const state = reply ? parseCabSlotState(reply, index, page) : null;
      if (!state) {
        out.push({ index, page, populated: null, flag: null, nameRegion: [], note: reply ? 'reply did not parse' : 'no state reply (SILENT — not the same as empty)' });
        continue;
      }
      out.push({
        index,
        page,
        populated: state.populated,
        flag: state.flag,
        nameRegion: state.nameRegion,
        ...(state.populated === null ? { note: `unrecognised flag byte 0x${state.flag.toString(16)}` } : {}),
      });
    }
    return out;
  }

  /**
   * CLEAR a user cab slot — the device's DELETE, and it needs no new opcode.
   *
   * Sends the BLANK container (every chunk byte `0x7F`, Fractal's own loader asset geometry) and then
   * VERIFIES the result through the slot-state read-back. MEASURED 2026-10-08: the unit accepts it
   * (close-ack `0x00`) and the slot reads `empty` afterwards — on an empty slot and on seven slots that
   * held real IRs. DESTRUCTIVE: the slot's IR is gone.
   *
   * Fail-closed twice over: the `0x00` close answer is required (a `0x13` means the unit DISCARDED the
   * blank container, so nothing changed), AND the post-read must say `empty`. A slot that still reads
   * populated — or cannot be read — is NOT reported as cleared.
   */
  async clearCabSlot(opts: CabSlotQueryOptions = {}): Promise<CabSlotClearResult> {
    const page = opts.page ?? CAB_IR_PAGE_USER_BANKS[0]!;
    const index = opts.from ?? 0;
    if (opts.to != null && opts.to !== index) {
      throw new Error(`clearCabSlot: clearing is one slot at a time (got from ${index} to ${opts.to})`);
    }
    if (!Number.isInteger(index) || index < 0) throw new Error(`clearCabSlot: bad slot index ${index}`);
    if (page !== CAB_IR_PAGE_SCRATCHPAD && !CAB_IR_PAGE_USER_BANKS.includes(page)) {
      throw new Error(`clearCabSlot: page 0x${page.toString(16)} is not a user bank (0x10-0x13)`);
    }
    const before = (await this.queryCabSlots({ page, from: index, to: index }))[0]!;
    const bytes = buildBlankCabIrContainer(this.#prof.model, { index, page }); // throws on unmeasured geometry
    const dev = await this.#conn();
    const inbound: number[][] = [];
    const off = dev.onFrame((f) => inbound.push([...f]));
    try {
      if (dev.sendPaced) await dev.sendPaced(bytes);
      else await dev.sendQueued(bytes);
      await new Promise((r) => setTimeout(r, ACK_WINDOW_MS));
    } finally {
      off();
    }
    const expectedData = countDataFrames(bytes);
    const acks = interpretCabIrAcks(inbound, expectedData);
    const closeCode = acks.codes.find((c) => c.fn === CAB_IR_FN_END)?.code ?? null;
    const base = { index, page, wasPopulated: before.populated, closeCode, nowPopulated: null as boolean | null };
    if (closeCode !== CAB_IR_CLOSE_ACCEPTED) {
      return {
        ...base,
        ok: false,
        reason: closeCode === CAB_IR_CLOSE_MISMATCH
          ? 'the unit DISCARDED the blank container (close-ack 0x13) — the slot is unchanged'
          : `the blank container was not accepted (close answered ${closeCode === null ? 'nothing' : `0x${closeCode.toString(16)}`}, data acks ${acks.data}/${acks.expectedData}) — treat the slot as unchanged`,
      };
    }
    const after = (await this.queryCabSlots({ page, from: index, to: index }))[0]!;
    const nowPopulated = after.populated;
    if (nowPopulated === false) {
      return {
        ...base,
        nowPopulated,
        ok: true,
        reason: `cleared: the slot reads EMPTY after the blank container${before.populated === true ? ' (it held an IR before)' : ' (it was already empty)'}`,
      };
    }
    return {
      ...base,
      nowPopulated,
      ok: false,
      reason: nowPopulated === true
        ? 'NOT cleared: the slot still reads POPULATED after an accepted blank container'
        : `NOT confirmed: the slot state could not be read back (${after.note ?? 'unparsed reply'}) — do not assume it was cleared`,
    };
  }

  /**
   * Live cab-bank names — still NOT obtainable, now for a measured reason rather than an oversight.
   *
   * The cab/IR bank name tables are the device's "special table records" (param ids >= 0xff00), and
   * those are NOT param-addressable: a definition query for 0xfff0 (FACTORY 1) or 0xfff3 (USER) at the
   * CABINET block answers nothing (probed live 2026-10-08), which is exactly what the cache walker's
   * coverage note documents ("absent from a live walk by design"). They exist only in the device's
   * `.cache` byte dump — and the user banks are deliberately excluded from the shipped cache because
   * they are the donor unit's own IR library, not firmware content.
   *
   * So a user slot has NO name source in this stack, while FM3-Edit displays one: the name is stored
   * inside the slot's data (the same 32-char field the .syx container carries), and nothing in either
   * captured session reads it back. `queryCabSlots` is what CAN be read — occupancy, not names.
   */
  async #liveCabIrs(): Promise<Record<string, string[]>> {
    return {};
  }

  /** Cab block state for the IR picker: current mode (Legacy / DynaCab), per-slot bank + IR index +
   * dyna type, plus the option lists. IR names come from fractal-midi (profile.cabIrs() / GET /cab/irs).
   * Writes are plain setParam calls through the device-true CABINET_* param ids. */
  async cabState(eid: number) {
    const slug = slugForEffectId(eid) ?? '';
    const family = SLUG_FAMILY[slug.toLowerCase()];
    if (family !== 'CABINET') return { error: 'not a cab block' };
    let values: number[] = [];
    let base = 0;
    // A failed or torn cab bulk read must NOT be served as a zeroed cab state (mode 0 / bank 0 /
    // IR 0). Every consumer reads those zeros as "the cab is on Legacy, factory bank 0, IR 1" — a
    // FABRICATED state, and the same silent-failure class the P1.3 torn block read closed. Let it
    // throw: the route surfaces the failure and Axis's `.catch` clears the picker/summary rather than
    // showing a false state. (cabStateH has no catch of its own; the router's dispatch catch maps the
    // throw to a non-200, and the driver-level throw is the honest signal the read produced nothing.)
    {
      const dev = await this.#conn();
      const frames = await dev.request(this.#codec.buildBlockBulkReadPoll(eid), { timeoutMs: 2500, quietMs: 120, match: (fs) => fs.some((f) => f[5] === 0x76) });
      const bulk = this.#codec.assembleGen3BlockBulkRead(frames);
      if (bulk.values.length === 0 || bulk.values.length < bulk.itemCount) {
        throw new Error(`torn cab bulk read for eid ${eid}: got ${bulk.values.length} of ${bulk.itemCount} values`);
      }
      values = bulk.values;
      const activeCh = (await this.#statusByEffectId()).get(eid)?.channel ?? 0;
      base = this.#channelSlice(family, bulk, activeCh).base;
    }
    // discrete params store the ordinal; if it looks 16-bit-scaled, unscale against the known max
    // (base = this channel's slice of the bulk read — cab mode/bank/IR/dyna are per-channel, like everything else on the block)
    const ord = (id: number, max: number) => { const raw = values[base + id] ?? 0; return max > 0 && raw > max ? Math.round((raw / 65534) * max) : raw; };
    const pid = (name: string) => this.#paramId(family, name);
    const bankPids = [1, 2, 3, 4].map((n) => pid(`CABINET_BANK${n}`)).filter((x): x is number => x != null);
    const irPids = [1, 2, 3, 4].map((n) => pid(`CABINET_TYPE${n}`)).filter((x): x is number => x != null);
    const dynaPids = [1, 2, 3, 4].map((n) => pid(`CABINET_DYNACAB_TYPE${n}`)).filter((x): x is number => x != null);
    const modeParam = pid('CABINET_MODE') ?? 31;
    const bankOptionPid = bankPids[0] ?? 0;
    const dynaOptionPid = dynaPids[0] ?? 85;
    const bankOptions = this.#enumOptions(family, bankOptionPid, 'Bank', 0, 4).map((o) => o.label);
    const dynaLabels = this.#prof.enumLabelsFor(family, dynaOptionPid) ?? [];
    const dynaOptions = this.#enumOptions(family, dynaOptionPid, 'DynaCab Type', 0, Math.max(0, dynaLabels.length - 1));
    const modeOptions = this.#enumOptions(family, modeParam, 'Mode', 0, 1);
    const irBanks = await this.cabIrs(false);
    const slots = bankPids.slice(0, 2).map((bankParam, s) => {
      const irParam = irPids[s] ?? 4 + s;
      const dynaParam = dynaPids[s] ?? 85 + s;
      const bankV = ord(bankParam, bankOptions.length - 1);
      const bankLabel = bankOptions[bankV] ?? String(bankV);
      const list = irBanks[bankLabel] ?? [];
      const irIndex = ord(irParam, Math.max(0, list.length - 1));
      const dynaV = ord(dynaParam, Math.max(0, dynaOptions.length - 1));
      return { slot: s + 1, bankParam, irParam, dynaParam, bank: { value: bankV, label: bankLabel }, irIndex, irName: list[irIndex] ?? `#${irIndex}`, dyna: { value: dynaV, label: dynaOptions[dynaV]?.label ?? String(dynaV) } };
    });
    const modeV = ord(modeParam, 1);
    return { modeParam, mode: { value: modeV, label: modeOptions[modeV]?.label ?? '' }, modeOptions, bankOptions, dynaOptions, slots };
  }

  /** Per-block "meter" values for the always-on grid level fill + swipe controls.
   * For each placed block: one bulk read → the norm of its primary param (auto-picked Level/Mix/…)
   * plus any client-requested swipe-control paramIds (`wants[slug]`). One HTTP call, N serial reads. */
  async meters(wants: Record<string, number[]> = {}): Promise<
    { effectId: number; slug: string; defaultId: number; defaultName: string; typeName: string; vals: Record<number, MeterVal> }[]
  > {
    const g = await this.grid();
    const out: { effectId: number; slug: string; defaultId: number; defaultName: string; typeName: string; vals: Record<number, MeterVal> }[] = [];
    const dev = await this.#conn();
    const status = await this.#statusByEffectId().catch(() => new Map<number, { bypassed: boolean; channel: number }>());
    for (const c of g.cells) {
      if (c.isShunt) continue;
      const slug = slugForEffectId(c.effectId);
      const family = slug ? SLUG_FAMILY[slug] : undefined;
      if (!slug || !family) continue;
      const defs = this.#prof.params[family] ?? [];
      const knobs = defs.filter((p) => {
        const r = this.#prof.ranges[family]?.[p.paramId];
        if (r?.kind !== 'float' || r.displayMin === r.displayMax || (r.displayMin === 0 && r.displayMax === 1)) return false;
        const label = p.displayLabel ?? p.name;
        return KNOB_UNITS.has(p.unit ?? '') && !/bypass/i.test(label) && !/_/.test(label) && !/^[A-Z][A-Z0-9+]*$/.test(label);
      });
      const primary = knobs.find((p) => /level|mix|master|volume|gain|drive/i.test(p.displayLabel ?? p.name)) ?? knobs[0];
      if (!primary) continue;
      const wantIds = new Set<number>([primary.paramId, ...(wants[slug] ?? [])]);
      const vals: Record<number, MeterVal> = {};
      let typeName = '';
      try {
        const frames = await dev.request(this.#codec.buildBlockBulkReadPoll(c.effectId), { timeoutMs: 2000, quietMs: 100, match: (fs) => fs.some((f) => f[5] === 0x76) });
        const bulk = this.#codec.assembleGen3BlockBulkRead(frames);
        // A short/torn burst carries fewer records than the 0x74 head advertised; indexing past it
        // would FABRICATE a 0 level (a meter pinned to its minimum) or a bogus type name. Reject so the
        // catch below leaves this block's vals EMPTY — an honest "no reading" — instead of a zero fill.
        if (bulk.values.length < bulk.itemCount) {
          throw new Error(`torn meter bulk read for eid ${c.effectId}: got ${bulk.values.length} of ${bulk.itemCount} values`);
        }
        const activeCh = status.get(c.effectId)?.channel ?? 0;
        const { base } = this.#channelSlice(family, bulk, activeCh);
        for (const id of wantIds) {
          // No record at that ordinal (e.g. a client-requested id past the body) is UNKNOWN, never 0.
          const raw = bulk.values[base + id];
          if (typeof raw !== 'number') continue;
          const d = this.#display(family, id, raw);
          vals[id] = { norm: d.norm, value: d.value, unit: d.unit, min: d.min, max: d.max, log: d.log };
        }
        const typeId = this.#paramId(family, 'type');
        if (typeId != null) {
          const roster = this.#prof.rosterFor(slug);
          const tmax = Math.max(0, roster.length - 1);
          const rawT = bulk.values[base + typeId];
          if (typeof rawT === 'number') typeName = roster[rawT > tmax ? Math.round((rawT / 65534) * tmax) : rawT]?.name ?? '';
        }
      } catch {
        /* leave vals empty for this block */
      }
      out.push({ effectId: c.effectId, slug, defaultId: primary.paramId, defaultName: primary.displayLabel ?? primary.name, typeName, vals });
    }
    return out;
  }

  /** Live audio meters per placed monitored block. Reads each block's primary monitor level via the
   *  block-level GET (fn 0x01 sub 0x01 00 by effectId); the level is a normalized 0..1 float at
   *  response offset 12-16 (LSB-first 5×7bit → uint32 → float32-LE — confirmed from the FM3 capture
   *  2026-07-02; note the standard gen-3 float decoder does NOT apply to this field). Mapped to dB
   *  via the profile's monitor table. Gen-3 only; [] if the device has no monitor table. */
  async liveMonitors(onlyEid?: number): Promise<{ effectId: number; family: string; paramName: string; role: string; norm: number; db: number | null; minDb?: number; maxDb?: number }[]> {
    const mon = this.#prof.monitorParams;
    if (!mon) return [];
    // family → ALL its monitor defs (a block can expose several: OUTPUT VU L+R, M-Comp 3 bands, cab
    // gain+VU, drive gain+supply+headroom). Previously only the family's first def was read.
    const byFamily = new Map<string, { paramName: string; family: string; pid: number; role: string; minDb?: number; maxDb?: number }[]>();
    for (const [paramName, def] of Object.entries(mon)) {
      const arr = byFamily.get(def.family) ?? [];
      arr.push({ paramName, ...def });
      byFamily.set(def.family, arr);
    }
    const dev = await this.#conn();
    const model = this.#prof.model;
    const out: { effectId: number; family: string; paramName: string; role: string; norm: number; db: number | null; minDb?: number; maxDb?: number }[] = [];
    // Which block(s) to poll. Axis polls the OPEN block (onlyEid) at UI rate — resolve its family
    // straight from the effectId; do NOT fetch grid() here. grid()'s 500ms cache expires right at the
    // ~500ms meter-poll interval, so a full ~24KB preset dump was firing on every tick and serializing
    // behind every read → link latency ballooned to ~400ms. Only the (rare) all-blocks call needs grid().
    const eids = onlyEid != null ? [onlyEid] : (await this.grid()).cells.filter((c) => !c.isShunt).map((c) => c.effectId);
    for (const eid of eids) {
      const slug = slugForEffectId(eid);
      const family = slug ? SLUG_FAMILY[slug] : undefined;
      const defs = family ? byFamily.get(family) : undefined;
      if (!defs) continue;
      // Poll each monitor pid via the capture-confirmed fn 0x01 sub 0x19 state read (FM3-Edit's live-meter
      // poll; value is a normalized 0..1 float mapped to dB by the table's linear range). Model-generic.
      for (const def of defs) {
        try {
          const frames = await dev.request(buildBlockMonitorPoll(eid, def.pid, model), {
            timeoutMs: 800, quietMs: 40,
            match: (fs) => fs.some((f) => isBlockMonitorResponse(f, eid, def.pid))
          });
          const r = frames.find((f) => isBlockMonitorResponse(f, eid, def.pid));
          if (!r) continue;
          // The OUTPUT block's VU (eid 0x2a, pid 16/17 = sub 0x10/0x11) is the SAME frame as the
          // leveling meters → its value is RMS ENERGY, not a 0..1 norm. Decode it via 10·log10 and
          // renormalize into [min,max] for the bar. Every other block monitor is a 0..1 norm.
          let norm: number;
          let db: number | null;
          if (def.family === 'OUTPUT') {
            const lo = def.minDb ?? -40, hi = def.maxDb ?? 6;
            db = meterRmsToDb(parseOutputMeterRms(r), lo, hi);
            norm = hi > lo ? (db - lo) / (hi - lo) : 0;
          } else {
            norm = parseBlockMonitorNorm(r);
            db = def.minDb != null && def.maxDb != null ? def.minDb + norm * (def.maxDb - def.minDb) : null;
          }
          out.push({ effectId: eid, family: def.family, paramName: def.paramName, role: def.role, norm, db, minDb: def.minDb, maxDb: def.maxDb });
        } catch {
          /* skip this monitor */
        }
      }
    }
    return out;
  }

  /** Looper page telemetry: the live waveform envelope + playhead position + level (FM3 capture 2026-07-04;
   *  gen-3 shared). Waveform = fn 0x01 sub 0x23 (~595 raw 7-bit magnitudes → 0..1); position = sub 0x19
   *  pid 14 (0..1 across the loop); level = sub 0x19 pid 22. Returns empty with NO device I/O when the
   *  block isn't a looper, so Axis can poll it for whatever block is open without cost. */
  async looperTelemetry(eid: number): Promise<{ wave: number[]; position: number | null; level: number | null }> {
    if (slugForEffectId(eid) !== 'looper') return { wave: [], position: null, level: null };
    const dev = await this.#conn();
    const model = this.#prof.model;
    let wave: number[] = [];
    let position: number | null = null;
    let level: number | null = null;
    try {
      const wf = await dev.request(buildLooperWaveformPoll(eid, model), { timeoutMs: 900, quietMs: 60, match: (fs) => fs.some((f) => isLooperWaveformResponse(f, eid)) });
      const r = wf.find((f) => isLooperWaveformResponse(f, eid));
      if (r) wave = parseLooperWaveform(r);
    } catch { /* no waveform this tick */ }
    for (const [pid, isPos] of [[14, true], [22, false]] as const) {
      try {
        const fr = await dev.request(buildBlockMonitorPoll(eid, pid, model), { timeoutMs: 500, quietMs: 40, match: (fs) => fs.some((f) => isBlockMonitorResponse(f, eid, pid)) });
        const rr = fr.find((f) => isBlockMonitorResponse(f, eid, pid));
        if (rr) { const v = parseBlockMonitorNorm(rr); if (isPos) position = v; else level = v; }
      } catch { /* skip */ }
    }
    return { wave, position, level };
  }

  /** Toggle a looper transport control (record/play/stop/overdub/undo/once/reverse/half) — the sub-0x10
   *  float-1.0/0.0 write FM3-Edit uses (capture 2026-07-04). `action` resolves to the block's control pid
   *  via the device catalog, so it's model-agnostic. Fire-and-forget (serialized). */
  async looperControl(eid: number, action: string, on: boolean): Promise<{ ok: boolean }> {
    if (slugForEffectId(eid) !== 'looper') return { ok: false };
    const NAME: Record<string, string> = {
      record: 'LOOPER_RECORD', play: 'LOOPER_PLAY', stop: 'LOOPER_STOP', overdub: 'LOOPER_DUB',
      undo: 'LOOPER_UNDO', once: 'LOOPER_ONCE', reverse: 'LOOPER_REVERSE', half: 'LOOPER_HALF'
    };
    const name = NAME[action];
    if (!name) return { ok: false };
    const pid = (this.#prof.params['LOOPER'] ?? []).find((p) => p.name === name)?.paramId;
    if (pid == null) return { ok: false };
    const dev = await this.#conn();
    await dev.sendQueued(buildLooperControl(eid, pid, on, this.#prof.model));
    return { ok: true };
  }

  /** Build dropdown options for an enum param. Labels come from fractal-midi's enum overlay
   * (matched by device param name) where known; otherwise the bare ordinal.
   *
   * The list is bounded by the ORDINAL count the caller passes (from the catalog row's enumCount), never
   * by an arbitrary cap: a hard 128 silently dropped every ordinal past it, leaving the tail of long
   * dropdowns unselectable. MAX_ENUM_OPTIONS only guards against a bogus catalog row;
   * test/drivers/enum-coverage.test.ts asserts every served list matches its ordinal count. */
  #enumOptions(family: string, paramId: number, name: string, min: number, max: number): { value: number; label: string }[] {
    const cache = this.#prof.enumLabelsFor(family, paramId); // device-true labels from the editor cache
    const ov = resolveEnumValues(name); // III overlay fallback
    const out: { value: number; label: string }[] = [];
    // `min` is the row's displayMin, so `v` walks the value the DEVICE speaks for each option: the
    // display value for a scale-1 selector (min..max) or the ordinal for a scaled one (min=0). The
    // label tables (enumLabelsFor / the III overlay) are indexed from 0 by ORDINAL, so the label for a
    // value lives at `value - min`, NOT at `value`. For a scale-1 OFFSET selector (displayMin > 0) the
    // device stores the DISPLAY value — GLOBAL/7389 body raw 2 ↔ the panel's "2 SECONDS" (MEASURED
    // 2026-10-08, the panel is the oracle) — so reading the label at `value` shifted every label by one
    // and showed the option AFTER the true one. `min === 0` for every unscaled, non-offset enum, so this
    // is a no-op off the offset rows (the scaled PHASER_ORDER case and every 0-based list are unchanged).
    // Guarded by test/drivers/enum-coverage.test.ts (offset-label invariant over the real FM3 catalog).
    for (let v = min; v <= max && out.length < MAX_ENUM_OPTIONS; v++) {
      const i = v - min; // 0-based ordinal into the label tables
      out.push({ value: v, label: cache?.[i] ?? ov?.values?.[i] ?? String(v) });
    }
    return out;
  }

  /** Map a raw 0..65534 wire value to {value, norm, unit, min, max, log} via the device-true FM3 range.
   * Taper: a device-true explicit `range.taper` ('log'→log10; 'linear'|'flat'|'custom'→linear) wins;
   * absent it falls back to the typecode heuristic (middle nibble 4/5 = log10, e.g. freq cuts, else linear). */
  #display(family: string | undefined, paramId: number, raw: number): { value: number; norm: number; unit?: string; min?: number; max?: number; log?: boolean } {
    const norm = clamp01(raw / 65534);
    const range = family ? this.#prof.ranges[family]?.[paramId] : undefined;
    if (range && range.kind === 'float' && Number.isFinite(range.displayMin) && Number.isFinite(range.displayMax) && range.displayMin !== range.displayMax) {
      try {
        // Taper (log vs linear). A device-true explicit taper from the capture catalog WINS over the
        // typecode-nibble heuristic: 'log' → log sweep; 'linear' | 'flat' | 'custom' → linear. A
        // 'custom' taper's `taperPoints` are NOT applied on the wire yet, so custom is served linear
        // for now (the Axis side documents the same). A log sweep still requires a positive range —
        // wireToDisplay throws on log10 with displayMin<=0 — the same guard the nibble heuristic uses.
        // When NO explicit taper is present, fall back to the unchanged typecode-nibble heuristic.
        // `range.taper` reads device-true from a static-catalog row today, and reads the same field once
        // walk-built RangeDefs carry it (parallel WP) — no rework needed here either way.
        let log: boolean;
        if (range.taper) {
          log = range.taper === 'log' && range.displayMin > 0;
        } else {
          const taperNib = (range.typecode >> 4) & 0xf;
          log = (taperNib === 4 || taperNib === 5) && range.displayMin > 0;
        }
        const v = wireToDisplay(raw, { displayMin: range.displayMin, displayMax: range.displayMax, displayScale: log ? 'log10' : 'linear' });
        // Prefer the DEVICE-TRUE unit captured by the live-walk (RangeDef.unit, view 0x00)
        // over the AM4-name-overlay catalog code; fall back to the overlay when absent
        // (byte-source/.cache profiles carry no device-true unit).
        const unitCode = family ? this.#prof.params[family]?.find((x) => x.paramId === paramId)?.unit : undefined;
        return { value: round3(v), norm, unit: range.unit ?? ((unitCode && UNIT_LABEL[unitCode]) || undefined), min: range.displayMin, max: range.displayMax, log: log || undefined };
      } catch {
        /* fall through to 0..10 position */
      }
    }
    return { value: Math.round(norm * 1000) / 100, norm }; // 0..10 fallback
  }

  /** Resolve a param name (display label) → device-true paramId. 'Type' → the model-selector,
   *  in strict preference order:
   *    1. `<FAM>_MODEL` — DELAY: its `DELAY_TYPE` is the 8-value MONO/STEREO routing enum, the
   *       real model list lives on `DELAY_MODEL` (cache-confirmed FM3/FM9/III 2026-07-06);
   *    2. the EXACT `<FAM>_TYPE` name regardless of unit — the FM3/FM9 device-true catalogs tag
   *       it `unverified`, and the old `unit==='enum' && /TYPE$/` heuristic then matched a
   *       DIFFERENT selector entirely (FUZZ → FUZZ_CLIPTYPE pid 10, PITCH → PITCH_XFADETYPE
   *       pid 46; III DYNDIST → DYNDIST_BQTYPE) — so the Drive block's "type" read AND wrote
   *       the clipping-diode param (the field-reported drive-type bug);
   *    3. the enum-unit /TYPE$/ heuristic, as the last resort for families with neither. */
  #paramId(family: string, name: string): number | undefined {
    const defs = this.#prof.params[family] ?? [];
    if (name.toLowerCase() === 'type') {
      // The family's layout-variant selector. MODEL / TYPE come first (amps, drives, chorus…); MODE
      // covers families whose layout switches on a mode flag rather than a model — CABINET (0=Legacy
      // IR page, 1=DynaCab page) and RESONATOR (Manual/Chordal). Without MODE the loose /TYPE$/ match
      // below fell through to CABINET_PRETYPE, so the cab's page (and the DynaCab mic graph) flipped
      // with the unrelated PREAMP type, and the Preamp Type dropdown was hidden from the client.
      return (defs.find((p) => p.name === `${family}_MODEL`)
        ?? defs.find((p) => p.name === `${family}_TYPE`)
        ?? defs.find((p) => p.name === `${family}_MODE`)
        ?? defs.find((p) => p.unit === 'enum' && /TYPE$/i.test(p.name)))?.paramId;
    }
    return defs.find((p) => p.displayLabel === name || p.name === name)?.paramId;
  }

  // ── device-edit push (capability deviceEditPush): reflect front-panel / editor edits the device
  // broadcasts unsolicited (0x74/0x75/0x76). The registry's persistent RX listener hands us the
  // reassembled burst; we diff it against the last-known channel-A values so a whole-block packet
  // yields only the moved param(s). blockParams() primes the baseline when a block is opened. ──
  #editSnapshot = new Map<number, number[]>(); // effectId → last-known active-channel wire values
  #watchedEid: number | null = null; // FM3 poll target: the block Axis last opened (set in blockParams)
  #watchedChannel = 0; // active channel (0-3) of the watched block — the burst slice the poll diffs against
  #lastLocalEditAt = 0; // ms of the last local param write — the FM3 poll pauses briefly after (no self-echo)
  // W2.3 (option B): round-robin sweep of the OTHER placed blocks, so a front-panel edit is reflected even
  // when no block is open in Axis (or the edit is on a block the user is not looking at). The FM3 pushes
  // nothing, so polling is the only mechanism; one block per tick keeps the marginal cost at a single
  // fn-0x1F read — the same read the open-block path already makes.
  #sweepCursor = 0;
  #placedCache: { eids: number[]; at: number } | null = null;
  static PLACED_TTL_MS = 10_000; // how long the placed-block list may be reused before a fresh status read

  /** FM3 device-edit POLL (capability deviceEditWatch — FM3 doesn't push, unlike FM9/III). The registry
   *  supervisor calls this on a timer; we re-read the open block (if any) via the fn-0x1F bulk read and
   *  reuse decodeEditBurst's diff to emit per-param `param` events for any knob moved on the front panel,
   *  then sweep ONE other placed block round-robin so an edit the user is not looking at is not lost.
   *  Returns {changed:true} when the caller should emit a structural `changed` (first sight on the
   *  open-block path, or a type-selector move anywhere); per-param events are emitted directly here.
   *  Paused for ~2s after a local write so it never echoes our own edit mid-drag. */
  async readDeviceEditState(): Promise<{ changed: boolean }> {
    if (Date.now() - this.#lastLocalEditAt < 2000) return { changed: false }; // mid local edit → skip (avoid echo)
    let changed = false;
    const open = this.#watchedEid;
    if (open != null) changed = await this.#readEditBlock(open, false);
    // W2.3: sweep one OTHER placed block per tick (round-robin). Cheap by construction — the placed list
    // is reused from the channel watch's own status dump for up to PLACED_TTL_MS, and the sweep itself is
    // one fn-0x1F read, so a tick costs at most the same as the open-block read.
    const targets = (await this.#sweepTargets()).filter((e) => e !== open);
    if (targets.length > 0) {
      const eid = targets[this.#sweepCursor % targets.length]!;
      this.#sweepCursor++;
      if (await this.#readEditBlock(eid, true)) changed = true;
    }
    return { changed };
  }

  /** Read one block's fn-0x1F body and diff it against its baseline. `primeQuietly` marks a SWEEP visit:
   *  the first sight of a block records the baseline without asking for a full reload (otherwise the
   *  first cycle would request one preset reload per placed block). Returns true when the caller should
   *  emit a structural `changed` — i.e. the family's model/type selector moved, which a param diff alone
   *  cannot express (the tile's model name comes from a fresh read). */
  async #readEditBlock(eid: number, primeQuietly: boolean): Promise<boolean> {
    const dev = await this.#conn();
    let frames: number[][];
    try {
      frames = await dev.request(this.#codec.buildBlockBulkReadPoll(eid), { timeoutMs: dev.slow ? 4000 : 1500, quietMs: dev.slow ? 300 : 100, match: (fs) => fs.some((f) => f[5] === 0x76) });
    } catch { return false; } // no reply / timeout — keep last baseline
    if (primeQuietly && !this.#editSnapshot.has(eid)) {
      try {
        const bulk = this.#codec.assembleGen3BlockBulkRead(frames);
        const family = SLUG_FAMILY[(slugForEffectId(eid) ?? '').toLowerCase()] ?? this.#prof.familyForEffectId(eid);
        // Seed the diff baseline from the positional body (the fn=0x1F body is pid-indexed — see
        // blockParams): the first sweep visit records it without a reload, later edits diff per-param.
        if (family && bulk.values.length > 0) {
          const { base } = this.#channelSlice(family, bulk, 0);
          this.#editSnapshot.set(eid, bulk.values.slice(base));
        }
      } catch { /* head-only / unreadable → stay unprimed, retry next cycle */ }
      return false;
    }
    const res = this.decodeEditBurst(frames);
    if (res.reload) return true; // first sight (open-block path) → let the registry emit a reload
    for (const e of res.events) this.#emit({ type: 'param', effectId: e.effectId, paramId: e.paramId, norm: e.norm });
    return res.structural;
  }

  /** Placed effect ids the sweep may target, cheapest source first: the list the registry's channel watch
   *  already produced (fn-0x13 status dump — opportunistic, no extra traffic), else one status read.
   *  Shunts and unmapped ids are filtered out: they have no param family to diff. */
  async #sweepTargets(): Promise<number[]> {
    let eids: number[] | null = null;
    if (this.#placedCache && Date.now() - this.#placedCache.at < Gen3Driver.PLACED_TTL_MS) eids = this.#placedCache.eids;
    if (!eids) {
      const chans = await this.getActiveChannels().catch(() => new Map<number, number>());
      eids = [...chans.keys()];
      this.#placedCache = { eids, at: Date.now() };
    }
    return eids
      .filter((e) => !!(SLUG_FAMILY[(slugForEffectId(e) ?? '').toLowerCase()] ?? this.#prof.familyForEffectId(e)))
      .sort((a, b) => a - b);
  }

  decodeEditBurst(frames: number[][]): { events: { effectId: number; paramId: number; norm: number }[]; reload: boolean; structural: boolean } {
    let bulk: ReturnType<ModernFractalCodec['assembleGen3BlockBulkRead']>;
    try { bulk = this.#codec.assembleGen3BlockBulkRead(frames); } catch { return { events: [], reload: false, structural: false }; }
    const eid = bulk.blockId;
    if (bulk.values.length === 0) return { events: [], reload: false, structural: false }; // head-only / empty — nothing to read
    const family = SLUG_FAMILY[(slugForEffectId(eid) ?? '').toLowerCase()] ?? this.#prof.familyForEffectId(eid);
    const defs = family ? (this.#prof.params[family] ?? []) : [];
    if (!family || defs.length === 0) return { events: [], reload: false, structural: false }; // no param family mapped
    // The fn=0x1F body is positional AND pid-indexed (the eid-1 GLOBAL body is 14,880 records and
    // body[7115] tracks the panel — see blockParams), so a moved param is decoded from its own record.
    // The per-pid honesty in the loop below is what prevents a fabricated norm: a record the body does
    // not carry (`cur[id] === undefined`) is SKIPPED, never coerced to 0.
    //
    // The skip MUST key on the body's ACTUAL EXTENT, not on the catalogue stride. The catalogue gives
    // GLOBAL a stride of 186, but its body is 14,880 pid-indexed records — so a GLOBAL pid >= 186 has a
    // real record (Brightness 7115, Contrast 7116) and a `id >= stride` skip silently dropped every
    // GLOBAL front-panel edit at or above the catalogue stride, leaving the UI on a stale value. A pid
    // whose record the body genuinely does not carry (a torn/short tail) is still skipped —
    // `cur[id] === undefined`.
    //
    // Slice from the block's ACTIVE channel base (the one blockParams surfaced) to the END of the body.
    // For a channel-blocked family (amp, cab, …) every real pid is < its catalogue stride, so the
    // channel's records are exactly `values[base .. base+stride)` and the tail past them is never
    // indexed; for the pid-indexed GLOBAL body the extent IS the body length. Diffing against channel A
    // while the user has B-D open would flag every A/B-different param as "moved", so keep the base.
    const { base } = this.#channelSlice(family, bulk, eid === this.#watchedEid ? this.#watchedChannel : 0);
    const cur = bulk.values.slice(base);
    const prev = this.#editSnapshot.get(eid);
    this.#editSnapshot.set(eid, cur);
    // First sight of this block (never opened) → we can't diff. Ask the registry for a full reload so the
    // edit isn't lost; subsequent edits on this block then diff per-param.
    if (!prev) return { events: [], reload: true, structural: false };
    const typeId = this.#paramId(family, 'type'); // the family's model/type selector, if it has one
    const events: { effectId: number; paramId: number; norm: number }[] = [];
    let structural = false;
    for (const p of defs) {
      const id = p.paramId;
      if (cur[id] === undefined || cur[id] === prev[id]) continue; // record the body doesn't carry / unchanged → skip
      if (!this.#prof.ranges[family]?.[id]) continue; // only real controls (skip internal/bypass churn)
      if (typeId != null && id === typeId) structural = true; // a model change is not just a knob nudge
      events.push({ effectId: eid, paramId: id, norm: clamp01((cur[id] ?? 0) / 65534) });
    }
    return { events, reload: false, structural };
  }

  // ── writes (all address the exact placed instance by effect id) ──
  async setParam(eid: number, paramId: number, value: number, continuous: boolean) {
    // continuous knob writes stream at high frequency → fire-and-forget (instant);
    // a discrete write (enum) is rarer + worth confirming, so reject-watch it.
    // Stamp the local-edit window BEFORE sending (not after the await): the discrete #write waits up to
    // its 250 ms window, so a stamp placed after it leaves that whole gap uncovered — the FM3 device-edit
    // poll could run mid-wait and echo our own write back. Stamping first also means a write that THROWS
    // still pauses the poll (the frame may have reached the device before the throw).
    this.#lastLocalEditAt = Date.now(); // pause the FM3 device-edit poll briefly so it doesn't echo our own write mid-drag
    const r = continuous ? await this.#send(this.#codec.buildSetParameterContinuous(eid, paramId, clamp01(value))) : await this.#write(this.#codec.buildSetParameter(eid, paramId, value));
    // W1.2: the `param` event's `norm` is the 0..1 NORMALIZED value (drivers/types.ts). A discrete
    // write's `value` is the enum/model ORDINAL, so broadcasting it as a norm handed every other
    // window a value far outside 0..1 (Axis applies `p.norm = e.norm` verbatim). The event has no
    // field for an ordinal, so a discrete write emits nothing — the reader surfaces the new ordinal
    // on the next reload. Continuous keeps the (clamped) knob position.
    if (continuous) this.#emit({ type: 'param', effectId: eid, paramId, norm: clamp01(value) });
    return r;
  }
  /** Change a block's model/type (the family TYPE selector ordinal). */
  async setType(eid: number, value: number) {
    const family = SLUG_FAMILY[(slugForEffectId(eid) ?? '').toLowerCase()];
    const tid = family ? this.#paramId(family, 'type') : undefined;
    if (tid == null) return { ok: false };
    // W1.4: stamp the local-edit window BEFORE sending (same fix as setParam — see there) so the FM3
    // device-edit poll pauses ~2 s, covering the 250 ms #write window, and does not re-read the type we
    // just wrote and emit it back as a spurious param event; also stamped even if the write throws.
    this.#lastLocalEditAt = Date.now();
    const r = await this.#write(this.#codec.buildSetParameter(eid, tid, value));
    this.#emit({ type: 'changed', scope: 'grid' });
    return r;
  }
  // W1.1: bypass and channel are write ops named in docs/write-protocol.md's op table, so they use
  // #write to watch a short window for a 0x64 rejection of the function they sent (the accept/reject
  // model). Trade-off: this adds up to the #write window (250 ms) to an "instant" toggle. Other
  // fire-and-forget paths (a continuous knob stream, tapTempo, selectCell) keep #send — the contract
  // does not demand a watch there.
  async setBypass(eid: number, bypassed: boolean) {
    const r = await this.#write(this.#codec.buildSetBypass(eid, bypassed));
    this.#emit({ type: 'changed', scope: 'grid' });
    return r;
  }
  async setChannel(eid: number, channel: string) {
    const idx = CH_LETTERS.indexOf(channel.toUpperCase());
    if (idx < 0 || idx > 3) return { ok: false };
    const wireChannel = idx as 0 | 1 | 2 | 3;
    const frame = this.#prof.sceneChannelWriteMode === 'fm3-edit-fn01'
      ? this.#codec.buildSetChannelNative(eid, wireChannel)
      : this.#codec.buildSetChannel(eid, wireChannel);
    const r = await this.#write(frame); // watch for the channel write's own 0x64 rejection
    // W1.3: if this is the block the FM3 edit poll is watching, move the watch to the new channel so
    // decodeEditBurst diffs the channel the user is now on (else a front-panel knob move on the new
    // channel is diffed against the old channel's slice and dropped). Only the watched eid matters —
    // decodeEditBurst uses #watchedChannel only when its eid === #watchedEid.
    if (r.ok && eid === this.#watchedEid) this.#watchedChannel = wireChannel;
    this.#emit({ type: 'blockState', effectId: eid });
    return r;
  }

  /**
   * Bind a modifier slot to a target parameter. The modifier→target link lives on the modifier's own
   * eid as two params: targetEffectId (the block) + targetParam (the paramId), plus the source. Slot is
   * 1-based; slot N = modModel.effectId + (N-1). Writes the three discrete SETs that activate the link.
   */
  async bindModifier(slot: number, targetEffectId: number, targetParam: number, source: number) {
    const mm = this.#prof.modModel;
    if (!mm) return { ok: false, error: 'device has no modifier model' };
    const f = mm.fields;
    if (!f.targetEffectId || !f.targetParam || !f.source) {
      return { ok: false, error: 'modifier model is missing the target-binding fields (source/targetEffectId/targetParam)' };
    }
    const slotEid = mm.effectId + (Math.max(1, Math.floor(slot)) - 1);
    await this.#write(this.#codec.buildSetParameter(slotEid, f.targetEffectId.pid, targetEffectId));
    await this.#write(this.#codec.buildSetParameter(slotEid, f.targetParam.pid, targetParam));
    await this.#write(this.#codec.buildSetParameter(slotEid, f.source.pid, source));
    return { ok: true, slotEid, slot, targetEffectId, targetParam, source };
  }

  /** Modifier address model for GET /mod/model — the profile's ModModel plus the Phase-6 superset
   *  field `bindingSupported` (gen-3 binds via /mod/bind). Prepended so the JSON stays additive-only
   *  against the pre-Phase-6 sweep baseline. */
  modifierModel(): Record<string, unknown> | null {
    const mm = this.#prof.modModel;
    return mm ? { bindingSupported: true, ...mm } : null;
  }

  // ── tempo / scene ──
  /** Current tempo (BPM). Parsed via the bound codec's 0x14 payload parser (LSB-first septet pair). */
  async getTempo(): Promise<{ bpm: number }> {
    const dev = await this.#conn();
    const frames = await dev.request(this.#codec.buildGetTempo(), { timeoutMs: 1200, match: (fs) => fs.some((f) => f[5] === 0x14) });
    const f = frames.find((x) => x[5] === 0x14);
    if (!f) return { bpm: 0 };
    return { bpm: this.#codec.parseTempoResponse(f).bpm };
  }
  /** Set tempo the way FM3-Edit does (captured): a param write at the global-tempo address,
   * BPM as a 5-septet float32 value. (The 0x14 SET appears not to take on FM3.) */
  async setTempo(bpm: number) {
    await (await this.#conn()).sendQueued(buildSetTempoViaParam(bpm, this.#prof.model));
    this.#emit({ type: 'tempo', bpm });
    return { ok: true };
  }
  async tapTempo() {
    return this.#send(this.#codec.buildTempoTap());
  }
  /** Current scene index (0-based). Parsed via the bound codec's 0x0C payload parser. */
  async getScene(): Promise<{ index: number }> {
    const dev = await this.#conn();
    const frames = await dev.request(this.#codec.buildGetScene(), { timeoutMs: 1200, match: (fs) => fs.some((f) => f[5] === 0x0c) });
    const f = frames.find((x) => x[5] === 0x0c);
    if (!f) return { index: -1 }; // FAILED read (racy/late on a busy link) — sentinel so the scene watch
    //                               and UI skip it, instead of fabricating scene 1 (caused a 2↔1 badge flicker)
    return { index: this.#codec.parseSceneResponse(f).scene };
  }
  async setScene(index: number) {
    if (index < 0 || index > 7) return { ok: false };
    const frame = this.#prof.sceneChannelWriteMode === 'fm3-edit-fn01'
      ? this.#codec.buildSetSceneNative(index)
      : this.#codec.buildSetScene(index);
    const r = await this.#send(frame);
    // scene selects per-scene bypass/channel; status is read fresh each placedBlocks() call, so no
    // cache to bust — just notify subscribers so the UI follows.
    this.#emit({ type: 'scene', index });
    return r;
  }
  /** Rename a scene (0..7) in the WORKING BUFFER (fn 0x01 sub 0x2b, via fractal-midi's buildSetSceneName).
   *  Visible immediately; NOT persisted to flash — that's a separate store op. Name is 32-char ASCII max.
   *  #write watches briefly for a 0x64 rejection so the caller learns if the device refused it. */
  async setSceneName(index: number, name: string) {
    if (index < 0 || index > 7) return { ok: false };
    const clean = (name ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 32); // printable ASCII, 32 max
    return this.#write(this.#codec.buildSetSceneName(index, clean));
  }
  /** Rename the working-buffer PRESET (fn 0x01 sub 0x28, via fractal-midi's buildRenamePreset). Visible
   *  immediately; persist to flash is the separate store op. Name is 32-char printable ASCII max. */
  async setPresetName(name: string) {
    const clean = (name ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 32);
    return this.#write(this.#codec.buildRenamePreset(clean));
  }
  async placeCell(row: number, col: number, blockId: number) {
    // W1.5: the codec's buildSetGridCell backstop is the III's 14 columns, so bound to THIS device's
    // own grid shape first — an FM3 (4x12) col of 13/14 would otherwise encode a gridPos past the
    // device's grid with no rejection. 1-indexed, matching the /preset/grid/cell contract.
    const { rows, cols } = this.#prof;
    if (!Number.isInteger(row) || row < 1 || row > rows || !Number.isInteger(col) || col < 1 || col > cols) {
      const err = new Error(`${this.#prof.name} grid is ${rows}x${cols}; row/col must be 1..${rows}/1..${cols} (got ${row}/${col})`);
      (err as Error & { statusCode?: number }).statusCode = 400; // client error, not a server fault
      throw err;
    }
    // Guard against placing an instance the unit doesn't have (e.g. Amp 2 on an FM3, which has one
    // amp). The protocol reserves an ID range per family but each unit allows fewer — reject here so
    // the rule is authoritative server-side, not just a UI hint, and we don't waste a doomed write.
    const ref = blockRefForEid(blockId);
    if (ref) {
      const limit = this.#prof.instanceLimits[ref.slug] ?? this.#prof.defaultInstances;
      if (ref.instance > limit) {
        const err = new Error(`${this.#prof.name} has no ${ref.slug} ${ref.instance} (max ${limit} of this block)`);
        (err as Error & { statusCode?: number }).statusCode = 400; // client error, not a server fault
        throw err;
      }
    }
    // FM3 needs a cell-select (sub 0x30) before the insert (sub 0x32), or the block
    // lands at the default cell. buildClearBlock IS that select frame (no-op on an
    // empty cell). For blockId 0 this becomes select + insert-0 = clear, like the C#.
    await this.#write(this.#codec.buildClearBlock({ row, col, rows: this.#prof.rows }));
    const r = await this.#write(this.#codec.buildSetGridCell({ row, col, blockId, rows: this.#prof.rows }));
    this.#gridCache = null;
    this.#emit({ type: 'changed', scope: 'grid' });
    return r;
  }
  /** Move the device's edit cursor to a cell (sub 0x30) so the FM3 screen follows the UI.
   * Non-destructive: this is the cursor-select frame (no companion = no clear). */
  async selectCell(row: number, col: number) {
    return this.#send(this.#codec.buildClearBlock({ row, col, rows: this.#prof.rows }));
  }
  async cable(srcRow: number, srcCol: number, destRow: number, connect: boolean) {
    const r = await this.#write(this.#codec.buildSetGridRouting({ srcRow, srcCol, destRow, rows: this.#prof.rows, op: connect ? ROUTING_OP_CONNECT : ROUTING_OP_DISCONNECT }));
    this.#gridCache = null;
    this.#emit({ type: 'changed', scope: 'grid' });
    return r;
  }
  async selectPreset(n: number) {
    this.#gridCache = null;
    const r = await this.#write(this.#codec.buildSwitchPresetSysEx(n));
    this.#emit({ type: 'changed', scope: 'preset' });
    return r;
  }
  /** Reload the CURRENT preset from flash by re-selecting it — the FULL-mode self-describe walk's
   *  non-destructive per-block safety net. Reuses presetRef() (current number) + selectPreset() (the
   *  wire builder), so no new preset-switch bytes are minted here. No-op when no preset is resolvable. */
  async reloadPreset(): Promise<void> {
    const { number } = await this.presetRef();
    if (number >= 0) await this.selectPreset(number);
  }
  async store(n: number) {
    return this.#write(this.#codec.buildStorePreset(n));
  }

  /** Load a raw preset dump (.syx bytes) straight into the device's EDIT BUFFER — no slot is touched
   *  (only `store` writes a slot). This is how you play a preset that isn't on the device (e.g. a
   *  cloud-only backup), sidestepping the slot limit. Sent paced (the FM3 CDC drops a flooded write).
   *
   *  The dump's preset-dump header (func 0x77) carries the TARGET slot as a 14-bit, MSB-first
   *  7-bit pair. A dump captured from slot N still names N — re-sending it verbatim makes the unit
   *  treat it as a store-to-N, NOT a load. Retargeting the header to 0x3FFF (`7F 7F`, the
   *  edit-buffer sentinel) is exactly what FM3-Edit's "Audition" does: the preset goes live in the
   *  edit buffer, no slot is written. We patch that field and fix the frame checksum in place. */
  async loadPresetBytes(syx: Uint8Array): Promise<{ ok: boolean }> {
    const dev = await this.#conn();
    const bytes = Array.from(syx);
    retargetPresetDumpToEditBuffer(bytes);
    if (dev.sendPaced) await dev.sendPaced(bytes);
    else await dev.sendQueued(bytes);
    this.#gridCache = null; // edit buffer changed → next grid/blocks read reflects it
    return { ok: true };
  }

  /**
   * Upload a user-cab IR `.syx` container to the unit (§2.5 user-cab IR management).
   *
   * ESTABLISHED (capture + load test, 2026-10-08, FM3-Edit 1.07.16 → FM3 fw 13.0): the container IS the
   * wire stream. A USBPcap capture of the editor loading an IR shows `0x7A` + 8×`0x7B` (byte-identical to
   * the .syx) + `0x7C`, each acknowledged. Replaying the file against a destination drew the SAME acks —
   * start, all 8 data frames, end — so this method now LISTENS and reports them; `ok` means
   * "acknowledged frame by frame", which is the evidence the editor itself relies on.
   *
   * TWO THINGS THE MEASUREMENTS CHANGED:
   *   1. The export's start payload is `7F 7F` — a "no destination" sentinel — and the unit REFUSES it
   *      (code 0x16), where a real destination gets code 0x00. So `dest` is required; there is no
   *      "send it as it came out of the file" path, because that path is measured-refused.
   *   2. Page `0x20` (the 16 scratchpad memories) is REFUSED as an upload destination in every probe;
   *      only the user banks (`0x10`–`0x13`) are accepted. Scratchpad uploads are therefore refused here
   *      rather than sent to be discarded.
   *
   * STILL NOT ESTABLISHED: that the stored IR is correct or audible — nothing on this firmware reads a
   * slot's name back (`fn=0x12` is refused), so a rename is additionally gated behind `allowUnverified`
   * (the 0x7C value is carried verbatim and its coverage is unknown). Report "acknowledged", and give a
   * human the thing to look at.
   */
  async uploadCabIr(
    syx: Uint8Array,
    opts: CabIrUploadOptions = {},
  ): Promise<CabIrUploadResult> {
    if (!opts.dest) {
      throw new Error(
        'uploadCabIr: a destination is required. The export container carries the 7F 7F "no destination" ' +
        'sentinel and the unit REFUSES that start frame (measured 2026-10-08: code 0x16, and every data ' +
        'frame then fails with "bad message length"). Pass dest = cabIrUserSlot(n) — pages 0x10-0x13.',
      );
    }
    if (opts.dest.page === CAB_IR_PAGE_SCRATCHPAD) {
      throw new Error(
        'uploadCabIr: the unit REFUSES IR uploads to the scratchpad bank (page 0x20) — probed in every ' +
        'form on 2026-10-08 and refused while every user-bank page was accepted. Use cabIrUserSlot(n); ' +
        'if a scratchpad target is wanted, the copy has to be made from a user slot on the unit.',
      );
    }
    // A RENAME is no longer gated: it is MEASURED-WORKING (2026-10-08). The name's 8 chunks feed the
    // close frame's checksum, `buildCabIrSyx` now RECOMPUTES that value for the rewritten container, and
    // the unit answered close-code 0x00 with the destination slot becoming POPULATED. Carrying the stale
    // close (the old behaviour) is what drew 0x13 and made the unit discard the upload.
    const dev = await this.#conn();
    const parsed = parseCabIrSyx(syx); // strict: throws with a precise reason on anything unexpected
    if (parsed.modelId !== this.#prof.model) {
      throw new Error(
        `uploadCabIr: the container carries model byte 0x${parsed.modelId.toString(16)} but this device is ` +
        `0x${this.#prof.model.toString(16)} — an IR container is device-family specific and a wrong-model ` +
        'replay is exactly the plausible-but-wrong failure this stack refuses to make.',
      );
    }
    const bytes = buildCabIrSyx(parsed, { name: opts.name, dest: opts.dest, recomputeClose: opts.recomputeClose !== false });
    const expectedData = parsed.frames.filter((f) => f[5] === CAB_IR_FN_DATA).length;

    // FAIL CLOSED on a self-inconsistent container: the unit validates the close frame's value against
    // the content and DISCARDS a mismatch (close-ack 0x13, destination untouched — measured in four
    // controlled arms). `buildCabIrSyx` recomputes it, so this asserts the bytes we are about to send
    // really are consistent — it would catch a codec regression rather than discovering it on the unit.
    const required = computeCabIrClosePayload(bytes);
    const outgoingClose = parseCabIrSyx(bytes).endPayload;
    if (required.join(',') !== outgoingClose.join(',')) {
      if (opts.allowUnverified !== true) {
        throw new Error(
          `uploadCabIr: refusing to send a container the unit will DISCARD — its close frame carries ` +
          `${outgoingClose.join(' ')} but its content requires ${required.join(' ')}. The unit answers ` +
          `close-code 0x13 and leaves the destination untouched (measured). Pass { allowUnverified: true } ` +
          `only to MEASURE that discard.`,
        );
      }
    }

    // LISTEN while sending. A paced send is fire-and-forget, so the device's answer — the only wire-side
    // evidence there is — would otherwise be discarded. The editor's own upload was acknowledged frame by
    // frame; a silent send is NOT acceptance.
    const inbound: number[][] = [];
    const off = dev.onFrame((f) => inbound.push([...f]));
    try {
      if (dev.sendPaced) await dev.sendPaced(bytes);
      else await dev.sendQueued(bytes);
      await new Promise((r) => setTimeout(r, ACK_WINDOW_MS));
    } finally {
      off();
    }
    const acks = interpretCabIrAcks(inbound, expectedData);
    // The close frame's answer is not decoration — it decides whether the unit KEPT the upload.
    // Measured (four controlled arms, 2026-10-08): close code 0x00 = the container's close value
    // matches its content and the upload is stored; 0x13 = mismatch, and the unit DISCARDS the whole
    // upload leaving the destination untouched (an EMPTY destination stayed empty in every 0x13 arm).
    // So `ok` requires both the complete ack set and a 0x00 close answer.
    const closeCode = acks.codes.find((c) => c.fn === CAB_IR_FN_END)?.code ?? null;
    const discarded = closeCode === CAB_IR_CLOSE_MISMATCH;
    const reason = discarded
      ? 'the unit DISCARDED this upload: the close frame answered 0x13, its content check failed (the ' +
        'container\'s close value does not match the data sent). The destination slot was NOT written — ' +
        'a destination that was empty stays empty (measured). Any change to the container (rename, ' +
        'converted samples) needs the close value RECOMPUTED, which is not decoded yet.'
      : acks.complete && closeCode === CAB_IR_CLOSE_ACCEPTED
        ? 'every frame acknowledged and the close frame answered 0x00 — the unit accepted the container.'
        : acks.complete
          ? `every frame acknowledged but the close frame answered ${closeCode === null ? 'nothing' : `0x${closeCode.toString(16)}`} — acceptance NOT established.`
          : `not all frames acknowledged (start=${acks.start}, data ${acks.data}/${acks.expectedData}, end=${acks.end}) — treat as failed.`;
    return {
      ok: acks.complete && closeCode === CAB_IR_CLOSE_ACCEPTED,
      discarded,
      closeCode,
      reason,
      name: opts.name ?? parsed.name,
      modelId: parsed.modelId,
      frames: parsed.frames.length,
      bytes: bytes.length,
      sampleSlots: parsed.sampleSlots,
      renamed: opts.name !== undefined,
      dest: opts.dest,
      acks: {
        start: acks.start,
        data: acks.data,
        expectedData: acks.expectedData,
        end: acks.end,
        complete: acks.complete,
        codes: acks.codes.map((c) => ({ ...c })),
      },
    };
  }
}

function clamp01(v: number) { return Math.max(0, Math.min(1, v)); }
function round3(v: number) { return Math.round(v * 1000) / 1000; }

/** Create a gen-3 driver bound to one device profile (Axe-Fx III / FM3 / FM9). */
export function createGen3Driver(profile: DeviceProfile, ctx: DriverCtx): Gen3Driver {
  return new Gen3Driver(profile, ctx);
}
export type { Gen3Driver };
