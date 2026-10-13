// Shared driver contract + the DTO shapes every route serves. The DTOs moved verbatim from the
// pre-driver Device/Am4Device modules — their JSON shapes are the HTTP contract Axis consumes and
// must not drift. `DeviceDriver` is the per-device surface the routes call; methods a device lacks
// are optional and mirrored by `DriverCapabilities` so routes can answer 501 instead of guessing.
import type { DecodedBlock, PerformPage, PerformSlot, PerPresetSwitch, PerPresetSwitches } from 'forgefx-midi/devices/gen3';
import type { TypeModel, DeviceLayout, DeviceProfile } from '../devices.js';
import type { Transport } from '../transport/types.js';
import type { TelemetryMode, CadenceProfile } from './telemetryProfiles.js';

/** One decoded modifier assignment from a gen-3 preset body: a modulation SOURCE routed onto a
 *  target block parameter. `targetEffectId` is resolved from the preset's placed grid (null when the
 *  decoded target name isn't a placed block — e.g. a stale/empty pre-chain entry); `slot` is the
 *  1-based modifier slot when the assignment lives in the body's pre-chain modifier table (null for a
 *  chain-embedded modifier, whose slot the codec doesn't expose). Curve VALUES are intentionally NOT
 *  decoded here — read them live from the slot's raw block (GET /preset/blocks/<slotEid>/raw, slotEid
 *  = modModel.effectId + slot - 1). The FM3-specific slot indexing is inferred from the body table
 *  order (see the gen-3 driver's decodeModifiers) and is hardware-unverified. */
export interface PresetModifier {
  /** Decoded source display name (e.g. "LFO 1A", "External 1", "ADSR 1"). */
  source: string;
  /** Decoded target block display name (e.g. "Filter 1"). */
  target: string;
  /** Resolved target block effectId (from the preset grid), or null when the target isn't placed. */
  targetEffectId: number | null;
  /** Target parameter id on that block. */
  param: number;
  /** Where the modifier record was found in the body. */
  origin: 'pre-chain' | 'chain';
  /** 1-based modifier slot (pre-chain entries only), else null. */
  slot: number | null;
}

/** Library-friendly decoded preset: name, scenes, and the unique effect blocks it contains. */
export type PresetSummary = {
  number: number;
  name: string;
  model: string;
  crcValid: boolean;
  /** Content fingerprint (stored CRC16) — changes when the preset changes; used to detect stale cache. */
  crc: number;
  scenes: string[];
  blocks: { effectId: number; slug: string | null; name: string; instance: number | null }[];
  /** Distinct model names in use per block family (amp/drive/cab/reverb/…) — for "presets using model X".
   *  Keyed by family slug; only families with a decoded model are present. FM3 only. */
  models: Record<string, string[]>;
  /** Amp model names in use (distinct across the amp's 4 channels) — for "presets using amp X". FM3 only.
   *  Back-compat alias of `models.amp` (the library still binds to this). */
  amps: string[];
  /** Full per-block decoded params (every family, every param) — for deep search ("amp gain > 7").
   *  Populated for offline file decode + the on-demand /params endpoint; omitted from the bulk device
   *  scan to keep summaries light (use `models` for type search there, fetch /params for deep queries). */
  params?: DecodedBlock[];
  /** Decoded modifier assignments (source → target block+param) from the preset body. Gen-3 only;
   *  present when the decoder found any. Curve values are read live from the slot's raw block. */
  modifiers?: PresetModifier[];
};

export interface GridCellDTO {
  row: number; col: number; effectId: number; name: string; isShunt: boolean; routeFlag: number; fromRows: number[];
  /** ADDITIVE (Phase 6): catalog slug where derivable. AM4 cells carry it (its block dictionary is
   *  already slug-shaped) so Axis can key params/help without a pack lookup; gen-3 cells omit it
   *  (their sweep contract is byte-identical). */
  slug?: string;
}
export interface PresetGridDTO { model: string; name: string; crcValid: boolean; rows: number; cols: number; scenes: string[]; cells: GridCellDTO[]; source: 'dump'; }
export interface PresetBlockDTO { slug: string; name: string; effectId: number; row: number; col: number; fromRows: number[]; bypassed: boolean | null; channel: string | null; }
/** A served param. `value`/`norm` are `null` when the value could NOT be resolved from the device —
 *  a genuinely-unknown reading, NEVER a fabricated 0 (which is indistinguishable from a real zero).
 *  `unresolved` carries the reason and is present exactly when the value is null. (Same vocabulary as
 *  FcReadState.fields, which already uses `number | null` for an unread field.) */
