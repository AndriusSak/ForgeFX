// Per-device profile: everything that differs between gen-3 units (model byte, grid size, param
// catalog, ranges, rosters, enum labels). The gen-3 effect codec itself is shared — only the data
// changes — so the device client picks a profile by the detected model and is otherwise generic.
import type { BuiltCache } from 'forgefx-midi/cache';
import {
  FM3_RANGES,
  FM3_PARAMS_BY_FAMILY,
  FM3_ROSTERS,
  FM3_ENUM_OVERRIDES,
  FM3_TYPE_TABLES_FW13,
  FM3_ENUM_ROWS_FW13,
  FM3_CAB_IRS,
  FM3_FAMILY_BY_EFFECT_ID,
  FM3_LAYOUTS,
  type Fm3TypeModel,
  FM3_FC_EFFECT_ID,
  FM3_FC_SWITCHES,
  FM3_FC_VIEWS,
  FM3_FC_LAYOUTS as FM3_FC_LAYOUT_COUNT,
  FM3_FC_CONFIGS_PER_LAYOUT,
  FM3_FC_LABEL_LEN,
  FM3_FC_PARAMS_WIDTH,
  FM3_FC_FIELDS,
  FM3_FC_CATEGORIES,
  FM3_FC_COLORS,
  FM3_FC_LABEL_MODES,
  FM3_FC_FUNCTIONS,
  FM3_FC_CHANNELS,
  FM3_MOD_EFFECT_ID,
  FM3_MOD_SLOT_COUNT,
  FM3_MOD_SOURCES,
  FM3_MOD_FIELDS,
  FM3_MONITOR_PARAMS,
  FM3_RANGE_SECTIONS,
  applyFm3RangeOverlay,
  FM3_RANGE_OVERLAY,
  type Fm3RangeOverlayEntry,
  type Fm3RangeTable,
} from 'forgefx-midi/gen3/fm3';
import {
  FM9_RANGES, FM9_PARAMS_BY_FAMILY, FM9_ENUM_OVERRIDES, FM9_FAMILY_BY_EFFECT_ID, FM9_LAYOUTS,
  FM9_MONITOR_PARAMS,
  FM9_FC_EFFECT_ID, FM9_FC_CONFIGS, FM9_FC_PARAMS_WIDTH, FM9_FC_FIELDS, FM9_FC_CATEGORIES, FM9_FC_LABEL_MODES,
  FM9_FC_LAYOUTS, FM9_FC_CONFIGS_PER_LAYOUT, FM9_FC_SWITCH_SLOTS_PER_LAYOUT,
  FM9_MOD_EFFECT_ID, FM9_MOD_SLOT_COUNT, FM9_MOD_FIELDS,
  FM9_CAB_IRS,
  FM9_RANGE_SECTIONS,
} from 'forgefx-midi/gen3/fm9';
import {
  PARAMS_BY_FAMILY as AXE3_PARAMS, resolveEnumValues as axe3Enum, GEN3_READ_ROSTERS, AXE3_LAYOUTS,
  AXE3_ENUM_OVERRIDES, AXE3_RANGES as AXE3_DEVICE_RANGES, AXE3_CAB_IRS,
  AXE3_MONITOR_PARAMS,
  AXE3_FC_EFFECT_ID, AXE3_FC_CONFIGS, AXE3_FC_PARAMS_WIDTH, AXE3_FC_FIELDS,
  AXE3_MOD_EFFECT_ID, AXE3_MOD_SLOT_COUNT, AXE3_MOD_FIELDS, AXE3_MOD_SOURCES_STATUS,
  AXE3_RANGE_SECTIONS,
} from 'forgefx-midi/gen3/axe-fx-iii';
import type {
  DeviceEditorLayouts, EditorBlockLayout, EditorLayoutVariant, EditorLayoutPage,
  EditorLayoutRow, EditorFwRange,
} from 'forgefx-midi/gen3/fm3';
import { AM4_LAYOUTS } from 'forgefx-midi/am4';

// Editor-authentic UI layout (v2 schema — see forgefx-midi src/editorLayouts.ts). The wire `layout`
// on /preset/blocks/:eid/params carries ONE resolved block-type/firmware variant of a block's editor
// layout: the block's editorName + family, plus which variant was chosen, plus ALL of that variant's
// pages (tabs → rows → controls) passed through VERBATIM from the codec's *_LAYOUTS (widget / rawWidget /
// placement / crossBlock / per-control fw preserved). No unioning across variants; the client renders
// exactly the pages the editor would show for the current block type.
export type DeviceLayout = {
  editorName: string;
  family: string;
  /** Chosen variant display name (e.g. 'Analog', '10 Band', 'Amp GTE 28.09'). */
  variantName: string;
  /** Chosen variant's block-type selector value(s), comma-joined as in the editor XML, or null for an
   *  unconditional / firmware-only-versioned variant (e.g. the Amp block). */
  variantValue: string | null;
  /** Firmware gate of the chosen variant, when present. */
  fw?: EditorLayoutVariant['fw'];
  /** True when the chosen variant is the firmware-current pinned one (amp DISTORT block). */
  pinned?: boolean;
  /** All pages of the chosen variant ONLY (editor display order); rows → controls verbatim from the codec. */
  pages: EditorLayoutPage[];
};
// gen-3 shared virtual-effect effectIds (capture-confirmed on FM3; III reuses them since its package
// ships layouts but no effectId table). Audio-block eids resolve via the codec (slugForEffectId).
const VIRTUAL_EID_FAMILY: Record<number, string> = { 1: 'GLOBAL', 2: 'CONTROLLERS', 3: 'MOD', 190: 'MIDIBLOCK', 199: 'FC' };
const eidFamily = (map?: Record<number, string>) => (eid: number): string | undefined => map?.[eid] ?? VIRTUAL_EID_FAMILY[eid];

// Parse a variant/page selector `value` ("10,11,12") into the numeric block-type values it activates.
const parseSelectorValues = (value: string | null | undefined): number[] =>
  value == null ? [] : value.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));

// Pick the block-type / firmware variant that matches the block's CURRENT type value:
//   1. variants whose selector `value` list contains typeValue win (the normal per-type case);
//   2. else the unconditional (value === null) variants — the firmware-only-versioned Amp block, whose
//      variants all carry value:null but differ by `fw`;
//   3. else every variant (degenerate: nothing declared).
// Within the winning set, prefer the firmware-pinned variant (amp DISTORT ships every historical fw
// layout with exactly one pinned:true), else the first in editor order.
const selectVariant = (block: EditorBlockLayout, typeValue?: number): EditorLayoutVariant | undefined => {
  const variants = block.variants;
  if (!variants.length) return undefined;
  let cands = typeValue == null ? [] : variants.filter((v) => parseSelectorValues(v.value).includes(typeValue));
  if (!cands.length) cands = variants.filter((v) => v.value == null);
  if (!cands.length) cands = variants;
  return cands.find((v) => v.pinned) ?? cands[0];
};

// Lookup from an editor selector parameter symbol (e.g. 'DISTORT_EQTYPE', 'DISTORT_TYPE') to the block's
// CURRENT numeric value of that param, or undefined when unknown. The driver builds this from the block's
// live read: the family type selector answers with the type already decoded in blockParams, other
// selectors (EQ type / drive type / …) with the block's named/enum param values.
export type SelectorValues = (selectorParamName: string) => number | undefined;

// Parse an editor firmware bound ("maj,min", e.g. "6,03" / "12,00") into a comparable integer. Absent → 0.
const fwBound = (v?: string): number => {
  if (!v) return 0;
  const [maj = 0, min = 0] = v.split(',').map((s) => Number(s.trim()) || 0);
  return maj * 1000 + min;
};

// Among same-named siblings (pages, or controls) that differ only by firmware gate, keep the one(s) that
// apply to the NEWEST firmware — deterministic, no live firmware version needed:
//   • a `gtet` (>=) sibling supersedes everything → keep the single highest `gtet`;
//   • else null-gated (always-applicable) siblings supersede `lt`-only ones → keep the null-gated ones;
//   • else (only `lt`-only siblings) the newest firmware reaches the highest `lt` bound → keep that one.
// With no firmware gates in the set the siblings are genuinely distinct → all kept.
const preferNewestFw = <T extends { fw?: EditorFwRange }>(items: T[]): T[] => {
  if (items.length <= 1) return items;
  if (!items.some((i) => i.fw && (i.fw.gtet || i.fw.lt))) return items;
  const gtet = items.filter((i) => i.fw?.gtet);
  if (gtet.length) return [gtet.reduce((a, b) => (fwBound(b.fw!.gtet) > fwBound(a.fw!.gtet) ? b : a))];
  const nullGated = items.filter((i) => !i.fw?.gtet && !i.fw?.lt);
  if (nullGated.length) return nullGated;
  return [items.reduce((a, b) => (fwBound(b.fw!.lt) > fwBound(a.fw!.lt) ? b : a))];
};

