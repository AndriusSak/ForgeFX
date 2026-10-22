// Diff a family's shipped type list against the fw-13 editor cache, showing the first divergences.
import { readFileSync } from 'node:fs';
import { buildCache } from 'forgefx-midi/cache';
import { FM3_ENUM_OVERRIDES, FM3_ROSTERS } from 'forgefx-midi/gen3/fm3';
import { catalogForModel } from '../src/services/deviceCache.js';

const [path, ...fams] = process.argv.slice(2);
const built = await buildCache(
  { kind: 'bytes', buf: new Uint8Array(readFileSync(path!)) },
  catalogForModel(0x11).params,
  catalogForModel(0x11).seeds,
  { model: 0x11, firmware: '13.0', builtAt: new Date().toISOString() }
);
const shippedEnum = FM3_ENUM_OVERRIDES as unknown as Record<string, Record<string, string[]>>;
const staticRosters = FM3_ROSTERS as unknown as Record<string, { value: number; name: string }[]>;

for (const fam of fams) {
  const pid = fam === 'CHORUS' ? 0 : fam === 'DISTORT' ? 6 : fam === 'FUZZ' ? 0 : 0;
  const a = shippedEnum[fam]?.[String(pid)] ?? staticRosters[fam.toLowerCase()]?.map((r) => r.name) ?? [];
  const b = built.enumOverrides?.[fam]?.[String(pid)] ?? [];
  console.log(`\n## ${fam} shipped=${a.length} fw13=${b.length}`);
  let shown = 0;
  for (let i = 0; i < Math.max(a.length, b.length) && shown < 12; i++) {
    if (a[i] !== b[i]) {
      console.log(`  idx ${i}: shipped=${JSON.stringify(a[i])} fw13=${JSON.stringify(b[i])}`);
      shown++;
    }
  }
  if (!shown) console.log('  identical');
  console.log(`  tail shipped: ${a.slice(-3).join(' | ')}`);
  console.log(`  tail fw13  : ${b.slice(-3).join(' | ')}`);
}