export interface NamedParam { id: number; name: string; value: number | null; norm: number | null; unit?: string; min?: number; max?: number; log?: boolean; unresolved?: string; }
export interface EnumParam { id: number; name: string; value: number | null; options: { value: number; label: string }[]; unresolved?: string; }
export interface MeterVal { norm: number; value: number; unit?: string; min?: number; max?: number; log?: boolean; }
/** One side (tap/hold) of an FC switch as read by the sub-0x01 structured read. `present` = the
 *  device returned a record whose config/side echo matched the request; `raw` = the 78-byte response
 *  body (the per-switch record is at raw[16..]; field offsets within it are not yet decoded — see
 *  the gen-3 driver's fcReadSwitch). */
export interface FcSideState { selector: number; present: boolean; empty: boolean; raw: number[]; }
export interface FcSwitchState {
  effectId: number;
  layout: number; view: number; switch: number; config: number;
  tap: FcSideState; hold: FcSideState;
}
/** Decoded current switch state read back from the unit (via the sub-0x1b value channel). Field values
 *  are raw ordinals (category/function/display/color) keyed by FC field name; labels are decoded text.
 *  `null` = the field could not be read. This is the read that actually tracks param edits. */
export interface FcReadState {
  effectId: number;
  layout: number; view: number; switch: number; config: number;
  fields: Record<string, number | null>;
  tapLabel: string; holdLabel: string;
}

// Live pushes streamed to Axis over SSE.
export type DeviceEvent =
  | { type: 'tuner'; freq: number; note?: string; cents?: number; octave?: number }
  | { type: 'tempo'; bpm: number }
  | { type: 'scene'; index: number }
  | { type: 'cpu'; percent: number }
  // Live cross-UI sync (Axis Cloud Remote + multi-window): a mutation happened, so other UIs update.
  // `param` carries the new normalized value (cheap knob update); `changed` = structural (grid/preset)
  // change → reload. Emitted by the mutating driver methods; streamed via SSE + the remote relay channel.
  | { type: 'param'; effectId: number; paramId: number; norm: number }
  | { type: 'blockState'; effectId?: number }
  | { type: 'changed'; scope: 'grid' | 'preset' }
  /** Live output level meters in dB (−40…0, floor-clamped), from the Preset Leveling poll (fn 0x19).
   *  Output 1 & 2, each L/R. Decoded from a 5-septet float (RMS) → 10·log10 → dB; smoothed. */
  | { type: 'meters'; out1L: number; out1R: number; out2L: number; out2R: number }
  /** Device-cache self-describe BUILD progress (the runtime on-connect cache build; capability
   *  selfDescribe). `phase` walks the job: 'walking' (per-block sweep) → 'building' (deriving tables)
   *  → 'done' (persisted) | 'cancelled' | 'error'; 'already-built' is emitted when a build was asked
   *  for but a cache already existed. `done`/`total` are the block-sweep counters; `key`/`model`/
   *  `firmware` identify the cache; `error` carries the failure message on 'error'. */
  | { type: 'cacheBuild'; phase: 'walking' | 'building' | 'done' | 'error' | 'cancelled' | 'already-built'; done: number; total: number; key?: string; model?: number; firmware?: string; error?: string }
  /** A shared Axis config doc (layouts / swipe-quick-actions / tags / surface …) was written by one UI —
   *  streamed to the others so layouts/quick-actions/arrange stay in sync live, both directions. `origin` is
   *  the writer's client id so it can ignore its own echo (and not reload while it's mid-edit). */
  | { type: 'config'; id: string; data: unknown; origin?: string }
  /** The active telemetry cadence mode changed (PUT /telemetry/config, or the setter) — streamed so
   *  every UI reflects the new mode without re-polling the config endpoint. */
  | { type: 'telemetryConfig'; mode: TelemetryMode }
  /** Rolling device-link traffic counters, emitted ~1×/s while ≥1 SSE client is listening (only when a
   *  counter moved since the last emit). All four counters are CUMULATIVE since `since` (epoch ms, the
   *  connection's instrumentation start); `loops` is the currently-active supervisor set. */
  | { type: 'traffic'; txMsgs: number; txBytes: number; rxMsgs: number; rxBytes: number; since: number; loops: string[] };

// ── AM4 (moved verbatim from am4Device.ts) ──
export interface Am4Slot {
  slot: number; // 1..4 signal-chain position
  blockType: string; // canonical block name, 'none' if empty
  pidLow: number; // the block's pidLow (its type value)
}

/** What a device driver can actually do — the single truth the routes gate on (a missing optional
 *  DeviceDriver method always corresponds to a false/absent capability here). No cross-device
 *  `if (isAm4)`-style checks anywhere else. */