// Selector filter for one group of same-named pages: a page with no selector value is always kept; a
// selector-gated page is kept iff the block's CURRENT selector value is in its value list. When the
// current value is unknown (selector not resolvable) we never include the whole set — prefer the page
// whose list contains the block's type value, else the first gated page in editor order.
const filterPagesBySelector = (
  group: EditorLayoutPage[],
  typeValue: number | undefined,
  selectors?: SelectorValues,
): EditorLayoutPage[] => {
  const gated = group.filter((p) => p.selectorParamName != null && p.value != null);
  if (!gated.length) return group; // nothing selector-gated → all pages always apply
  const ungated = group.filter((p) => p.selectorParamName == null || p.value == null);
  const cur = selectors?.(gated[0]!.selectorParamName!);
  if (cur != null) {
    // known current value → strict membership; a group that matches nothing contributes no page
    return [...ungated, ...gated.filter((p) => parseSelectorValues(p.value).includes(cur))];
  }
  const byType = typeValue != null ? gated.filter((p) => parseSelectorValues(p.value).includes(typeValue)) : [];
  return [...ungated, ...(byType.length ? byType : [gated[0]!])];
};

// Drop controls that the newest firmware would hide: a control gated with an `lt` (only firmware < X)
// bound never applies to the newest firmware (whether it also carries a `gtet` — a closed range — or not).
// Controls with a `gtet`-only gate or no gate always apply and pass through untouched.
const pruneControlsByFw = (page: EditorLayoutPage): EditorLayoutPage => {
  let touched = false;
  const rows: EditorLayoutRow[] = page.rows.map((row) => {
    const controls = row.controls.filter((c) => {
      const drop = c.fw?.lt != null;
      if (drop) touched = true;
      return !drop;
    });
    return controls.length === row.controls.length ? row : { ...row, controls };
  });
  return touched ? { ...page, rows } : page;
};

// Filter a variant's pages down to what the editor actually shows for the block's current state: pages
// group by display name (same-named pages are selector/firmware siblings), each group collapses to the
// selector-matching page(s), firmware siblings collapse to the newest-firmware one, and per-control
// firmware gates prune controls hidden on the newest firmware. Order preserved.
export const resolveLayoutPages = (
  pages: EditorLayoutPage[],
  typeValue?: number,
  selectors?: SelectorValues,
): EditorLayoutPage[] => {
  const order: string[] = [];
  const groups = new Map<string, EditorLayoutPage[]>();
  for (const p of pages) {
    if (!groups.has(p.name)) { groups.set(p.name, []); order.push(p.name); }
    groups.get(p.name)!.push(p);
  }
  const out: EditorLayoutPage[] = [];
  for (const name of order) {
    const kept = preferNewestFw(filterPagesBySelector(groups.get(name)!, typeValue, selectors));
    for (const p of kept) out.push(pruneControlsByFw(p));
  }
  return out;
};

// Resolve a family's editor layout to the wire DeviceLayout for the block's CURRENT type value, with the
// selected variant's pages filtered to the current selector/firmware state (see resolveLayoutPages).
const layoutFrom = (layouts: DeviceEditorLayouts) =>
  (family: string, typeValue?: number, selectors?: SelectorValues): DeviceLayout | undefined => {
    const block = layouts[family];
    if (!block) return undefined;
    const variant = selectVariant(block, typeValue);
    if (!variant) return undefined;
    return {
      editorName: block.editorName,
      family: block.family,
      variantName: variant.name,
      variantValue: variant.value,
      ...(variant.fw ? { fw: variant.fw } : {}),
      ...(variant.pinned ? { pinned: true } : {}),
      pages: resolveLayoutPages(variant.pages, typeValue, selectors),
    };
  };

// The device's OWN editor layouts are the authority on how a param is PRESENTED: a control drawn as
// 'knob' is continuous, one drawn as 'dropdown' is a discrete selector. Index those widget bindings
// so the serve filters can honour the device's own evidence even when the catalog disagrees — an
// 'unverified'-unit float the device draws as a knob (FM3 GLOBAL Brightness/Contrast 7115/7116), or a
// selector the cache mined as a float row (FM3 GLOBAL FC default-layout ids 3602-3604). Built once
// per profile, keyed by the param's OWN family — a cross-block control (`crossBlock.family`, e.g. the
// GLOBAL params the FC page renders) files under that serving family; otherwise the layout's family.
// Pseudo-params (id ≥ 0xff00) are excluded — they are never served as real params.
const layoutWidgetByFamily = (layouts: DeviceEditorLayouts, widget: string): ReadonlyMap<string, ReadonlySet<number>> => {
  const byFam = new Map<string, Set<number>>();
  for (const block of Object.values(layouts as unknown as Record<string, EditorBlockLayout>)) {
    for (const variant of block.variants ?? []) {
      for (const page of variant.pages ?? []) {
        for (const row of page.rows ?? []) {
          for (const c of row.controls ?? []) {
            if (c.widget !== widget || c.paramId == null || c.paramId >= 0xff00) continue;
            const fam = c.crossBlock?.family ?? block.family;
            if (!fam) continue;
            if (!byFam.has(fam)) byFam.set(fam, new Set());
            byFam.get(fam)!.add(c.paramId);
          }
        }
      }
    }
  }
  return byFam;
};

// A param the block actually SERVES on the wire: its id, the served display name the client keys on
// (`named`/`enums` `.name`, i.e. the family-prefix-stripped label), and the raw editor param symbol
// (the codec's `<FAMILY>_<SYM>`, written back into the layout when a pseudo control is rewritten).
export type ServedParamRef = { id: number; servedName: string; paramName: string };

/**
 * Rewrite layout controls that carry a `_BTN_` pseudo-param id into the REAL served param they drive,
 * so the SERVED layout carries live ids and no client has to bridge the gap by matching a name.
 *
 * WHY (parity audit §3.6 item 4): the cab page's per-cab M / S buttons are addressed with ids
 * (`CABINET_BTN_MUTE<n>` / `CABINET_BTN_SOLO<n>`, 65286…) the device never serves as parameters, while
 * the state they drive lives in the served `MUTE<n>` enum (options `-- / MUTE / SOLO`). Historically
 * every client re-resolved such a control by matching the served NAME after the `_BTN_` infix —
 * fragile: a device rename (or a differently-named family) silently DELETED the control, with no error.
 * Resolving it here means the served layout already binds the real param.
 *
 * Rules (mirror the old client resolution, now server-authoritative):
 *   • only controls whose paramName carries `_BTN_` are candidates;
 *   • a control whose CURRENT paramId is itself a served param is left alone (it is already live);
 *   • the `_BTN_` suffix must equal a served param's name — that param's id + raw symbol are written;
 *   • a sibling with no served param of its own (e.g. `..._BTN_SOLO<n>` — SOLO is an OPTION of the
 *     MUTE enum, not a param) is left as a pseudo id, so the M/S pair collapses onto the one state
 *     control the device really has (the board de-dupes by key / gaps the unresolvable one).
 * Returns the SAME layout object unchanged when nothing is rewritten (cheap no-op path).
 */
export function resolvePseudoParamControls(
  layout: DeviceLayout,
  served: readonly ServedParamRef[],
): DeviceLayout {
  const byServedName = new Map<string, ServedParamRef>();
  const servedIds = new Set<number>();
  for (const s of served) {
    servedIds.add(s.id);
    if (s.servedName) byServedName.set(s.servedName, s);
  }
  let any = false;
  const pages: EditorLayoutPage[] = layout.pages.map((page) => {
    let pageChanged = false;
    const rows: EditorLayoutRow[] = page.rows.map((row) => {
      let rowChanged = false;
      const controls = row.controls.map((c) => {
        const suffix = (c.paramName ?? '').split('_BTN_')[1];
        if (!suffix) return c; // not a pseudo-button control
        if (c.paramId != null && servedIds.has(c.paramId)) return c; // already bound to a live param
        const real = byServedName.get(suffix);
        if (!real) return c; // no served param of that name — leave the pseudo id for the client fallback
        if (c.paramId === real.id && c.paramName === real.paramName) return c;
        rowChanged = pageChanged = any = true;
        return { ...c, paramId: real.id, paramName: real.paramName };
      });
      return rowChanged ? { ...row, controls } : row;
    });
    return pageChanged ? { ...page, rows } : page;
  });
  return any ? { ...layout, pages } : layout;
}

