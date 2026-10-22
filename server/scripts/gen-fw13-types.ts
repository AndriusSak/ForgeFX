// Regenerate the FM3 table overlays from the OFFICIAL EDITOR's effectDefinitions_*.cache (fw 13.0).
//
// The shipped FM3 tables were harvested from the 12.0 editor config, so anything that grew since then is
// short: type lists (chorus 18 vs 27, amps 331 vs 336, drive 86 vs 87) and the sub-type enums those
// blocks gate their pages on (distortion tube type, drive P/N diode types). This reads the 13.0 cache
// through the same codec path the runtime import uses and emits ONLY what differs.
//
// Two tables, because they are consumed differently:
//   FM3_TYPE_TABLES_FW13 — family -> { paramId, labels } for the block's TYPE selector (drives rosters).
//   FM3_ENUM_ROWS_FW13   — family -> pid -> labels for every OTHER enum row that changed, so the block
//                          pages' dropdowns match the firmware (tube/diode/… sub-types).
// PRESET/GLOBAL rows are deliberately excluded: they are control-switch/FC plumbing, not block tables,
// and pulling them in would widen the change past what has been reviewed.
//
// Usage: npx tsx scripts/gen-fw13-types.ts <path-to-effectDefinitions_11_13p0.cache>
import { readFileSync, writeFileSync } from 'node:fs';
import { buildCache } from 'forgefx-midi/cache';
import { FM3_ENUM_OVERRIDES, FM3_PARAMS_BY_FAMILY } from 'forgefx-midi/gen3/fm3';
import { catalogForModel } from '../src/services/deviceCache.js';

const path = process.argv[2];
if (!path) throw new Error('usage: gen-fw13-types.ts <cache file>');
const out = process.argv[3] ?? '../forgefx-midi/src/gen3/fm3/typeTables.fw13.generated.ts';

const ISO = process.argv[4] ?? '2026-10-22';
const built = await buildCache(
  { kind: 'bytes', buf: new Uint8Array(readFileSync(path)) },
  catalogForModel(0x11).params,
  catalogForModel(0x11).seeds,
  { model: 0x11, firmware: '13.0', builtAt: new Date().toISOString() }
);

const shipped = FM3_ENUM_OVERRIDES as unknown as Record<string, Record<string, string[]>>;
const params = FM3_PARAMS_BY_FAMILY as unknown as Record<string, { paramId: number; name: string }[]>;
const SUFFIXES = ['MODEL', 'PRESETS', 'TYPE', 'BASETYPE'] as const;
const EXCLUDED = new Set(['PRESET', 'GLOBAL']);

const pick = (fam: string, labelsFor: (f: string, p: number) => string[] | undefined) => {
  let best: { paramId: number; labels: string[] } | null = null;
  for (const s of SUFFIXES) {
    const def = (params[fam] ?? []).find((p) => p.name === `${fam}_${s}`);
    if (!def) continue;
    const labels = labelsFor(fam, def.paramId);
    if (!labels || labels.length <= 1) continue;
    if (!best || labels.length > best.labels.length) best = { paramId: def.paramId, labels };
  }
  return best;
};

const typeTables: Record<string, { paramId: number; labels: string[] }> = {};
const enumRows: Record<string, Record<string, string[]>> = {};
const report: string[] = [];

// Walk EVERY family's enum rows first — not just families that have a TYPE selector. Formant and
// multiplexer are "typeless" blocks whose page is built from per-parameter enums (vowel F1..F3, input
// select/mode); the earlier type-selector-first loop skipped them entirely, so their dropdowns stayed
// bare ordinals while their sibling blocks got fixed.
for (const fam of Object.keys(built.enumOverrides ?? {})) {
  if (EXCLUDED.has(fam)) continue;
  const b = pick(fam, (f, p) => built.enumOverrides?.[f]?.[String(p)]);
  const typePid = b?.paramId ?? -1;
  if (b) {
    const a = pick(fam, (f, p) => shipped[f]?.[String(p)]);
    const an = a?.labels.length ?? 0;
    if (!(b.labels.length === an && a && a.labels.every((l, i) => l === b.labels[i]))) {
      // If the old list is not a prefix the ORDINALS moved, i.e. existing decodes shift — say so.
      const prefix = a ? a.labels.every((l, i) => b.labels[i] === l) : true;
      report.push(`TYPE ${fam}: ${an} -> ${b.labels.length} @pid ${b.paramId}${prefix ? '' : '  (renamed/reordered)'}`);
      typeTables[fam] = b;
    }
  }
  for (const [pid, labels] of Object.entries((built.enumOverrides?.[fam] ?? {}) as Record<string, string[]>)) {
    if (Number(pid) === typePid) continue;
    const old = shipped[fam]?.[pid];
    if (old && old.length === labels.length && old.every((l, i) => l === labels[i])) continue;
    const name = (params[fam] ?? []).find((p) => p.paramId === Number(pid))?.name ?? '?';
    report.push(`ROW  ${fam}/${pid} ${name}: ${old?.length ?? 0} -> ${labels.length}`);
    (enumRows[fam] ??= {})[pid] = labels;
  }
}

const typeBody = Object.entries(typeTables)
  .map(([fam, t]) => `  ${fam}: {\n    paramId: ${t.paramId},\n    labels: [\n${t.labels.map((l) => `      ${JSON.stringify(l)}`).join(',\n')}\n    ]\n  }`)
  .join(',\n');
const rowBody = Object.entries(enumRows)
  .map(
    ([fam, pids]) =>
      `  ${fam}: {\n${Object.entries(pids)
        .map(([pid, labels]) => `    ${JSON.stringify(pid)}: [\n${labels.map((l) => `      ${JSON.stringify(l)}`).join(',\n')}\n    ]`)
        .join(',\n')}\n  }`
  )
  .join(',\n');

const file = `// GENERATED — FM3 tables from the official editor's effectDefinitions_11_13p0.cache
// (fw 13.0, harvested ${ISO}). DO NOT EDIT BY HAND; regenerate with
// ForgeFX/server/scripts/gen-fw13-types.ts <cache>.
//
// FM3_TYPE_TABLES_FW13 — the block type selectors whose list differs from the 12.0-era tables. The label
// index IS the device ordinal; \`fm3RosterFor\` prefers these over the baked roster when it is not shorter.
// FM3_ENUM_ROWS_FW13 — every other enum row that differs (tube/diode sub-types etc.), merged into the
// family enum table so block pages offer the firmware's own options.
// PRESET/GLOBAL rows are excluded on purpose (FC/control-switch plumbing, not block tables).
/* eslint-disable */

export interface Fm3TypeTable {
  paramId: number;
  labels: readonly string[];
}

export const FM3_TYPE_TABLES_FW13: Readonly<Record<string, Fm3TypeTable>> = {
${typeBody}
};

export const FM3_ENUM_ROWS_FW13: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
${rowBody}
};
`;
writeFileSync(out, file);
console.log(`wrote ${out}\n` + report.join('\n'));