export interface DriverCapabilities {
  /** Routing model: gen-3 grid vs the AM4's flat linear chain. */
  slotModel: 'grid' | 'linear';
  /** Grid dimensions (slotModel 'grid' only). */
  grid?: { rows: number; cols: number };
  /** Linear-chain slot count (slotModel 'linear' only). */
  slotCount?: number;
  /** Grid editing (place/clear blocks, cables, cursor select). */
  gridEdit: boolean;
  /** Number of scenes. */
  scenes: number;
  /** Per-block channels (A–D). */
  channels: boolean;
  /** Gen-3 preset dump read (summaries, params, grid-from-dump, backups). */
  presetDump: boolean;
  /** The connected device's CURRENT preset can be dumped + lifted into the cross-device converter IR
   *  (POST /preset/convert with no `source`). True for gen-3 (full lift) / VP4 (skeleton, via its
   *  structure blob) / AM4 (partial). False where no liftable current-preset decode is reachable
   *  (gen-2's preset binary is opaque through the codec's public exports; gen-1 has no lift adapter). */
  presetConvert: boolean;
  /** Full per-block param decode from the preset body (FM3 only today). */
  blockParamDecode: boolean;
  /** Gen-3 live telemetry polls the supervisor may run against this device. */
  telemetry: { tuner: boolean; outputMeters: boolean; cpu: boolean };
  /** Foot Controller address model available. */
  fcModel: boolean;
  /** Live FC per-switch state read (FM3 only today). */
  fcLiveRead: boolean;
  /** Modifier binding (targetEffectId/targetParam/source writes). */
  modBind: boolean;
  /** Bundled cab IR names per bank. */
  cabIrs: boolean;
  /** Editor-authentic block-editor UI layouts (v2 pages → rows → controls) served on the block-params
   *  `layout` field. True on the four devices that ship *_LAYOUTS (FM3 / FM9 / Axe-Fx III / AM4). */
  editorLayouts: boolean;
  /** The server exposes GET/PUT /telemetry/config (cadence-mode control). Registry-level, not per-driver
   *  — advertised on every device so Axis can show the telemetry-mode control unconditionally. */
  telemetryControl?: boolean;
  /** Store-to-slot save supported. */
  supportsSave: boolean;
  /** The device can be walked by the codec's live self-describe (fn 0x01 DEFINITION/ENUM-LABEL
   *  queries) to build a device-true param/roster/enum cache on connect (capability gate for
   *  POST /device/cache/build). Gen-3 grid units only; false everywhere the walk is unverified. */
  selfDescribe: boolean;
  /** An official-editor `effectDefinitions_*.cache` file can be IMPORTED as this device's cache
   *  (capability gate for POST /device/cache/import). The byte source feeds the same buildCache path
   *  the live walk does, so this tracks selfDescribe (gen-3 grid units); false elsewhere. */
  cacheImport: boolean;
  /** The device can run the codec's FULL-mode self-describe walk (`mode:'full'`): the read-only sweep
   *  PLUS a per-float taper sweep that WRITES a normalized value, reads the display back, then restores
   *  the original (capability gate for POST /device/cache/build with `mode:'full'`). True ONLY for the
   *  CaptureRig-proven gen-3 trio (Axe-Fx III 0x10 / FM3 0x11 / FM9 0x12); false everywhere the write
   *  sweep is unverified — notably VP4 (the factory-reset incident: its writes stay allowlist-gated). */
  fullCapture: boolean;
  /** The device does NOT push front-panel / editor edits, so the registry supervisor should poll the
   *  driver's `readDeviceEditState()` to catch out-of-band edits (AM4 only — HW-107). Absent = no poll. */
  deviceEditWatch?: boolean;
  /** The device PUSHES front-panel / editor edits as an unsolicited 0x74/0x75/0x76 state-broadcast
   *  burst, so the registry installs a persistent RX listener that reflects them as `param` events
   *  via the driver's `decodeEditBurst()` (gen-3 — the push mirror of deviceEditWatch). Absent = no listener. */
  deviceEditPush?: boolean;
}

/** What the registry hands each driver: the ONE shared transport (a single exclusive MIDI/serial
 *  connection — drivers must never open their own) and the SSE event bus emit. */
export interface DriverCtx {
  transport(): Promise<Transport>;
  emit(e: DeviceEvent): void;
  /** The registry-resolved cadence for the CURRENT telemetry mode + this device's family. Drivers that
   *  run their own edit-watch cadence (the AM4 redesign uses `editRehashMs`) read it here instead of
   *  hardcoding intervals, so a mode switch reaches them without a re-wire. */
  getCadence(): CadenceProfile;
}