// AM4 block-name → catalog family symbol (the AM4_LAYOUTS key). Most AM4 blocks match SLUG_FAMILY, but
// the AM4 catalog names its compressor `compressor` (not `comp`) and its volume/pan block `volpan`
// (not `volume`), so this map is explicit rather than piggy-backing the gen-3 SLUG_FAMILY table.
const AM4_FAMILY_BY_BLOCK: Record<string, string> = {
  amp: 'DISTORT', compressor: 'COMP', geq: 'GEQ', peq: 'PEQ', reverb: 'REVERB', delay: 'DELAY',
  chorus: 'CHORUS', flanger: 'FLANGER', rotary: 'ROTARY', phaser: 'PHASER', wah: 'WAH', volpan: 'VOLUME',
  tremolo: 'TREMOLO', filter: 'FILTER', drive: 'FUZZ', enhancer: 'ENHANCER', gate: 'GATE',
};
const am4LayoutOf = layoutFrom(AM4_LAYOUTS);
/** Editor-authentic layout for an AM4 block (by its lowercase block name, e.g. 'amp'/'drive'), for the
 *  block's current type value. Controls join to the AM4 catalog by cacheId in the codec; unresolved
 *  paramIds ride through as null (display-only). Undefined for a block with no AM4 layout. */
export const am4LayoutFor = (block: string, typeValue?: number, selectors?: SelectorValues): DeviceLayout | undefined => {
  const family = AM4_FAMILY_BY_BLOCK[block.toLowerCase()];
  return family ? am4LayoutOf(family, typeValue, selectors) : undefined;
};

// FC + Modifier address models (FM3-decoded; other devices not decoded yet). Lets the client compute
// (eid,pid) for any footswitch field / modifier field without hard-coding paramIds.
// One FC param-base field: gen-3 FC params are addressed as `base + config*stride (+ index)`.
// FM3 fields carry base/width/stride; FM9 the same; the III's carry base/width (stride = width).
export type FcFieldDef = { base?: number; width?: number; stride?: number; pid?: number; paramName?: string };
export type FcModel = {
  effectId: number;
  paramsWidth: number;
  /** Total addressable FC configs (FM3: layouts×configsPerLayout; FM9/III: 108). */
  configs: number;
  fields: Readonly<Record<string, FcFieldDef>>;
  categories?: Readonly<Record<number, string>>;
  labelModes?: Readonly<Record<number, string>>;
  /** True when the device supports the live per-switch state read (`fcReadState`). FM3 only —
   *  FM9/III expose the address model here but their (layout,view,switch) decomposition and
   *  label/LED-colour bases are not statically recovered, so live reads stay gated. */
  liveState: boolean;
  // ── FM3-only live-read geometry + display metadata (present when liveState) ──
  switches?: number;
  views?: number;
  layouts?: number;
  configsPerLayout?: number;
  labelLen?: number;
  colors?: Readonly<Record<number, { name: string; hex: string }>>;
  functions?: typeof FM3_FC_FUNCTIONS;
  channels?: readonly string[];
};
export type ModSource = { name: string; ordinal: number };
export type ModModel = {
  /** effectId of modifier slot 1; slot N (1-based) = effectId + (N-1). */
  effectId: number;
  slotCount: number;
  /** field → { pid }. Binding uses source(0)/targetEffectId(8)/targetParam(9). */
  fields: Readonly<Record<string, { pid: number }>>;
  /** Known modulation sources (name → MOD_CTRLID ordinal). Empty when the device's source
   *  enum is runtime-built and not yet captured (FM9/III) — binding still works. */
  sources: readonly ModSource[];
  /** Note on why `sources` may be empty (device-specific, capture-pending). */
  sourcesNote?: string;
};
const FM3_FC_MODEL: FcModel = {
  effectId: FM3_FC_EFFECT_ID,
  paramsWidth: FM3_FC_PARAMS_WIDTH,
  configs: FM3_FC_LAYOUT_COUNT * FM3_FC_CONFIGS_PER_LAYOUT,
  fields: FM3_FC_FIELDS,
  categories: FM3_FC_CATEGORIES,
  labelModes: FM3_FC_LABEL_MODES,
  liveState: true,
  switches: FM3_FC_SWITCHES,
  views: FM3_FC_VIEWS,
  layouts: FM3_FC_LAYOUT_COUNT,
  configsPerLayout: FM3_FC_CONFIGS_PER_LAYOUT,
  labelLen: FM3_FC_LABEL_LEN,
  colors: FM3_FC_COLORS,
  functions: FM3_FC_FUNCTIONS,
  channels: FM3_FC_CHANNELS,
};
const FM3_MOD_MODEL: ModModel = {
  effectId: FM3_MOD_EFFECT_ID,
  slotCount: FM3_MOD_SLOT_COUNT,
  fields: FM3_MOD_FIELDS,
  sources: FM3_MOD_SOURCES.map((s) => ({ name: s.name, ordinal: s.ordinal }))
};

// FM9 + Axe-Fx III FC address models (binary-confirmed bases; live per-switch read NOT supported —
// their config decomposition + label/colour bases are capture-only). Exposed via /fc/model so Axis
// can compute + read/write FC params through the generic (eid 199, pid) path.
const FM9_FC_MODEL: FcModel = {
  effectId: FM9_FC_EFFECT_ID,
  paramsWidth: FM9_FC_PARAMS_WIDTH,
  configs: FM9_FC_CONFIGS,
  fields: FM9_FC_FIELDS,
  categories: FM9_FC_CATEGORIES,
  labelModes: FM9_FC_LABEL_MODES,
  liveState: false,
  // Device-true geometry (binary-mined): 9 layouts (index 8 = Master) x 12 switch slots; config =
  // layout * configsPerLayout + switchSlot. NO `views` — that paging is an FM3-only UI concept.
  layouts: FM9_FC_LAYOUTS,
  configsPerLayout: FM9_FC_CONFIGS_PER_LAYOUT,
  switches: FM9_FC_SWITCH_SLOTS_PER_LAYOUT,
};
const AXE3_FC_MODEL: FcModel = {
  effectId: AXE3_FC_EFFECT_ID,
  paramsWidth: AXE3_FC_PARAMS_WIDTH,
  configs: AXE3_FC_CONFIGS,
  fields: AXE3_FC_FIELDS,
  liveState: false,
};
// FM9 + III modifier models: field map is binary-confirmed (source 0 / targetEffectId 8 /
// targetParam 9) so /mod/bind works; the source enum is runtime-built and not yet captured.
const FM9_MOD_MODEL: ModModel = {
  effectId: FM9_MOD_EFFECT_ID,
  slotCount: FM9_MOD_SLOT_COUNT,
  fields: FM9_MOD_FIELDS,
  sources: [],
  sourcesNote: 'FM9 modulation-source enum is runtime-built (device-specific) and not yet captured; do not reuse FM3 ordinals.'
};
const AXE3_MOD_MODEL: ModModel = {
  effectId: AXE3_MOD_EFFECT_ID,
  slotCount: AXE3_MOD_SLOT_COUNT,
  fields: AXE3_MOD_FIELDS,
  sources: [],
  sourcesNote: `Axe-Fx III modulation-source enum: ${AXE3_MOD_SOURCES_STATUS} — capture-pending; do not reuse FM3 ordinals.`
};

// Per-block monitor (meter) parameter tables — read-only pids + dB ranges, by parameterName.
// Surfaced via /preset/monitors so Axis can render meters from the standard per-block reads.
export type MonitorParams = Readonly<Record<string, { family: string; pid: number; role: string; minDb?: number; maxDb?: number; widgetConfirmed: boolean }>>;
const MONITOR_PARAMS_BY_MODEL: Record<number, MonitorParams> = {
  0x10: AXE3_MONITOR_PARAMS,
  0x11: FM3_MONITOR_PARAMS,
  0x12: FM9_MONITOR_PARAMS,
};

// The model-roster entry shape ForgeFX surfaces to the UI (value + name + lineage). FM3's
// fractal-midi rosters already carry this exact shape (Fm3TypeModel); FM9/III synthesize it.
export type TypeModel = { value: number; name: string; manufacturer: string | null; basedOn: string | null };

// pack slug → gen-3 catalog family (shared across FM3/FM9 — family names are the same)
export const SLUG_FAMILY: Record<string, string> = {
  amp: 'DISTORT', cab: 'CABINET', drive: 'FUZZ', comp: 'COMP', multicomp: 'MULTICOMP',
  peq: 'PEQ', geq: 'GEQ', reverb: 'REVERB', delay: 'DELAY', multitap: 'MULTITAP',
  chorus: 'CHORUS', flanger: 'FLANGER', phaser: 'PHASER', rotary: 'ROTARY', tremolo: 'TREMOLO',
  pitch: 'PITCH', wah: 'WAH', filter: 'FILTER', formant: 'FORMANT', enhancer: 'ENHANCER',
  mixer: 'MIXER', volume: 'VOLUME', input: 'INPUT', output: 'OUTPUT', gate: 'GATE',
  synth: 'SYNTH', ringmod: 'RINGMOD', looper: 'LOOPER', resonator: 'RESONATOR',
  megatap: 'MEGATAP', tentap: 'TENTAP', plex: 'PLEX', send: 'FDBKSEND', return: 'FDBKRET',
  multiplexer: 'MULTIPLEXER',
  // Display-name spellings: `/blocks/<slug>/types` is reachable by hand and by the convert flow, and
  // the block is called "Plex Delay" everywhere the user sees it.
  plexdelay: 'PLEX', 'plex delay': 'PLEX', multitapdelay: 'MULTITAP'
};

