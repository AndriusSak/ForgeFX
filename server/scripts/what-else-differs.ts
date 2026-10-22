// What else does the fw-13 editor cache change, beyond the type selectors we now ship?
import { readFileSync } from 'node:fs';
import { buildCache } from 'forgefx-midi/cache';
import { FM3_ENUM_OVERRIDES, FM3_CAB_IRS, FM3_PARAMS_BY_FAMILY } from 'forgefx-midi/gen3/fm3';
import { catalogForModel } from '../src/services/deviceCache.js';

const built = await buildCache(
  { kind: 'bytes', buf: new Uint8Array(readFileSync(process.argv[2]!)) },
  catalogForModel(0x11).params,
  catalogForModel(0x11).seeds,
  { model: 0x11, firmware: '13.0', builtAt: new Date().toISOString() }
);
const shipped = FM3_ENUM_OVERRIDES as unknown as Record<string, Record<string, string[]>>;
const params = FM3_PARAMS_BY_FAMILY as unknown as Record<string, { paramId: number; name: string }[]>;

const diffs: string[] = [];
let newRows = 0, changed = 0, same = 0;
for (const [fam, pids] of Object.entries(built.enumOverrides ?? {})) {
  for (const [pid, labels] of Object.entries(pids as Record<string, string[]>)) {
    const old = shipped[fam]?.[pid];
    if (!old) { newRows++; diffs.push(`NEW   ${fam}/${pid} ${params[fam]?.find((p) => p.paramId === Number(pid))?.name ?? '?'} n=${labels.length}`); continue; }
    if (old.length === labels.length && old.every((l, i) => l === labels[i])) { same++; continue; }
    changed++;
    const name = params[fam]?.find((p) => p.paramId === Number(pid))?.name ?? '?';
    diffs.push(`DIFF  ${fam}/${pid} ${name} ${old.length} -> ${labels.length}`);
  }
}
console.log(`enum rows: same=${same} changed=${changed} new=${newRows}`);
console.log(diffs.slice(0, 40).join('\n'));
const cab = built.cabIrs ?? {};
console.log('cabIrs families:', Object.keys(cab).length, Object.keys(cab).map((k) => `${k}:${cab[k]!.length}`).join(' '),
  '| shipped:', Object.keys(FM3_CAB_IRS).length);
console.log('ranges families:', Object.keys(built.ranges ?? {}).length, '| rosters:', Object.keys(built.rosters ?? {}).join(','));