/**
 * Per-device driver surface. Method signatures are IDENTICAL to the pre-driver Device methods so the
 * route handlers keep working unchanged. Optional methods are capability-gated: a driver that lacks
 * one (e.g. the AM4 has no grid edit / gen-3 telemetry / FC) simply doesn't implement it, and the
 * route answers `501 {error:'unsupported', capability}`.
 */
/** Which slots `queryCabSlots` should read, and how far it may go. */
export interface CabSlotQueryOptions {
  /** Bank page: `0x10`–`0x13` user banks, `0x20` scratchpad. Defaults to `0x10`. */
  page?: number;
  /** First slot INDEX (0-based within the page). Defaults to 0. */
  from?: number;
  /** Last slot INDEX, inclusive. Defaults to `from`. */
  to?: number;
}

/** One slot's state, as read back from the unit. */
export interface CabSlotStateResult {
  index: number;
  page: number;
  /** `true` populated · `false` empty · `null` the unit's reply did not parse (NEVER read as empty). */
  populated: boolean | null;
  /** The raw flag byte, so an unparsed/unknown reading is still inspectable. */
  flag: number | null;
  /** The first 15 bytes of the packed name field (kept for comparison; `name` is the readable form). */
  nameRegion: number[];
  /** The slot's NAME, decoded from the unit's own reply — measured 2026-10-08. An empty slot reports the
   *  device's literal "<EMPTY>", so a name is only meaningful when `populated` is true. */
  name?: string;
  /** Why `populated` is null, when it is. */
  note?: string;
}

/** What a slot CLEAR established. */
export interface CabSlotClearResult {
  /** True only when the unit accepted the blank container AND the slot now reads EMPTY. */
  ok: boolean;
  index: number;
  page: number;
  /** The flag the slot reported BEFORE the clear: true/false/null (null = unreadable, never "empty"). */
  wasPopulated: boolean | null;
  /** The flag after: the clear is confirmed only on `false`. */
  nowPopulated: boolean | null;
  /** The close frame's reply code for the blank container: `0x00` accepted, `0x13` discarded. */
  closeCode: number | null;
  /** One line naming what was established, for logs and UI. */
  reason: string;
}

/** Options for `uploadCabIr`. `dest` is REQUIRED: the export sentinel is measured-refused. */
export interface CabIrUploadOptions {
  /**
   * Where the IR goes. MEASURED to be a `[index, page]` pair in the 0x7A start frame:
   * page `0x10`–`0x13` are the 512 user banks (128 slots each); page `0x20` is the 16 scratchpad
   * memories. Use `cabIrUserSlot(n)` / `cabIrScratchpad(n)` from the codec.
   *
   * ⚠ The unit REFUSED page `0x20` (scratchpad) in every probe, so this driver refuses it too rather
   * than sending frames the device discards. A user slot is a REAL write to that member of the user
   * cab bank — overwriting whatever is there.
   */
  dest?: { page: number; index: number };
  /** Rewrite the 32 name slots before sending (flag bits preserved). Gated — see `allowUnverified`. */
  name?: string;
  /**
   * Send the container with its close frame UNRECOMPUTED, i.e. deliberately self-inconsistent.
   *
   * The unit validates the close value against the content and DISCARDS a mismatch (close-ack `0x13`,
   * destination untouched — measured). By default this driver recomputes it, which is a no-op for a real
   * container and the fix for a rename. Set this false only to MEASURE the discard.
   */
  recomputeClose?: boolean;
  /**
   * Opt IN to sending a container this driver knows the unit will DISCARD (i.e. one left
   * self-inconsistent with `recomputeClose: false`). It is no longer needed for a rename — that is a
   * measured-working path since the close value is recomputed.
   */
  allowUnverified?: boolean;
}

/**
 * What an IR upload established.
 *
 * `ok` requires BOTH halves of the measured acceptance rule:
 *   1. every frame was acknowledged (start, all data frames, close), and
 *   2. the close frame's answer was **code `0x00`** — the unit's signal that the container's close
 *      value MATCHES its content.
 * A close answer of **`0x13` means the unit DISCARDED the upload** and left the destination untouched,
 * even though every frame was acknowledged. That is measured, in four controlled arms (2026-10-08):
 * verbatim → `0x00` → the slot became populated; name changed → `0x13`; samples changed → `0x13`; close
 * value mutated with the content unchanged → `0x13` — and in all three `0x13` arms an EMPTY destination
 * slot STAYED EMPTY. Reporting `ok` from the acks alone (as an earlier revision did) told the caller
 * "acknowledged" for an upload the device threw away.
 *
 * `ok` still does NOT mean the IR is correct or sounds right: nothing on this firmware reads a slot's
 * name back, and the close frame's encoding is undecoded (it must be RECOMPUTED for any content change,
 * which is why a rename cannot work yet). Say "accepted", not "installed".
 */