type ParamDef = { paramId: number; name: string; displayLabel?: string; unit?: string };
// NOTE: `taper`/`taperPoints` are declared here so `#display` can read a device-true taper type-safely
// from EITHER source `ranges` resolves to — a static-catalog row (which carries them today) or a
// walk-built RangeDef (which gains `taper` in a parallel work package). Optional → both read cleanly,
// no rework when the walk builder starts populating it. `custom` also carries `taperPoints`.
type RangeDef = { kind: string; displayMin: number; displayMax: number; typecode: number; scale?: number; step?: number; unit?: string; taper?: 'linear' | 'log' | 'flat' | 'custom'; taperPoints?: ReadonlyArray<readonly [number, number]>; enumCount?: number };
type ParamsByFamily = Record<string, ParamDef[]>;
type Ranges = Record<string, Record<number, RangeDef>>;
type RangeSections = Record<string, { stride: number; recordCount: number }>;

/** One row where the device cache supplied a value for a MEASURED-overlay row (forgefx-midi
 *  `rangeOverlay.ts`) that DIFFERS from the value a SAME-FIRMWARE cache is expected to hold — i.e.
 *  GENUINE DRIFT, not the normal case. Served (never logged-only) so a maintainer SEES the deviation.
 *
 *  The expected value is the GENERATED (pre-overlay) row's displayed bounds — what a cache built from
 *  THIS firmware's device records carries. A cache that AGREES with it is the ordinary same-firmware case
 *  and is NOT reported. (An earlier version compared the cache against the CORRECTED catalogue instead, so
 *  every overlay row the cache carried was reported on every connect — the incident `11_13p0` cache
 *  carried exactly the generated bounds and reported two rows per connect; review finding #6.) A row whose
 *  cache value differs from that baseline IS reported: that is a firmware that fixed or moved the record,
 *  which is the change this diagnostic exists to make visible. */
export interface OverlayOverride {
  /** Family key as used in the range table (e.g. 'WAH'). */
  family: string;
  /** paramId within the family. */
  paramId: number;
  /** What the device CACHE carried for this row (the value the overlay replaced). */
  masked: { min: number; max: number };
  /** What a SAME-FIRMWARE cache is EXPECTED to hold — the pre-overlay GENERATED row's bounds (see
   *  {@link FM3_OVERLAY_FW13_BASELINE}); the value the cache is compared against to decide drift. */
  expected: { min: number; max: number };
  /** The static catalogue row's bounds (already overlay-corrected: FM3_RANGES applies the same overlay). */
  catalogue: { min: number; max: number };
  /** The overlay's own measured bounds — what is actually served for this row. */
  overlay: { min: number; max: number };
}

export interface DeviceProfile {
  model: number; // SysEx model byte (f[4])
  key: string; // 'fm3' | 'fm9'
  name: string;
  rows: number; // routing-grid dimensions
  cols: number;
  // How many of each block FAMILY this specific unit can actually run. The gen-3 protocol reserves
  // an ID range per family (Amp = eid 58..61) but a given unit allows far fewer — the FM3 has ONE
  // amp, not four. These device-true counts aren't in fractal-midi or the editor cache (they're
  // baked into the editor binary), so they live here, transcribed from Fractal's "Product BLOCKS
  // Comparison" (Blocks Guide) + the wiki "Current hardware" table. Unlisted families fall back to
  // `defaultInstances` (1) — i.e. only families listed with ≥2 get multiple palette instances.
  defaultInstances: number;
  instanceLimits: Record<string, number>; // slug → device-true instance count (≥2 only; rest = 1)
  params: ParamsByFamily;
  ranges: Ranges;
  /** The CATALOGUE (editor-mined) rows, kept alongside the merged `ranges` so a device-cache row that
   *  cannot be served on its own terms can fall back to the catalogue description instead of deleting
   *  the param. Set only on runtime profiles (see `runtimeProfileFrom`). */
  staticRanges?: Ranges;
  /** Device-true fn=0x1F channel-block wire stride by family. Do not derive this from max(paramId); tables include special high ids. */
  rangeSections: RangeSections;
  /** GENUINE DRIFT on a MEASURED-overlay row: a device-cache row whose value DIFFERS from the value a
   *  same-firmware cache is expected to hold (the pre-overlay generation, see FM3_OVERLAY_FW13_BASELINE).
   *  Set only on runtime profiles (see `runtimeProfileFrom`); served via /diag and /diag/ranges so the
   *  deviation is VISIBLE rather than silent. Empty in the normal same-firmware case — a cache that holds
   *  the expected (pre-overlay) bounds is NOT reported, however wrong those bounds are; only a cache that
   *  disagrees with them (a firmware that fixed or moved the record) is. */
  overlayOverrides?: OverlayOverride[];
  /** Per-family paramIds the device's OWN editor layouts draw as a continuous 'knob' (any variant), so
   *  the serve filters honour a knob the catalog tags with a non-display unit. See layoutWidgetByFamily. */
  layoutKnobIds?: ReadonlyMap<string, ReadonlySet<number>>;
  /** Per-family paramIds the device's OWN editor layouts draw as a discrete 'dropdown' selector. */
  layoutDropdownIds?: ReadonlyMap<string, ReadonlySet<number>>;
  rosterFor(slug: string): TypeModel[];
  enumLabelsFor(family: string, paramId: number): string[] | undefined;
  /** Cab IR names per bank (Factory 1/2, Legacy, Scratchpad) — for the cab IR picker. {} if the device has none. */
  cabIrs(): Record<string, string[]>;
  /** effectId → catalog family, incl. virtual effects (GLOBAL=1, Controllers=2, Modifier=3, FC=199). */
  familyForEffectId(eid: number): string | undefined;
  /** Editor-authentic UI layout for a family, resolved to the block-type/firmware variant selected by
   *  the block's CURRENT type value (`typeValue`); the variant's pages are further filtered to the
   *  block's current selector/firmware state via `selectors` (see resolveLayoutPages). Undefined if none. */
  layoutFor(family: string, typeValue?: number, selectors?: SelectorValues): DeviceLayout | undefined;
  /** Foot Controller address model. FM3 supports live state read; FM9/III expose the address model only. */
  fcModel?: FcModel;
  /** Modifier address model. Field map (bind) confirmed on FM3/FM9/III; source enum FM3-only for now. */
  modModel?: ModModel;
  /** Per-block monitor (meter) param table (paramName → {pid, role, dB range}); undefined if none. */
  monitorParams?: MonitorParams;
  /** Scene/channel write wire shape. FM3-Edit uses fn=0x01 raw-value frames; other Gen3 units stay on spec frames until capture-confirmed. */
  sceneChannelWriteMode?: 'spec' | 'fm3-edit-fn01';
}

// Every gen-3 device now ships its enum vocabulary FAMILY-shaped in forgefx-midi
// (family → paramId → labels[], mined complete from each editor's own
// effectDefinitions cache) — FM9/III are uniform with FM3. Shared helpers:
// TODO(lineage): these read-roster names carry no manufacturer/basedOn. forgefx-midi/shared exposes
// runLineageLookup(), but it is AM4-block-name-oriented (fuzzy score over LINEAGE_BLOCKS) and needs a
// (block_type, name) ask this generic helper has no family context for — so lineage is left null here.
// The device-cache path (runtimeProfileFrom below) DOES preserve lineage: it overlays the static
// roster's manufacturer/basedOn onto the device-true cache names.
const recToRoster = (r: Record<number, string>): TypeModel[] => {
  const out: TypeModel[] = [];
  for (const [k, name] of Object.entries(r)) out[Number(k)] = { value: Number(k), name, manufacturer: null, basedOn: null };
  return out;
};
const recToLabels = (r: Record<number, string>): string[] => {
  const out: string[] = [];
  for (const [k, name] of Object.entries(r)) out[Number(k)] = name;
  return out;
};
/** Selector suffixes a family may use for its type list, longest list wins (ties go to the earlier one).
 *  Length is the discriminator because a family can carry several plausible names, and the SHORT one is
 *  usually a legacy subset:
 *    • PLEX — `PLEX_PRESETS` pid 90 = the 45 types (matched name-for-name against the Fractal wiki's
 *      "Plex Delay types" list), while `PLEX_BASETYPE` pid 0 holds only the 5 legacy algorithms.
 *    • MULTITAP — `MULTITAP_PRESETS` pid 114 = 39; `MULTITAP_BASETYPE` pid 0 = 6.
 *    • DELAY — `DELAY_MODEL` pid 6 = 27 real models; `DELAY_TYPE` pid 7 = the 8 MONO/STEREO routing modes.
 *    • FM9 REVERB — `REVERB_TYPE` pid 10 = 79; `REVERB_BASETYPE` pid 49 = no enum at all. */
