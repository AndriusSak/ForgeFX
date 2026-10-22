// What are the 63 NEW PRESET/* enum rows in the fw-13 editor cache, and are they used anywhere?
import { readFileSync } from 'node:fs';
import { buildCache } from 'forgefx-midi/cache';
import { FM3_ENUM_OVERRIDES, FM3_PARAMS_BY_FAMILY } from 'forgefx-midi/gen3/fm3';
import { catalogForModel } from '../src/services/deviceCache.js';

const built = await buildCache(
  { kind: 'bytes', buf: new Uint8Array(readFileSync(process.argv[2]!)) },
  catalogForModel(0x11).params,
  catalogForModel(0x11).seeds,
  { model: 0x11, firmware: '13.0', builtAt: new Date().toISOString() }
);
const shipped = (FM3_ENUM_OVERRIDES as unknown as Record<string, Record<string, string[]>>).PRESET ?? {};
const rows = (built.enumOverrides?.PRESET ?? {}) as Record<string, string[]>;
const params = (FM3_PARAMS_BY_FAMILY as unknown as Record<string, { paramId: number; name: string }[]>).PRESET ?? [];
const byPid = new Map(params.map((p) => [p.paramId, p.name]));

let newRows = 0, changed = 0;
for (const [pid, labels] of Object.entries(rows)) {
  const old = shipped[pid];
  if (old && old.length === labels.length && old.every((l, i) => l === labels[i])) continue;
  if (old) changed++; else newRows++;
  if (newRows + changed <= 8) console.log(`${old ? 'CHG' : 'NEW'} ${pid} ${byPid.get(Number(pid)) ?? '(no catalog row)'} n=${labels.length}: ${labels.join(' | ')}`);
}
console.log(`\nPRESET family in cache: ${Object.keys(rows).length} enum rows (${newRows} new, ${changed} changed); shipped table has ${Object.keys(shipped).length}`);
console.log('catalog PRESET params:', params.length, '| with pid>=1285:', params.filter((p) => p.paramId >= 1285).length);
const names = params.filter((p) => /_MODE$/.test(p.name)).map((p) => p.name);
console.log('catalog *_MODE params:', names.length, names.slice(0, 6).join(', '));
