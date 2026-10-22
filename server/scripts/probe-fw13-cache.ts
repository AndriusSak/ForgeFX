// Throwaway probe: build a BuiltCache from the editor's effectDefinitions cache and diff the type
// selectors it reports against the shipped FM3 enum tables.
import { readFileSync } from 'node:fs';
import { buildCache } from 'forgefx-midi/cache';
import { catalogForModel } from '../src/services/deviceCache.js';
import { PROFILES, SLUG_FAMILY } from '../src/devices.js';
import { FM3_ENUM_OVERRIDES } from 'forgefx-midi/gen3/fm3';

const path = process.argv[2]!;
const bytes = new Uint8Array(readFileSync(path));
const catalog = catalogForModel(0x11);
const built = await buildCache({ kind: 'bytes', buf: bytes }, catalog.params, catalog.seeds, {
  model: 0x11, firmware: '13.0', builtAt: new Date().toISOString()
});
console.log('records', built.meta?.recordCount, '| families with enums', Object.keys(built.enumOverrides ?? {}).length,
  '| rosters', Object.keys(built.rosters ?? {}).length);

const shipped = FM3_ENUM_OVERRIDES as unknown as Record<string, Record<string, string[]>>;
const prof = PROFILES[0x11]!;
const params = prof.params;
const SUF = ['MODEL', 'PRESETS', 'TYPE', 'BASETYPE'];
const pick = (fam: string, labelsFor: (f: string, p: number) => string[] | undefined) => {
  let best: { pid: number; labels: string[] } | null = null;
  for (const s of SUF) {
    const d = (params[fam] ?? []).find((p) => p.name === `${fam}_${s}`);
    if (!d) continue;
    const l = labelsFor(fam, d.paramId);
    if (!l || l.length <= 1) continue;
    if (!best || l.length > best.labels.length) best = { pid: d.paramId, labels: l };
  }
  return best;
};

const cacheLabels = (f: string, p: number) => built.enumOverrides?.[f]?.[String(p)];
const shipLabels = (f: string, p: number) => shipped[f]?.[String(p)];
const rows: string[] = [];
for (const slug of Object.keys(SLUG_FAMILY)) {
  const fam = SLUG_FAMILY[slug]!;
  if (rows.some((r) => r.startsWith(fam + ' '))) continue;
  const a = pick(fam, shipLabels);
  const b = pick(fam, cacheLabels);
  if (!a && !b) continue;
  const an = a?.labels.length ?? 0;
  const bn = b?.labels.length ?? 0;
  const flag = bn > an ? 'GROWS' : bn < an ? 'shrinks' : 'same';
  rows.push(`${fam} shipped=${an}@${a?.paramId ?? '-'} fw13=${bn}@${b?.paramId ?? '-'} ${flag}`);
}
console.log(rows.sort().join('\n'));

// full PLEX / CHORUS lists from the cache for eyeballing
for (const fam of ['CHORUS', 'DELAY', 'FLANGER', 'PITCH', 'PLEX', 'MULTITAP']) {
  const b = pick(fam, cacheLabels);
  if (b) console.log(`\n[fw13] ${fam}@${b.paramId} n=${b.labels.length}: ${b.labels.slice(0, 6).join(' | ')} ... ${b.labels.slice(-3).join(' | ')}`);
}