const TYPE_SELECTOR_SUFFIXES = ['MODEL', 'PRESETS', 'TYPE', 'BASETYPE'] as const;

/** The family's type selector: `{ paramId, labels }` for the candidate with the most labels. Exported so
 *  the driver's `#paramId(family,'type')` resolves the SAME param the roster came from — a roster of 45
 *  read/written through a 5-value param would mislabel every type. */
export const typeSelectorFor = (
  params: ParamsByFamily,
  labelsFor: (fam: string, paramId: number) => string[] | undefined
) => (fam: string): { paramId: number; labels: string[] } | null => {
  const defs = params[fam] ?? [];
  let best: { paramId: number; labels: string[] } | null = null;
  for (const suffix of TYPE_SELECTOR_SUFFIXES) {
    const def = defs.find((p) => p.name === `${fam}_${suffix}`);
    if (!def) continue;
    const labels = labelsFor(fam, def.paramId);
    if (!labels || labels.length <= 1) continue;
    if (!best || labels.length > best.labels.length) best = { paramId: def.paramId, labels };
  }
  return best;
};
/** FM3-style roster/labels over a family-shaped enum-override table. */
const familyShapedRosterFor = (params: ParamsByFamily, enums: Record<string, Record<string, string[]>>) => {
  const selector = typeSelectorFor(params, (fam, pid) => enums[fam]?.[String(pid)]);
  return (slug: string): TypeModel[] => {
    const fam = SLUG_FAMILY[slug.toLowerCase()];
    if (!fam) return [];
    const sel = selector(fam);
    return sel ? sel.labels.map((name, value) => ({ value, name, manufacturer: null, basedOn: null })) : [];
  };
};
const familyShapedEnumLabels = (enums: Record<string, Record<string, string[]>>) =>
  (family: string, paramId: number): string[] | undefined => enums[family]?.[String(paramId)];

const fm9Params = FM9_PARAMS_BY_FAMILY as unknown as ParamsByFamily;
const fm9Enums = FM9_ENUM_OVERRIDES as unknown as Record<string, Record<string, string[]>>;
const fm9RosterFor = familyShapedRosterFor(fm9Params, fm9Enums);
const fm9EnumLabels = familyShapedEnumLabels(fm9Enums);

// FM3 ships its device-true data IN fractal-midi (uniform with FM9/III): FM3_ROSTERS = slug → model
// list (already the {value,name,manufacturer,basedOn} shape, so no synthesis), FM3_ENUM_OVERRIDES =
// family → paramId → labels[], FM3_CAB_IRS = bank → IR names. ForgeFX is now a thin consumer.
const fm3Rosters = FM3_ROSTERS as unknown as Record<string, Fm3TypeModel[]>;
/** The 12.0-era enum tables overlaid with the fw-13.0 tables harvested from the official editor cache
 *  (see `forgefx-midi/gen3/fm3/typeTables.fw13.generated.ts`): type selectors AND the sub-type rows they
 *  gate (tube type, drive P/N diodes). The cache's other surfaces (ranges, IR banks, PRESET/FC rows) are
 *  NOT overlaid — they would change decode/eeprom behaviour, not just option lists. */
const fm3Enums: Record<string, Record<string, string[]>> = (() => {
  const base = FM3_ENUM_OVERRIDES as unknown as Record<string, Record<string, string[]>>;
  const merged: Record<string, Record<string, string[]>> = { ...base };
  for (const [fam, t] of Object.entries(FM3_TYPE_TABLES_FW13)) {
    merged[fam] = { ...(base[fam] ?? {}), [String(t.paramId)]: [...t.labels] };
  }
  // Sub-type rows (tube type, drive P/N diodes, …) — same provenance, merged the same way. Without them
  // a block's page offers 12.0's option list while the firmware answers with 13.0's ordinals.
  for (const [fam, pids] of Object.entries(FM3_ENUM_ROWS_FW13)) {
    merged[fam] = { ...(merged[fam] ?? {}) };
    for (const [pid, labels] of Object.entries(pids)) merged[fam]![pid] = [...labels];
  }
  return merged;
})();
/** FM3_RANGES with the fw-13 enum extents applied for the rows we overlay. A type list that grew must
 *  also widen `enumCount`/`displayMax`, because the served dropdown is bounded by the RANGE row (gen3
 *  `#enumOptions` walks min..min+enumCount-1) while the roster is bounded by the labels: without this the
 *  /types list showed 27 chorus types and the block's own picker still stopped at ordinal 17. Only grows. */
const fm3Ranges: Ranges = (() => {
  type Row = { kind?: string; displayMin: number; displayMax: number; scale?: number; enumCount?: number };
  const src = FM3_RANGES as unknown as Record<string, Record<string, Row>>;
  const out: Record<string, Record<string, Row>> = {};
  for (const [fam, byPid] of Object.entries(src)) out[fam] = { ...byPid };
  const grow = (fam: string, pid: number, n: number) => {
    const r = out[fam]?.[String(pid)];
    if (!r || (r.enumCount ?? 0) >= n) return; // absent row, or already wide enough — never shrink
    // Only ENUM rows. The cache also labels a couple of continuous/bypass rows (OUTPUT_BYPASSMODE is a
    // float row with a degenerate 0..0 span); widening those would invent slider bounds that the record
    // never had. Their labels stay available for name lookup, their extents stay untouched.
    if (r.kind !== 'enum') return;
    const scale = r.scale && r.scale > 0 ? r.scale : 1;
    out[fam]![String(pid)] = { ...r, enumCount: n, displayMax: r.displayMin + scale * (n - 1) };
  };
  for (const [fam, t] of Object.entries(FM3_TYPE_TABLES_FW13)) grow(fam, t.paramId, t.labels.length);
  for (const [fam, pids] of Object.entries(FM3_ENUM_ROWS_FW13)) {
    for (const [pid, labels] of Object.entries(pids)) grow(fam, Number(pid), labels.length);
  }
  return out as unknown as Ranges;
})();
const fm3CabIrs = FM3_CAB_IRS as unknown as Record<string, string[]>;
const fm3Params = FM3_PARAMS_BY_FAMILY as unknown as ParamsByFamily;
const fm3EnumRosterFor = familyShapedRosterFor(fm3Params, fm3Enums);
function fm3RosterFor(slug: string): TypeModel[] {
  const explicit = fm3Rosters[slug.toLowerCase()] as TypeModel[] | undefined;
  const fromEnum = fm3EnumRosterFor(slug);
  if (!explicit?.length) {
    // Families without a pre-baked roster ship their sub-model list as the enum override on the model
    // selector (chorus, phaser, tremolo, filter, flanger, plex, multitap…).
    return fromEnum;
  }
  // The pre-baked roster wins only while it is at least as LONG as the firmware's own list. A longer
  // device list means the block gained types since that roster was baked (fw 13.0: amps 331 -> 336,
  // drive 86 -> 87, chorus 18 -> 27), and serving the short one leaves the picker incomplete AND
  // decodes the tail ordinals against the wrong length. Lineage (manufacturer/basedOn) is carried over
  // by value, so the extra entries arrive with names only.
  // Equal length still prefers the firmware list: fw 13.0 RENAMED three reverbs without changing the
  // count (Asylum Hall -> Asylum, Vibrato-King -> Vibra-King), and a strict "<" test silently served the
  // old names. Only a SHORTER enum list loses (that is the truncated-walk case the guard exists for).
  if (fromEnum.length < explicit.length) return explicit;
  const byValue = new Map(explicit.map((t) => [t.value, t]));
  return fromEnum.map((t) => ({ ...t, manufacturer: byValue.get(t.value)?.manufacturer ?? null, basedOn: byValue.get(t.value)?.basedOn ?? null }));
}
function fm3EnumLabels(family: string, paramId: number): string[] | undefined {
  return fm3Enums[family]?.[String(paramId)];
}