export interface CabIrUploadResult {
  ok: boolean;
  /**
   * True when the unit answered the close frame with `0x13` — the container's close value does not match
   * its content, so the upload was DISCARDED and the destination slot was not written.
   */
  discarded: boolean;
  /** The close frame's reply code, or null when the unit never answered it. `0x00` = accepted. */
  closeCode: number | null;
  /** One line naming what the acks and the close code establish, for logs and UI. */
  reason: string;
  /** The name as sent. */
  name: string;
  modelId: number;
  frames: number;
  bytes: number;
  sampleSlots: number;
  renamed: boolean;
  /** The destination actually written into the 0x7A start frame. */
  dest: { page: number; index: number };
  /** Frame-by-frame acks, and whether every expected frame was acknowledged. */
  acks: {
    start: boolean;
    data: number;
    expectedData: number;
    end: boolean;
    complete: boolean;
    /** Raw `[echoed fn, code]` pairs seen. Do NOT read these through the MIDI_ERROR_* label table. */
    codes: { fn: number; code: number }[];
  };
}

/** The fields `setPerformSlot` patches, in the byte domain. Any subset — an omitted field keeps the
 *  slot's current value. `effectLabel`/`paramLabel` are written into the fixed 32-byte windows, so a
 *  longer string is TRUNCATED (never resized, never completed by guesswork). */
export interface PerformSlotPatch {
  effectId?: number;
  paramId?: number;
  effectLabel?: string;
  paramLabel?: string;
}

/** The outcome of a perform-slot write, as MEASURED by a read-back of the edit buffer — never an
 *  assumed `ok`. `readback` is the slot as the unit now reports it (null when no page came back). */
export interface PerformSlotWriteResult {
  ok: boolean;
  slot: number;
  /** Why it failed, when it did: 'no-page' | 'slot-out-of-range' | 'retarget-failed' | 'readback-mismatch'. */
  reason?: string;
  requested: PerformSlotPatch;
  readback: PerformSlot | null;
}

/** The fields `setPerPresetSwitch` patches, in the byte domain. */
export interface PerPresetSwitchPatch {
  /** The 16-bit TAP action code — the CATEGORY's index in FM3-Edit's own list (0x04 = Effect, 0x03 = Scene …). */
  actionCode?: number;
  /**
   * The target byte. What it MEANS depends on the category and the function: an FX-slot index for an Effect row
   * whose function is Bypass or Chan Select (measured on four blocks), but a scene number, a preset number, a
   * layout number, a control-switch number (or nothing) elsewhere. An index whose target byte was never located
   * refuses this field — writing it would be writing to an unobserved position.
   */
  targetIndex?: number;
  /**
   * The 16-bit HOLD action code — the SAME code space as `actionCode`, stored in a second 24-wide u16 array at
   * `marker+436 + 2·(index−1)`. NEW 2026-10-11: measured by setting three HOLDs (Looper, Utility, Control
   * Switch), which read back as 0x08/0x05/0x07 in row order with every other row zero. 0 = Unassigned.
   */
  holdActionCode?: number;
}

/** The outcome of a per-preset switch write, MEASURED by a read-back of the edit buffer. */
export interface PerPresetSwitchWriteResult {
  ok: boolean;
  index: number;
  /** 'no-block' | 'unsupported-index' | 'no-target-offset' | 'retarget-failed' | 'readback-mismatch'. */
  reason?: string;
  requested: PerPresetSwitchPatch;
  readback: PerPresetSwitch | null;
}

export interface DeviceDriver {
  /** SysEx model byte of the device this driver drives (0x10/0x11/0x12/0x15). */
  readonly modelId: number;
  /** Profile key: 'axe3' | 'fm3' | 'fm9' | 'am4'. */
  readonly key: string;
  /** Display name (e.g. 'FM3'). */
  readonly name: string;
  readonly capabilities: DriverCapabilities;

  /** Swap in a device-cache-derived RUNTIME profile (device-true rosters / enum labels / ranges over
   *  the static one). The model byte is unchanged, so the bound codec stays valid — only the data the
   *  driver reads through the profile changes. Implemented by gen-3 (capability selfDescribe); absent
   *  on drivers whose profile is fixed. */
  applyRuntimeProfile?(profile: DeviceProfile): void;

