// paramId cross-contamination guard — asserts each gen-3 profile in src/devices.ts wires the
// EXACT catalog table objects (object identity, ===) from its own forgefx-midi device module,
// and NOT another device's. A paste/import slip that pointed the FM9 profile at FM3 tables
// (the paramId cross-contamination bug class) fails here immediately.
//
// Grounded in what src/devices.ts actually wires:
//   0x11 (FM3):  params/ranges/monitorParams/fc fields/mod fields/rosters/enum labels/cab IRs
//                come straight from forgefx-midi/gen3/fm3.
//   0x12 (FM9):  params/ranges/monitorParams/fc fields/mod fields from forgefx-midi/gen3/fm9
//                (rosters + enum labels are synthesized from FM9_ENUM_OVERRIDES — no identity).
//   0x10 (III):  params/monitorParams/fc fields/mod fields from forgefx-midi/gen3/axe-fx-iii
//                (its ranges table is synthesized in devices.ts — asserted distinct from FM3/FM9).
import { PROFILES, SLUG_FAMILY, typeSelectorFor } from '../../src/devices.js';
import {
  FM3_PARAMS_BY_FAMILY, FM3_RANGES, FM3_MONITOR_PARAMS, FM3_FC_FIELDS, FM3_MOD_FIELDS,
  FM3_ROSTERS, FM3_ENUM_OVERRIDES, FM3_CAB_IRS
} from 'forgefx-midi/gen3/fm3';
import {
  FM9_PARAMS_BY_FAMILY, FM9_RANGES, FM9_MONITOR_PARAMS, FM9_FC_FIELDS, FM9_MOD_FIELDS, FM9_ENUM_OVERRIDES
} from 'forgefx-midi/gen3/fm9';
import {
  PARAMS_BY_FAMILY as AXE3_PARAMS_BY_FAMILY, AXE3_MONITOR_PARAMS, AXE3_FC_FIELDS, AXE3_MOD_FIELDS,
  AXE3_ENUM_OVERRIDES
} from 'forgefx-midi/gen3/axe-fx-iii';

const fm3 = PROFILES[0x11]!;
const fm9 = PROFILES[0x12]!;
const axe3 = PROFILES[0x10]!;

const same = (a: unknown, b: unknown) => a === b;