// Axe-Fx III ranges: device-true AXE3_RANGES (mined from the III editor cache, fw 32.6 era) merged
// over the param table's inline displayMin/Max. Cache placeholder rows (all-zero float rows kept 1:1
// for wire-stride math) carry no display info — inline bounds win there; informative cache rows win
// everywhere else (they're the newer authority).
// Units that mark a musician-facing CONTINUOUS control (a knob). 'numeric' = a plain unitless knob
// (Drive, Tone, Level, cut freqs…) — primary controls in many families; only 'unverified' / 'count' /
// 'enum' are non-knobs. This is the ONE source of truth, shared by the gen-3 driver's knob gate
// (blockParams' `named` list, imported there) AND this module's Axe-Fx III float-vs-enum classifier
// below — the two used to be separate sets that drifted ('pf' was in the driver's set but not this
// one, so a III param in pF classified as a phantom enum dropdown).
// NOTE: this is an ALLOWLIST, so a real display unit missing here silently deletes the control from
// every client (blockParams never serves it) and mis-brands it in the III classifier. 'pf'
// (picofarads — UNIT_LABEL renders it 'pF') is a real unit: the amp block's Bright Cap (III
// DISTORT/10, FM3 DISTORT/16, 10..10000 pF) is a 'knob' in the device's own layout.
// test/drivers/knob-coverage.test.ts guards the invariant that no displayable unit is left out.
export const KNOB_UNITS: ReadonlySet<string> = new Set([
  'numeric', 'knob_0_10', 'knob_0_20', 'db', 'hz', 'ms', 'seconds', 'percent', 'bipolar_percent', 'ratio', 'semitones', 'degrees', 'pf'
]);
const axe3Params = AXE3_PARAMS as unknown as Record<string, (ParamDef & { displayMin?: number; displayMax?: number })[]>;
const axe3DeviceRanges = AXE3_DEVICE_RANGES as unknown as Ranges;
const AXE3_RANGES: Ranges = (() => {
  const out: Ranges = {};
  for (const [fam, list] of Object.entries(axe3Params)) {
    out[fam] = {};
    for (const p of list) {
      if (p.displayMin == null || p.displayMax == null) continue;
      out[fam][p.paramId] = { kind: KNOB_UNITS.has(p.unit ?? '') ? 'float' : 'enum', displayMin: p.displayMin, displayMax: p.displayMax, typecode: 0 };
    }
  }
  for (const [fam, rows] of Object.entries(axe3DeviceRanges)) {
    out[fam] ??= {};
    for (const [pid, r] of Object.entries(rows)) {
      if (r.kind === 'float' && r.displayMin === r.displayMax) continue; // placeholder row
      out[fam][Number(pid)] = r;
    }
  }
  return out;
})();
// III type ROSTERS + enum labels. Device-true AXE3_ENUM_OVERRIDES first (complete, fw-current, incl.
// the 10 families GEN3_READ_ROSTERS never had and the DELAY_MODEL list); then the legacy read rosters
// (`Record<number,string>`, normalize via recToRoster — never `.map`); then the effect-type overlay.
// Some (e.g. CABINET) have none anywhere — those degrade to [] (III IR/cab names are read live).
const axe3Enums = AXE3_ENUM_OVERRIDES as unknown as Record<string, Record<string, string[]>>;
const axe3ReadRosters = GEN3_READ_ROSTERS as unknown as Record<string, Record<number, string>>;
const axe3DeviceRosterFor = familyShapedRosterFor(axe3Params as unknown as ParamsByFamily, axe3Enums);
const axe3DeviceEnumLabels = familyShapedEnumLabels(axe3Enums);
function axe3RosterFor(slug: string): TypeModel[] {
  const device = axe3DeviceRosterFor(slug);
  if (device.length) return device;
  const fam = SLUG_FAMILY[slug.toLowerCase()];
  if (!fam) return [];
  const read = axe3ReadRosters[`${fam}_TYPE`];
  if (read) return recToRoster(read);
  const ov = axe3Enum(`${fam}_TYPE`)?.values as Record<number, string> | undefined;
  return ov ? recToRoster(ov) : [];
}
function axe3EnumLabels(family: string, paramId: number): string[] | undefined {
  const device = axe3DeviceEnumLabels(family, paramId);
  if (device) return device;
  const p = axe3Params[family]?.find((x) => x.paramId === paramId);
  const ov = p ? (axe3Enum(p.name)?.values as Record<number, string> | undefined) : undefined;
  if (!ov) return undefined;
  const labels = recToLabels(ov);
  return labels.length ? labels : undefined;
}

export const PROFILES: Record<number, DeviceProfile> = {
  0x10: {
    model: 0x10, key: 'axe3', name: 'Axe-Fx III', rows: 6, cols: 14,
    defaultInstances: 1,
    instanceLimits: { amp: 2, cab: 2, drive: 4, comp: 4, multicomp: 2, geq: 4, peq: 4, filter: 4, volume: 4, gate: 4, mixer: 4, multiplexer: 2, input: 5, output: 4, chorus: 2, flanger: 2, phaser: 2, rotary: 2, tremolo: 2, wah: 2, formant: 2, enhancer: 2, resonator: 2, reverb: 2, delay: 4, multitap: 2, megatap: 2, tentap: 2, plex: 2, pitch: 2, synth: 2, send: 2, return: 2 },
    params: axe3Params as unknown as ParamsByFamily,
    ranges: AXE3_RANGES,
    rangeSections: AXE3_RANGE_SECTIONS as unknown as RangeSections,
    rosterFor: axe3RosterFor,
    enumLabelsFor: axe3EnumLabels,
    cabIrs: () => AXE3_CAB_IRS as unknown as Record<string, string[]>, // factory banks bundled (III editor cache, fw 32.6 era); USER banks read live
    familyForEffectId: eidFamily(), // III ships no effectId table → shared gen-3 virtual eids only
    layoutFor: layoutFrom(AXE3_LAYOUTS as unknown as DeviceEditorLayouts),
    layoutKnobIds: layoutWidgetByFamily(AXE3_LAYOUTS as unknown as DeviceEditorLayouts, 'knob'),
    layoutDropdownIds: layoutWidgetByFamily(AXE3_LAYOUTS as unknown as DeviceEditorLayouts, 'dropdown'),
    fcModel: AXE3_FC_MODEL,
    modModel: AXE3_MOD_MODEL,
    monitorParams: AXE3_MONITOR_PARAMS
  },
  0x11: {
    model: 0x11, key: 'fm3', name: 'FM3', rows: 4, cols: 12,
    // FM3 = ONE amp / ONE cab / ONE reverb / ONE delay-family-pitch etc. (its DSP is ~1/5 the III).
    defaultInstances: 1,
    instanceLimits: { input: 2, output: 2, drive: 2, comp: 2, geq: 2, peq: 2, filter: 4, volume: 2, gate: 2, mixer: 4, multiplexer: 2, chorus: 2, flanger: 2, phaser: 2, rotary: 2, tremolo: 2, wah: 2, formant: 2, enhancer: 2, resonator: 2, delay: 2, multitap: 2, send: 2, return: 2 },
    params: FM3_PARAMS_BY_FAMILY as unknown as ParamsByFamily,
    ranges: fm3Ranges,
    rangeSections: FM3_RANGE_SECTIONS as unknown as RangeSections,
    rosterFor: fm3RosterFor, // device-true names + manufacturer + basedOn (from fractal-midi FM3_ROSTERS)
    enumLabelsFor: fm3EnumLabels,
    cabIrs: () => fm3CabIrs, // device-true IR names per bank (fractal-midi FM3_CAB_IRS)
    familyForEffectId: eidFamily(FM3_FAMILY_BY_EFFECT_ID as Record<number, string>),
    layoutFor: layoutFrom(FM3_LAYOUTS as unknown as DeviceEditorLayouts),
    layoutKnobIds: layoutWidgetByFamily(FM3_LAYOUTS as unknown as DeviceEditorLayouts, 'knob'),
    layoutDropdownIds: layoutWidgetByFamily(FM3_LAYOUTS as unknown as DeviceEditorLayouts, 'dropdown'),
    fcModel: FM3_FC_MODEL,
    modModel: FM3_MOD_MODEL,
    monitorParams: FM3_MONITOR_PARAMS,
    sceneChannelWriteMode: 'fm3-edit-fn01'
  },
  0x12: {
    model: 0x12, key: 'fm9', name: 'FM9', rows: 6, cols: 14,
    defaultInstances: 1,
    instanceLimits: { amp: 2, cab: 2, drive: 3, comp: 2, multicomp: 2, geq: 4, peq: 4, filter: 4, volume: 4, gate: 4, mixer: 4, multiplexer: 2, input: 4, output: 3, chorus: 2, flanger: 2, phaser: 2, rotary: 2, tremolo: 2, wah: 2, formant: 2, enhancer: 2, resonator: 2, reverb: 2, delay: 2, multitap: 2, megatap: 2, tentap: 2, send: 2, return: 2 },
    params: fm9Params,
    ranges: FM9_RANGES as unknown as Ranges,
    rangeSections: FM9_RANGE_SECTIONS as unknown as RangeSections,
    rosterFor: fm9RosterFor,
    enumLabelsFor: fm9EnumLabels,
    cabIrs: () => FM9_CAB_IRS as unknown as Record<string, string[]>, // factory banks bundled (FM9-Edit cache 76p0); USER banks read live
    familyForEffectId: eidFamily(FM9_FAMILY_BY_EFFECT_ID as Record<number, string>),
    layoutFor: layoutFrom(FM9_LAYOUTS as unknown as DeviceEditorLayouts),
    layoutKnobIds: layoutWidgetByFamily(FM9_LAYOUTS as unknown as DeviceEditorLayouts, 'knob'),
    layoutDropdownIds: layoutWidgetByFamily(FM9_LAYOUTS as unknown as DeviceEditorLayouts, 'dropdown'),
    fcModel: FM9_FC_MODEL,
    modModel: FM9_MOD_MODEL,
    monitorParams: FM9_MONITOR_PARAMS
  }
};