  /** Routing grid (the AM4 serves its 4 slots as a 1×4 grid DTO). */
  grid(): Promise<PresetGridDTO>;
  /** Routing grid of ONE STORED SLOT (`GET /presets/:n/grid`). Absent → the route answers 501, never a
   *  substituted live grid (the bug this exists to fix: `:n` was ignored and the browser previewed the
   *  loaded preset for every entry). */
  gridForSlot?(n: number): Promise<PresetGridDTO>;

  // ── preset reads ──
  presetRef?(): Promise<{ number: number; name: string }>;
  presetSummary?(presetNumber: number, withParams?: boolean): Promise<PresetSummary>;
  presetParams?(presetNumber: number): Promise<DecodedBlock[]>;
  /** Raw .syx bytes (the backup blob) + decoded summary for one slot — the backups service's source. */
  dumpRaw?(n: number): Promise<{ bytes: Uint8Array; summary: PresetSummary }>;
  decodePresetBytes?(bytes: Uint8Array): PresetSummary;
  /** Decoded modifier assignments for the CURRENT edit buffer (source → target block+param, plus the
   *  pre-chain slot when known) — the modifier editor's read-back source. Gen-3 only. */
  presetModifiers?(): Promise<{ modifiers: PresetModifier[] }>;
  /** Per-preset PERFORMANCE PAGE of the CURRENT edit buffer (§2.2) — the ten assigned controls with
   *  their effect/param ids and labels. READ-ONLY, one preset dump; `undefined` when the body has no
   *  page (never a guess). Gen-3 only. */
  performPage?(): Promise<PerformPage | undefined>;
  /** Write ONE slot of the CURRENT edit buffer's per-preset PERFORMANCE PAGE (§2.2) — the WRITE side.
   *  Patches the slot's ids AND its labels together (labels alone go stale) and sends the recompressed
   *  dump to the EDIT BUFFER (0x3FFF): transient, never a saved slot. Gen-3 only. */
  setPerformSlot?(slot: number, patch: PerformSlotPatch): Promise<PerformSlotWriteResult>;
  /** Per-preset SWITCH definitions of the CURRENT edit buffer (§3.8) — one row per switch with its action
   *  code and target index; `undefined` when the body has no block (never a synthesised one). Gen-3 only.
   *  NOTE: rows are reported per OBSERVED offset — PP#1 has both, PP#2 its action code only, and the rest
   *  nothing, which is what `confidence` and the null fields say. Gen-3 only. */
  perPresetSwitches?(): Promise<PerPresetSwitches | undefined>;
  /** Write ONE per-preset switch and report what the edit buffer reads back. Only indices with an OBSERVED
   *  offset in the codec's table can be written at all, and only those whose target byte has been located
   *  accept a target write. Same transient EDIT-BUFFER target as `setPerformSlot`. */
  setPerPresetSwitch?(index: number, patch: PerPresetSwitchPatch): Promise<PerPresetSwitchWriteResult>;
  presetBodyHex?(): Promise<{ len: number; hex: string }>;
  placedBlocks?(): Promise<PresetBlockDTO[]>;

  /** Lightweight per-block scene state (bypass + active channel) WITHOUT a preset dump — for reflecting
   *  a scene change snappily. Absent on drivers that can't read it cheaply (callers fall back to a full load). */
  sceneState?(): Promise<{ effectId: number; bypassed: boolean; channel: string | null }[]>;

  // ── catalog ──
  blocksCatalog?(): { slug: string; family: string; instance: number; name: string; page: number; paramCount: number; typeCount: number }[];
  blockTypes?(slug: string): TypeModel[];