const checks: Array<{ name: string; ok: () => boolean }> = [
  // ── FM3 profile ↔ forgefx-midi/gen3/fm3 (identity) ──
  { name: 'fm3.params === FM3_PARAMS_BY_FAMILY', ok: () => same(fm3.params, FM3_PARAMS_BY_FAMILY) },
  // The FM3 profile's ranges are FM3_RANGES plus the fw-13 enum-EXTENT overlay (a grown type list must widen
  // enumCount or the picker stops at the old last ordinal). Everything the overlay does not touch must be
  // byte-identical to the static table — that is what this identity check is for.
  {
    name: 'fm3.ranges === FM3_RANGES except the fw-13 enum extents',
    ok: () => {
      const a = FM3_RANGES as unknown as Record<string, Record<string, Record<string, unknown>>>;
      const b = fm3.ranges as unknown as Record<string, Record<string, Record<string, unknown>>>;
      const grown = new Set(['CHORUS/0', 'DISTORT/6', 'DISTORT/70', 'FUZZ/0', 'FUZZ/32', 'FUZZ/34', 'REVERB/0']);
      for (const [fam, pids] of Object.entries(a)) {
        for (const [pid, row] of Object.entries(pids)) {
          if (grown.has(`${fam}/${pid}`)) continue;
          if (!same(row, b[fam]?.[pid])) return false;
        }
      }
      return (b.CHORUS?.['0']?.enumCount as number) === 27;
    }
  },
  { name: 'fm3.monitorParams === FM3_MONITOR_PARAMS', ok: () => same(fm3.monitorParams, FM3_MONITOR_PARAMS) },
  { name: 'fm3.fcModel.fields === FM3_FC_FIELDS', ok: () => same(fm3.fcModel?.fields, FM3_FC_FIELDS) },
  { name: 'fm3.modModel.fields === FM3_MOD_FIELDS', ok: () => same(fm3.modModel?.fields, FM3_MOD_FIELDS) },
  // fm3.rosterFor('amp') is no longer the baked roster by identity: fw 13.0 added 5 amps and renamed one,
  // so the device-true (fw-13) list is longer and wins, carrying the baked lineage over by value.
  {
    name: "fm3.rosterFor('amp') is the fw-13 list with FM3_ROSTERS lineage preserved",
    ok: () => {
      const r = fm3.rosterFor('amp');
      return r.length === 336
        && r[283]!.name === 'Deluxe Tweed Bright'
        && r[335]!.name === 'Brit JVM Crunch Red'
        && r[10]!.manufacturer === (FM3_ROSTERS as unknown as { amp: { manufacturer: string | null }[] }).amp[10]!.manufacturer;
    }
  },
  { name: "fm3.rosterFor('drive') reaches the fw-13 count (87)", ok: () => fm3.rosterFor('drive').length === 87 },
  // Sub-type rows the block pages gate on: the fw-13 cache adds one tube and one diode on each side.
  // Without these the picker offers 12.0's list while the firmware answers with 13.0 ordinals.
  {
    name: 'fm3 sub-type enums follow fw 13.0 (tube 26, p/n diodes 22)',
    ok: () => {
      const l = (f: string, p: number) => fm3.enumLabelsFor(f, p) ?? [];
      return l('DISTORT', 70).length === 26
        && l('DISTORT', 70).includes('TRANSISTOR')
        && l('FUZZ', 32).length === 22
        && l('FUZZ', 34).length === 22;
    }
  },
  { name: "fm3.rosterFor('chorus') reaches the fw-13 count (27)", ok: () => fm3.rosterFor('chorus').length === 27 },
  // Typeless blocks are still enum-heavy: formant's three vowel selectors and the multiplexer's input
  // select/mode ship as per-parameter enums in the fw-13 cache. The type-selector-first generator loop
  // skipped these families, so their pickers showed bare ordinals.
  {
    name: 'fm3 typeless blocks carry their fw-13 per-parameter enums (formant vowels, multiplexer input)',
    ok: () => {
      const l = (f: string, p: number) => fm3.enumLabelsFor(f, p) ?? [];
      return l('FORMANT', 0).length === 10
        && l('FORMANT', 0)[0] === 'AAA'
        && l('FORMANT', 2).length === 10
        && l('MULTIPLEXER', 0).length === 8
        && l('MULTIPLEXER', 1).join(',') === 'STEREO,LEFT,RIGHT,SUM L+R';
    }
  },
  // The dropdown is bounded by the RANGE row (enumCount), the /types list by the labels. Widening only
  // one of them showed 27 chorus types in the roster while the block's own picker stopped at ordinal 17.
  {
    name: 'fm3 enum extent and label count agree (range.enumCount === labels.length)',
    ok: () => {
      const r = (fm3 as unknown as { ranges: Record<string, Record<string, { enumCount?: number }>> }).ranges;
      return ([['CHORUS', 0], ['DISTORT', 6], ['DISTORT', 70], ['FUZZ', 32], ['FUZZ', 34]] as [string, number][])
        .every(([f, p]) => r[f]?.[String(p)]?.enumCount === (fm3.enumLabelsFor(f, p) ?? []).length);
    }
  },
  // Model selectors named <FAM>_BASETYPE (PLEX, MULTITAP) were invisible to the <FAM>_TYPE-only
  // lookup, so those blocks' type pickers shipped empty. Guard the roster, not just the pid name.
  // PLEX_BASETYPE (pid 0) is the 5-algorithm legacy subset; the block's real type list is PLEX_PRESETS
  // (pid 90, 45 entries), matching the Fractal wiki's "Plex Delay types" name-for-name.
  {
    name: "fm3.rosterFor('plex') resolves all 45 Plex types from PLEX_PRESETS",
    ok: () => {
      const r = fm3.rosterFor('plex');
      return r.length === 45 && r[0]!.name === 'Plex Delay' && r.some((m) => m.name === 'Sample/Hold Delay');
    }
  },
  { name: "fm3.rosterFor('multitap') resolves 39 MULTITAP_PRESETS types", ok: () => fm3.rosterFor('multitap').length === 39 },
  {
    name: 'typeSelectorFor picks the roster param the driver reads/writes',
    ok: () => {
      const sel = typeSelectorFor(FM3_PARAMS_BY_FAMILY as never, (f, pid) =>
        (FM3_ENUM_OVERRIDES as Record<string, Record<string, string[]>>)[f]?.[String(pid)]);
      return sel('PLEX')?.paramId === 90 && sel('MULTITAP')?.paramId === 114
        && sel('DELAY')?.paramId === 6 && sel('REVERB')?.paramId === 0 && sel('DISTORT')?.paramId === 6;
    }
  },
  // Candidate ordering must be decided by labels, not by name: FM9 REVERB has both REVERB_TYPE (pid 10,
  // 79 models) and REVERB_BASETYPE (pid 49, no enum). Ranking BASETYPE first once emptied this roster.
  { name: "fm9.rosterFor('reverb') reaches the 79-model REVERB_TYPE list", ok: () => fm9.rosterFor('reverb').length === 79 },
  { name: "fm3.rosterFor('reverb') stays populated", ok: () => fm3.rosterFor('reverb').length > 50 },
  { name: "axe3.rosterFor('delay') stays populated", ok: () => axe3.rosterFor('delay').length > 20 },
  // Structural: EVERY block in SLUG_FAMILY whose params carry a selector-named enum (>1 label) must
  // resolve a roster. This is what catches the next empty type picker without a per-block report.
  {
    name: 'no block with a selector enum has an empty roster (fm3/fm9/III)',
    ok: () => {
      const gaps: string[] = [];
      for (const [key, prof, params, enums] of [
        [0x11, fm3, FM3_PARAMS_BY_FAMILY, FM3_ENUM_OVERRIDES],
        [0x12, fm9, FM9_PARAMS_BY_FAMILY, FM9_ENUM_OVERRIDES],
        [0x10, axe3, AXE3_PARAMS_BY_FAMILY, AXE3_ENUM_OVERRIDES]
      ] as const) {
        for (const [slug, fam] of Object.entries(SLUG_FAMILY)) {
          if (prof.rosterFor(slug).length >= 2) continue;
          const hasSelector = (params as Record<string, readonly { paramId: number; name: string }[]>)[fam]
            ?.some((p) => /_(MODEL|TYPE|BASETYPE)$/.test(p.name)
              && ((enums as Record<string, Record<string, string[]>>)[fam]?.[String(p.paramId)]?.length ?? 0) > 1);
          if (hasSelector) gaps.push(`0x${key.toString(16)}:${slug}:${fam}`);
        }
      }
      if (gaps.length) console.error('empty rosters despite a selector enum:', gaps.join(', '));
      return gaps.length === 0;
    }
  },
  { name: 'fm3.cabIrs() === FM3_CAB_IRS', ok: () => same(fm3.cabIrs(), FM3_CAB_IRS) },
  {
    name: 'fm3.enumLabelsFor serves FM3_ENUM_OVERRIDES arrays by identity',
    ok: () => {
      const overrides = FM3_ENUM_OVERRIDES as unknown as Record<string, Record<string, string[]>>;
      const family = Object.keys(overrides).find((f) => Object.keys(overrides[f]!).length > 0);
      if (!family) return false;
      const pid = Object.keys(overrides[family]!)[0]!;
      return same(fm3.enumLabelsFor(family, Number(pid)), overrides[family]![pid]);
    }
  },

  // ── FM9 profile ↔ forgefx-midi/gen3/fm9 (identity) ──
  { name: 'fm9.params === FM9_PARAMS_BY_FAMILY', ok: () => same(fm9.params, FM9_PARAMS_BY_FAMILY) },
  { name: 'fm9.ranges === FM9_RANGES', ok: () => same(fm9.ranges, FM9_RANGES) },
  { name: 'fm9.monitorParams === FM9_MONITOR_PARAMS', ok: () => same(fm9.monitorParams, FM9_MONITOR_PARAMS) },
  { name: 'fm9.fcModel.fields === FM9_FC_FIELDS', ok: () => same(fm9.fcModel?.fields, FM9_FC_FIELDS) },
  { name: 'fm9.modModel.fields === FM9_MOD_FIELDS', ok: () => same(fm9.modModel?.fields, FM9_MOD_FIELDS) },

  // ── Axe-Fx III profile ↔ forgefx-midi/gen3/axe-fx-iii (identity where the package ships a table) ──
  { name: 'axe3.params === PARAMS_BY_FAMILY (axe-fx-iii)', ok: () => same(axe3.params, AXE3_PARAMS_BY_FAMILY) },
  { name: 'axe3.monitorParams === AXE3_MONITOR_PARAMS', ok: () => same(axe3.monitorParams, AXE3_MONITOR_PARAMS) },
  { name: 'axe3.fcModel.fields === AXE3_FC_FIELDS', ok: () => same(axe3.fcModel?.fields, AXE3_FC_FIELDS) },
  { name: 'axe3.modModel.fields === AXE3_MOD_FIELDS', ok: () => same(axe3.modModel?.fields, AXE3_MOD_FIELDS) },
  // III ranges are synthesized in devices.ts — must never alias another device's table
  { name: 'axe3.ranges !== FM3_RANGES', ok: () => !same(axe3.ranges, FM3_RANGES) },
  { name: 'axe3.ranges !== FM9_RANGES', ok: () => !same(axe3.ranges, FM9_RANGES) },

  // ── cross-contamination negatives (the actual bug class) ──
  { name: 'fm9.params !== FM3_PARAMS_BY_FAMILY', ok: () => !same(fm9.params, FM3_PARAMS_BY_FAMILY) },
  { name: 'fm9.ranges !== FM3_RANGES', ok: () => !same(fm9.ranges, FM3_RANGES) },
  { name: 'fm9.monitorParams !== FM3_MONITOR_PARAMS', ok: () => !same(fm9.monitorParams, FM3_MONITOR_PARAMS) },
  { name: 'fm3.params !== FM9_PARAMS_BY_FAMILY', ok: () => !same(fm3.params, FM9_PARAMS_BY_FAMILY) },
  { name: 'fm3.ranges !== FM9_RANGES', ok: () => !same(fm3.ranges, FM9_RANGES) },
  { name: 'axe3.params !== FM3_PARAMS_BY_FAMILY', ok: () => !same(axe3.params, FM3_PARAMS_BY_FAMILY) },
  { name: 'axe3.params !== FM9_PARAMS_BY_FAMILY', ok: () => !same(axe3.params, FM9_PARAMS_BY_FAMILY) },
  { name: 'fm3/fm9/axe3 fc field maps are three distinct objects', ok: () => !same(FM3_FC_FIELDS, FM9_FC_FIELDS) && !same(FM9_FC_FIELDS, AXE3_FC_FIELDS) && !same(FM3_FC_FIELDS, AXE3_FC_FIELDS) }
];

export const TABLES_CASE_COUNT = checks.length;

export function runTablesTests(): void {
  for (const c of checks) {
    if (!c.ok()) throw new Error(`table identity check failed: ${c.name}`);
  }
}