export const DEFAULT_PROFILE: DeviceProfile = PROFILES[0x11]!;
export const profileForModel = (model: number): DeviceProfile => PROFILES[model] ?? DEFAULT_PROFILE;
export const profileForKey = (key: string): DeviceProfile | undefined => Object.values(PROFILES).find((p) => p.key === key);

/**
 * The fw-13.0 PRE-OVERLAY ("generated") display bounds for the overlay rows the measured correction
 * actually MOVES — i.e. the value a same-firmware device cache is EXPECTED to hold. Transcribed from
 * `forgefx-midi/src/gen3/fm3/ranges.generated.ts` (the table whose rows the overlay replaces), which is
 * NOT importable here: the codec's `./gen3/fm3` export point applies the overlay and exposes only the
 * CORRECTED table, and its `exports` map has no subpath for the pre-overlay file. Only the overlay rows
 * whose generated bounds DIFFER from the corrected ones are listed; a row absent here is one the overlay
 * does NOT move (its generated value already equals the corrected one — e.g. the `valueMap:'identity'`
 * rows), and the expected value falls back to the corrected catalogue value for it.
 *
 * This is a fixed fw-13.0 FLOOR, not a rule: a cache that agrees with it is the normal case and is NOT
 * reported; a cache that differs is GENUINE DRIFT. If upstream ever corrects these rows, the entries here
 * become the fw-13.0 record and a cache carrying the corrected value is reported — the intended "a
 * firmware change is visible" behaviour (review finding #6).
 */
export const FM3_OVERLAY_FW13_BASELINE: Record<string, Record<number, { min: number; max: number }>> = {
  CABINET: { 33: { min: 0.01, max: 10 } },
  CHORUS: { 20: { min: 0.5, max: 500 } },
  DELAY: { 22: { min: 0.5, max: 500 }, 58: { min: 2, max: 200 } },
  DISTORT: { 72: { min: 0.1, max: 10 }, 90: { min: 2.5, max: 40 } },
  FILTER: { 25: { min: 10, max: 200 }, 28: { min: 1, max: 400 } },
  FLANGER: { 20: { min: 0.05, max: 50 }, 26: { min: 200, max: 20000 } },
  FORMANT: { 3: { min: 40, max: 400 } },
  FUZZ: { 6: { min: 1, max: 100 } },
  MULTITAP: { 65: { min: 5, max: 5000 } },
  REVERB: { 32: { min: 0.1, max: 10 } },
  ROTARY: { 17: { min: 0.5, max: 500 } },
  WAH: { 3: { min: 20, max: 200 }, 10: { min: 0.1, max: 10 } }
};

/**
 * GENUINE DRIFT on the overlay rows: a device-CACHE row for a measured-overlay row whose value DIFFERS
 * from the value a same-firmware cache is expected to hold. `cacheRanges` is the DEVICE CACHE's own rows
 * (`BuiltCache.ranges`, before the static merge — a row present here is one the cache actually supplied);
 * `catalogue` is the static table (`FM3_RANGES`, already overlay-corrected).
 *
 * A row is reported ONLY when the cache CARRIED it AND its value differs from {@link
 * FM3_OVERLAY_FW13_BASELINE} (the pre-overlay generated value a same-firmware cache holds; the corrected
 * catalogue value for a row the overlay does not move). So the incident `11_13p0` cache — which carries
 * exactly the generated bounds — reports NOTHING (the normal case), and only a cache that disagrees with
 * that baseline (a firmware that fixed or moved the record) is reported. Only `displayMin`/`displayMax`
 * are compared because those are the fields the overlay touches (a cache row never carries `valueMap`,
 * so comparing it would flag every row).
 */
export function collectOverlayOverrides(cacheRanges: Ranges, catalogue: Ranges): OverlayOverride[] {
  const out: OverlayOverride[] = [];
  for (const entry of FM3_RANGE_OVERLAY as readonly Fm3RangeOverlayEntry[]) {
    // The cache must have SUPPLIED this row: a row the cache did not carry masks nothing (the corrected
    // static value is served) and must never be reported.
    const masked = cacheRanges[entry.family]?.[entry.paramId];
    const stat = catalogue[entry.family]?.[entry.paramId];
    if (!masked || !stat) continue;
    // What a same-firmware cache is EXPECTED to hold: the generated (pre-overlay) bounds, falling back to
    // the corrected value for a row the overlay does not move (there the generated value already equals it).
    const expected = FM3_OVERLAY_FW13_BASELINE[entry.family]?.[entry.paramId] ?? { min: stat.displayMin, max: stat.displayMax };
    if (masked.displayMin === expected.min && masked.displayMax === expected.max) continue; // agrees with the known-wrong baseline → normal, not reported
    out.push({
      family: entry.family,
      paramId: entry.paramId,
      masked: { min: masked.displayMin, max: masked.displayMax },
      expected,
      catalogue: { min: stat.displayMin, max: stat.displayMax },
      overlay: { min: entry.displayMin, max: entry.displayMax }
    });
  }
  return out;
}

/**
 * Overlay a device-cache-derived `BuiltCache` (from the on-connect self-describe walk) onto a static
 * gen-3 profile: DEVICE data wins where the cache has it, the static profile supplies everything else.
 *   • rosterFor — the family's device-true model list from `built.rosters` (keyed by catalog family,
 *     mapped from slug via SLUG_FAMILY), with the STATIC roster's manufacturer/basedOn LINEAGE
 *     overlaid by value (the cache carries names only); families the walk didn't map fall back to static.
 *   • enumLabelsFor — `built.enumOverrides` first, else static.
 *   • ranges / rangeSections — the cache's per-family entries merged OVER the static ones.
 *   • cabIrs — the cache's banks when non-empty, else static.
 * The model byte, grid dims, instanceLimits, params, layouts, FC/Mod/monitor models, and write mode
 * all stay from the static profile (the walk doesn't recover them). Pure — returns a fresh profile.
 */