  // ── live block params ──
  blockParams?(eid: number): Promise<{ block: string; slug: string; page: number; named: NamedParam[]; enums: EnumParam[]; type: { value: number; name: string } | null; layout?: DeviceLayout }>;
  readParams?(eid: number, pids: number[]): Promise<Record<number, number>>;
  /** Per-pid read returning NORMALIZED 0..1 values (the device's own wire fraction), keyed by pid.
   *  Unreadable pids are omitted, never fabricated. Distinct from the fn=0x1F bulk read, which is
   *  positional and returns raw 16-bit counts. */
  readRange?(eid: number, pids: number[]): Promise<Record<number, number>>;
  rawBlock?(eid: number): Promise<{ eid: number; values: Record<number, number> }>;
  cabIrs?(refresh?: boolean): Promise<Record<string, string[]>>;
  cabState?(eid: number): Promise<unknown>;
  /**
   * Per-slot cab STATE for the user banks and the scratchpad — the device's own `fn=0x01 sub=0x4B`
   * query, one request per slot, READ-ONLY.
   *
   * This is the read-back the IR upload was missing: fw 13 refuses the documented cab-NAME read
   * (`fn=0x12`), so an upload's own acks were the only evidence it landed. The state reply gives an
   * independent answer — a populated/empty flag plus a content-derived region that two slots holding
   * the same IR share byte for byte.
   *
   * It is NOT a name oracle: the region's encoding is undecoded and no simple scheme yields a name.
   * Consumers must render "populated", never "holds <name>". A slot whose reply does not parse is
   * reported as `state: null` — never as empty.
   */
  queryCabSlots?(opts: CabSlotQueryOptions): Promise<CabSlotStateResult[]>;
  /**
   * CLEAR a user cab slot: send the BLANK container (every chunk byte `0x7F` — Fractal's own loader
   * asset) and confirm the slot reads EMPTY afterwards. DESTRUCTIVE: the slot's IR is gone.
   *
   * MEASURED 2026-10-08: the unit ACCEPTS the blank container (close-ack `0x00`, because all 2048 words
   * are identical so their XOR is 0) and the slot then reads `empty`, indistinguishable from a
   * never-written slot — verified on an empty slot and on seven slots that held real IRs. This is how a
   * slot is cleared; there is no remove opcode. Contrast zeroed SAMPLES, which are stored and read
   * `populated` (a silent IR, not an empty slot).
   *
   * The result is fail-closed: `ok` requires BOTH the `0x00` close answer AND a post-read of `empty`.
   * A slot that still reads populated — or that cannot be read at all — is NOT reported as cleared.
   */
  clearCabSlot?(opts: CabSlotQueryOptions): Promise<CabSlotClearResult>;
  meters?(wants?: Record<string, number[]>): Promise<
    { effectId: number; slug: string; defaultId: number; defaultName: string; typeName: string; vals: Record<number, MeterVal> }[]
  >;
  liveMonitors?(onlyEid?: number): Promise<{ effectId: number; family: string; paramName: string; role: string; norm: number; db: number | null; minDb?: number; maxDb?: number }[]>;
  /** Looper page telemetry (GET /preset/looper): live waveform envelope (0..1 magnitudes) + playhead
   *  position (0..1) + level (0..1). Empty when the block isn't a looper. gen-3 (capability liveMonitors). */
  looperTelemetry?(eid: number): Promise<{ wave: number[]; position: number | null; level: number | null }>;
  /** Toggle a looper transport control (POST /preset/looper/control). `action` ∈ record|play|stop|
   *  overdub|undo|once|reverse|half; `on` = 1.0/0.0. gen-3. */
  looperControl?(eid: number, action: string, on: boolean): Promise<{ ok: boolean }>;

  // ── FC / modifier ──
  fcReadSwitch?(layout: number, view: number, sw: number): Promise<FcSwitchState>;
  fcReadState?(layout: number, view: number, sw: number): Promise<FcReadState>;
  bindModifier?(slot: number, targetEffectId: number, targetParam: number, source: number): Promise<{ ok: boolean; error?: string; slotEid?: number; slot?: number; targetEffectId?: number; targetParam?: number; source?: number }>;

  // ── writes ──
  setParam?(eid: number, paramId: number, value: number, continuous: boolean): Promise<{ ok: boolean }>;
  setType?(eid: number, value: number): Promise<{ ok: boolean }>;
  setBypass?(eid: number, bypassed: boolean): Promise<{ ok: boolean }>;
  setChannel?(eid: number, channel: string): Promise<{ ok: boolean }>;
  placeCell?(row: number, col: number, blockId: number): Promise<{ ok: boolean }>;
  selectCell?(row: number, col: number): Promise<{ ok: boolean }>;
  cable?(srcRow: number, srcCol: number, destRow: number, connect: boolean): Promise<{ ok: boolean }>;
  /** Switch the active preset. `code` is ADDITIVE (AM4 bank-letter location code, e.g. "C02"). */
  selectPreset?(n: number): Promise<{ ok: boolean; code?: string }>;
  /** Re-select the CURRENT preset to reload it from flash — the non-destructive safety net the codec's
   *  FULL-mode self-describe walk runs after every block whose params it swept, discarding any lingering
   *  sweep write. Reuses the driver's current-preset ref + preset-select machinery; no new wire bytes.
   *  Implemented by gen-3 (capability fullCapture); absent elsewhere. */
  reloadPreset?(): Promise<void>;
  /** Store the edit buffer to slot n. `location`/`code` are ADDITIVE (AM4). */
  store?(n: number): Promise<{ ok: boolean; location?: number; code?: string }>;
  loadPresetBytes?(syx: Uint8Array): Promise<{ ok: boolean }>;
  /** Upload a user-cab IR `.syx` container to the device (§2.5). Gen-3 only (the container geometry is
   *  measured on an FM3-Edit export). The frames go out as they came in unless a rename/retarget is
   *  asked for; see `CabIrUploadResult` for what the caller may and may not conclude. */
  uploadCabIr?(syx: Uint8Array, opts?: CabIrUploadOptions): Promise<CabIrUploadResult>;
  setSceneName?(index: number, name: string): Promise<{ ok: boolean }>;
  setPresetName?(name: string): Promise<{ ok: boolean }>;