export function runtimeProfileFrom(built: BuiltCache, staticProfile: DeviceProfile): DeviceProfile {
  const builtRosters = built.rosters ?? {};
  const builtEnums = (built.enumOverrides ?? {}) as Record<string, Record<string, string[]>>;
  const builtCabIrs = built.cabIrs ?? {};

  // ranges: static per-family maps, then the cache's rows merged over them (device-true wins).
  //
  // …but a cache row may only REFINE a param, never DELETE it. A degenerate row (zero-width display
  // range) carries no information and, if it wins, silently removes a param the device's own editor
  // layout still references — a control on the device page that binds to nothing. Real case: the FM3
  // Cab block's per-cab MUTE (pid 25) — the layout serves a M/S button for cab 2, but a degenerate
  // cached row for 25 dropped the enum, so the second cab's Mute/Solo vanished from the UI entirely.
  const usable = (r?: RangeDef): boolean =>
    !!r && Number.isFinite(r.displayMin) && Number.isFinite(r.displayMax) && r.displayMax > r.displayMin;
  const mergedRanges: Ranges = {};
  for (const [fam, rows] of Object.entries(staticProfile.ranges)) mergedRanges[fam] = { ...rows };
  for (const [fam, rows] of Object.entries(built.ranges ?? {})) {
    const merged: Record<number, RangeDef> = { ...(mergedRanges[fam] ?? {}) };
    for (const [pid, row] of Object.entries(rows as Record<string, RangeDef>)) {
      const stat = merged[Number(pid)];
      const keepStatic = !usable(row) && usable(stat);
      merged[Number(pid)] = keepStatic && stat ? stat : row;
    }
    mergedRanges[fam] = merged;
  }

  // ── The MEASURED range overlay is the FINAL authority for its rows — applied HERE, LAST ───────────
  //
  // A cache row can silently override ANY static correction. The FM3 static table already carries the
  // typecode-0x52 display-bounds correction (forgefx-midi applies FM3_RANGE_OVERLAY at its FM3 index
  // export, so `FM3_RANGES` — and therefore the static profile — is corrected). But that correction
  // lives in the SAME base rows the cache was built from, so a device cache captured from that same
  // wrong record re-supplies the OLD bounds and, being merged OVER the static table above, WINS — and
  // the correction is invisible in the product. MEASURED 2026-10-13: the `11_13p0` cache carries
  // WAH/3 `20..200` (forgefx-midi source: `0..10`) and FLANGER/26 `200..20000` (source: `0..10`), so
  // a full rebuild + restart still served WAH/3 Resonance Q 129.15 where the unit shows 6.06, and
  // FLANGER/26 Bass Focus 20000 where the unit reads 10.00 at the knob's maximum.
  //
  // The rule, stated generally: a MEASURED correction beats BOTH the static table AND a device cache
  // built from the same wrong record, because it is the only one of the three that was checked against
  // the instrument's own display. The overlay's (family, paramId) rows are therefore re-applied as the
  // LAST step, after the cache merge, so nothing below this point can shadow them. (The overlay only
  // overrides displayMin/displayMax and skips rows absent from the table, so it is a value-level no-op
  // wherever upstream is already correct — see forgefx-midi's rangeOverlay.ts.)
  //
  // NO CACHE REBUILD IS THE FIX, and none is available: a full-mode cache capture SWEEPS PARAMETERS and
  // WRITES to the unit — on 2026-10-12 one corrupted the owner's per-preset switch block (see the
  // skill's cache-incident record). The overlay-wins rule removes the need to invalidate anything.
  //
  // The overlay is device-specific data (its entries were measured on an FM3), so it is applied ONLY
  // when this profile's static table IS the FM3 table — identity, not a hardcoded model byte.
  //
  // REVIEW FINDING #5 — the overlay is UNCONDITIONAL over the firmware, and that is the choice made
  // here (option (b): keep it unconditional but make every override VISIBLE), for three reasons:
  //   • The option (a) firmware gate would be a behavioural REGRESSION, not a safety net. The overlay's
  //     correction is a front-panel DISPLAY-mapping fact (the unit shows 0..10 where the record's raw
  //     bounds say otherwise) and the codec already treats it as a value-level no-op where upstream is
  //     right. Gating it on "firmware 13.x" would DROP the correction for every cache whose firmware
  //     field is absent or spelled differently — editor-cache imports, cloud pulls, and older stored
  //     docs (`BuiltCache.firmware` is optional and best-effort), and for a firmware that STILL carries
  //     the wrong record. We have no measurement that any later firmware fixed any of these rows, so
  //     dropping a measured correction on spec is worse than the masking it would prevent.
  //   • The finding's actual harm is the word "silently". REPORTING only GENUINE DRIFT — a cache row that
  //     differs from the fw-13.0 pre-overlay baseline a same-firmware cache is expected to hold
  //     (FM3_OVERLAY_FW13_BASELINE) — lets a maintainer see exactly the rows a firmware changed, and only
  //     those, the moment a firmware diff appears. (Review finding #6: the first cut compared the cache
  //     against the CORRECTED catalogue instead, so the incident cache — which carries the generated
  //     bounds — reported its rows on EVERY connect, i.e. the remedy could not detect what it was for.)
  //   • It keeps a single, testable code path (no version parsing, no new failure mode).
  // The overrides are a SERVED diagnostic field (on the runtime profile, read by /diag and
  // /diag/ranges), never a log line alone. See OverlayOverride.
  const isFm3StaticTable = staticProfile.ranges === fm3Ranges;
  // The detector is handed the CACHE's OWN rows (not the merged map): a row the cache did not carry masks
  // nothing and must not be reported, and the comparison is against the fw-13.0 pre-overlay baseline (the
  // value a same-firmware cache is expected to hold) — not against the corrected catalogue, which would
  // flag every overlay row the incident cache carries on every connect (review finding #6).
  const overlayOverrides = isFm3StaticTable
    ? collectOverlayOverrides((built.ranges ?? {}) as Ranges, staticProfile.ranges)
    : [];
  const finalRanges: Ranges = isFm3StaticTable
    ? (applyFm3RangeOverlay(mergedRanges as unknown as Fm3RangeTable) as unknown as Ranges)
    : mergedRanges;

  // rangeSections: the fn=0x1F CHANNEL-BLOCK WIRE STRIDE is a device-true, statically-measured
  // constant (e.g. FM3 CABINET = 106; FM3_RANGE_SECTIONS, hardware-derived). It comes from the STATIC
  // profile ONLY — there is deliberately NO cache overlay here.
  //
  // Why no overlay, even guarded: the live self-describe walk CANNOT recover this stride — the cache
  // builder writes `stride: sec.size` (forgefx-midi/src/cache/assign.ts), the number of ordinary
  // records the walk happened to observe (FM3 CABINET: 63), which is NOT the record stride, and the
  // walk's own label loop ends at the first empty/timeout reply (forgefx-midi/src/cache/liveWalk.ts),
  // so its counts are truncated by construction. The consumed value is `#channelSlice`'s
  // `stride`/`base` (drivers/gen3.ts): `base = activeChannel * stride` indexes the bulk body, so a
  // wrong stride reads a DIFFERENT window of the SAME bytes. MEASURED 2026-10-12: a "live" cache
  // rebuild turned Cab Room Diffusion 0 → 52.287 (and Room Level 36.5 → 50, Mic Spacing 17 → 50) over
  // a body that differed from the captured one by ONE unrelated Tap-Tempo byte — a served value that
  // is not a function of the device state alone.
  //
  // Crucially, fixing only the merge is not enough: bad strides are ALREADY persisted in the
  // `deviceCaches` store (services/deviceCache.ts putDoc — it stores whatever the walk built), and a
  // cached doc can also arrive from an import or a cloud pull. Any read-side path that reads a stride
  // out of a cache row is therefore a latent repeat, including the previous "keep the static stride,
  // take the cache's sectionTag/recordCount" merge — the poisoned row still round-trips. So the cache
  // contributes NOTHING to wire geometry.
  //
  // For a family the static table lacks, `#channelSlice` has its own, better fallback —
  // `itemCount % 4 === 0 ? itemCount / 4 : max(1, values.length)` — which is EXACT for a 4-channel
  // body, whereas a short observed count is not. `staticProfile.rangeSections` is used verbatim.
  return {
    ...staticProfile,
    ranges: finalRanges,
    staticRanges: staticProfile.ranges, // catalogue rows, for the servability fallback in the driver
    rangeSections: staticProfile.rangeSections,
    overlayOverrides, // review finding #5 — the overlay's masked rows, served (not silent)
    rosterFor(slug: string): TypeModel[] {
      const fam = SLUG_FAMILY[slug.toLowerCase()];
      const cacheRoster = fam ? builtRosters[fam] : undefined;
      const staticRoster = staticProfile.rosterFor(slug); // walk didn't map this family → static
      // A cache roster may only REPLACE the static one when it is at least as LONG. The device-true
      // list arrives truncated by construction: the live label walk ends at the first empty/timeout
      // reply (forgefx-midi/src/cache/liveWalk.ts) and a read-only walk stops at param 127. A shorter
      // list would shift every model ordinal — the type decode is
      // `tv = raw > max ? round(raw/65534*max) : raw` with `max` derived from this list's length
      // (drivers/gen3.ts), so one walk timeout can silently decode an amp type as model 0. So a
      // truncated list LOSES to the static one; only a list as long as the static one replaces it.
      if (!cacheRoster?.length || cacheRoster.length < staticRoster.length) return staticRoster;
      const byValue = new Map(staticRoster.map((t) => [t.value, t]));
      return cacheRoster.map((t) => {
        const s = byValue.get(t.value);
        return { value: t.value, name: t.name, manufacturer: t.manufacturer ?? s?.manufacturer ?? null, basedOn: t.basedOn ?? s?.basedOn ?? null };
      });
    },
    enumLabelsFor(family: string, paramId: number): string[] | undefined {
      const staticLabels = staticProfile.enumLabelsFor(family, paramId);
      const cacheLabels = builtEnums[family]?.[String(paramId)];
      // A cache label list may only REPLACE the static one when it is at least as LONG — same reason as
      // rosterFor above: the live walk ends at the first empty/timeout reply (liveWalk.ts), so a
      // TRUNCATED list can arrive, and the enum decode derives its `max` from the list length
      // (drivers/gen3.ts), so a short list silently re-scales the raw value (an amp type decodes as
      // model 0). `??` falls through only on `undefined`, so a truncated list would win by being
      // present, not by being complete. A shorter list therefore LOSES to the static one.
      if (!cacheLabels || (staticLabels && cacheLabels.length < staticLabels.length)) return staticLabels;
      return cacheLabels;
    },
    cabIrs(): Record<string, string[]> {
      return Object.keys(builtCabIrs).length > 0 ? builtCabIrs : staticProfile.cabIrs();
    }
  };
}