  // ── tempo / scene ──
  getTempo?(): Promise<{ bpm: number }>;
  setTempo?(bpm: number): Promise<{ ok: boolean }>;
  tapTempo?(): Promise<{ ok: boolean }>;
  getScene?(): Promise<{ index: number }>;
  setScene?(index: number): Promise<{ ok: boolean }>;
  /** Live active-channel per placed block (effectId → channel 0-3). Drives the registry's
   *  front-panel channel-change watch so a device-side A–D switch re-reads the per-channel
   *  block type. Gen-3 only (blocks with A–D channels); undefined on devices without channels. */
  getActiveChannels?(): Promise<Map<number, number>>;
  /** One live tuner reading (already resolved to display fields). Devices whose tuner is NOT a
   *  gen-3 tuner-page poll (AM4 polls block 0x0023) implement this; the registry supervisor calls
   *  it on the tuner cadence and emits the `tuner` event. Gen-3 uses the built-in poll instead. */
  readTuner?(): Promise<{ freq: number; note: string; octave: number; cents: number } | null>;

  // ── Phase 6 unified surface (capability-gated; today AM4-only unless noted) ──
  /** Stored preset name lookup (GET /presets/:n). Devices without it get the {number, name:''} stub. */
  storedPresetName?(n: number): Promise<{ number: number; name: string; code?: string }>;
  /** Scan every stored location by name (GET /preset/locations) — capability presets.canScanNames. */
  scanPresets?(): Promise<{ count: number; presets: { location: number; code: string; name: string; isEmpty: boolean }[] }>;
  /** Verbatim .syx dump of one preset (POST /preset/backup) — capability backupDump. `sceneNames`
   *  and `crcValid` are ADDITIVE, opt-in container-decode fields (AM4) alongside the opaque `bytes`;
   *  absent when the device/decoder doesn't surface them. */
  backupPreset?(location?: number): Promise<{ location: number | null; code: string | null; name: string; bytes: number[]; sceneNames?: string[]; crcValid?: boolean }>;
  /** Verbatim re-emit of a preset dump (POST /preset/restore) — capability restoreDump. */
  restorePreset?(bytes: number[]): Promise<{ ok: boolean; location: number | null; code: string | null }>;
  /** Offline firmware .syx integrity check (POST /firmware/validate) — capability firmwareValidate. */
  validateFirmware?(bytes: number[]): { valid: boolean; messages?: number; blocks?: number; headerTag?: number[]; finalizeTag?: number[]; error?: string };
  /** Device/global param write by catalog key (PUT /device/param) — capability deviceParams. */
  setParamByKey?(key: string, value: number): Promise<{ ok: boolean }>;
  /** Modifier address model (GET /mod/model). Superset DTO: always carries `bindingSupported`. */
  modifierModel?(): Record<string, unknown> | null;

  // ── device-edit watch (capability deviceEditWatch; AM4-only today) ──
  /** One poll tick of out-of-band edit detection for devices that don't push edits (AM4 front-panel /
   *  AM4-Edit — HW-107). Returns `{changed:true}` when a DEVICE-originated edit happened since the last
   *  tick; suppresses the app's own writes. The registry supervisor calls this while an SSE client is
   *  listening and emits `changed{scope:'preset'}` on a true. */
  readDeviceEditState?(): Promise<{ changed: boolean }>;
  /** Decode a reassembled unsolicited state-broadcast burst (front-panel / editor edit the device
   *  PUSHED — gen-3) into per-param `param` events, diffed against the last-known snapshot so a
   *  whole-block burst yields only the moved param(s). `reload:true` means the burst couldn't be diffed
   *  (first sight of the block) → the registry emits a `changed` reload instead so the edit isn't lost.
   *  Capability `deviceEditPush`. */
  decodeEditBurst?(frames: number[][]): { events: { effectId: number; paramId: number; norm: number }[]; reload: boolean };
}
