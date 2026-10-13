// ────────────────────────────────────────────────────────────────────────────────
// analyze-raw-value-candidates — READ-ONLY, offline: which OTHER rows of the SHIPPED FM3 table share the
// SHAPE of the four measured raw-is-value rows (`valueMap: 'identity'` in forgefx-midi's rangeOverlay.ts)?
//
// A SHAPE GUESS IS NOT A MEASUREMENT. This lists candidates for hardware measurement; it flips nothing.
//
// Signature, read off the four measured rows (Tempo 24..250 tc 0xb20, Stages 2..32 tc 0x10, Bank Size 1..12
// tc 0x10, TONETYPE 0..3 tc 0x10). Every one is a FLOAT row, scale 1, with integral bounds whose DEFAULT
// (`defaultRaw`, stored as the normalised u16) decodes to an INTEGER in range (27837→119.99, 13107→8,
// 11915→3, 21845→1) — but that alone matches ~330 rows (every Hz/dB row with a round default), so it is only
// the BASE gate. Two structural tiers sit on top of it:
//   TIER A  typecode 0x10 on a float-kind row — 0x10 is the ENUM/ordinal typecode (every enum row carries it);
//           a float row wearing it is an integer-valued selector-like field. 3 of the 4 measured rows.
//   TIER B  typecode low byte exactly 0x20 (Tempo is 0xb20; the unit/taper nibble 4 of the 0x24x frequency
//           rows is what made a looser 'low nibble 0' tier match nothing but counter-examples).
// Rows matching only the base gate are NOT listed as candidates.
//
// FALSE-POSITIVE CONTROL: the sweep (`review-2026-10-13/probe-bounds-violations.json`) read the unit's own
// display for 897 rows. A tier row the unit CONFIRMED as a normal mapping (klass 'match') is a counter-example
// — unless the reading was taken at norm < 0.01, where identity and normalised AGREE (raw 0 → 0 either way),
// so that 'match' is VACUOUS and reported separately, never as evidence against.
//
// USAGE  npx tsx scripts/analyze-raw-value-candidates.ts [--sweep <path.json>] [--json]
// ────────────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { FM3_RANGES, FM3_EFFECT_ID_TABLE, FM3_PARAMS } from 'forgefx-midi/gen3/fm3';

interface Row { family: string; pid: number; name: string; min: number; max: number; typecode: number; step: number; def: number | null; defValue: number | null; measured: boolean }

const argv = process.argv.slice(2);
const sweepPath = resolve(argv.includes('--sweep') ? argv[argv.indexOf('--sweep') + 1]! : '../../review-2026-10-13/probe-bounds-violations.json');
const names = new Map<string, string>();
for (const p of FM3_PARAMS as ReadonlyArray<{ family: string; paramId: number; name: string }>) names.set(`${p.family}/${p.paramId}`, p.name);

const isInt = (x: number): boolean => Number.isFinite(x) && Math.abs(x - Math.round(x)) < 1e-9;
const rows: Row[] = [];
for (const [family, fr] of Object.entries(FM3_RANGES)) {
  for (const [pidS, r] of Object.entries(fr)) {
    if (r.kind !== 'float') continue;
    const defValue = r.defaultRaw != null ? r.displayMin + (r.defaultRaw / 65534) * (r.displayMax - r.displayMin) : null;
    rows.push({ family, pid: Number(pidS), name: names.get(`${family}/${pidS}`) ?? '?', min: r.displayMin, max: r.displayMax, typecode: r.typecode, step: r.step, def: r.defaultRaw ?? null, defValue, measured: (r as { valueMap?: string }).valueMap === 'identity' });
  }
}
const shape = (r: Row): boolean => {
  const range = FM3_RANGES[r.family]![r.pid]!;
  return range.scale === 1 && r.max > r.min && isInt(r.min) && isInt(r.max) && r.defValue !== null
    && Math.abs(r.defValue - Math.round(r.defValue)) < 0.02 * Math.max(1, (r.max - r.min) / 30);
};
const tierOf = (r: Row): 'A' | 'B' | null => {
  if (!shape(r)) return null;
  if (r.typecode === 0x10) return 'A';
  if ((r.typecode & 0xff) === 0x20) return 'B';
  return null;
};
const measured = rows.filter((r) => r.measured);
const base = rows.filter(shape);
const sig = rows.filter((r) => tierOf(r) !== null);

// Sweep join: (eid → family via the effect table, pid) → klass.
const klass = new Map<string, string>();
const sweepNorm = new Map<string, number>();
if (existsSync(sweepPath)) {
  const sweep = JSON.parse(readFileSync(sweepPath, 'utf8')) as { rows: Array<{ eid: number; pid: number; klass: string; norm: number }> };
  for (const s of sweep.rows) {
    const e = FM3_EFFECT_ID_TABLE.find((x) => x.firstId != null && s.eid >= x.firstId && s.eid < x.firstId + Math.max(1, x.instances));
    if (e) { klass.set(`${e.family}/${s.pid}`, s.klass); sweepNorm.set(`${e.family}/${s.pid}`, s.norm); }
  }
}
const tag = (r: Row): string => (r.measured ? 'MEASURED' : (klass.get(`${r.family}/${r.pid}`) ?? 'not in sweep'));
const byTag = (t: (s: string) => boolean) => sig.filter((r) => !r.measured && t(tag(r)));
const vacuous = (r: Row) => (sweepNorm.get(`${r.family}/${r.pid}`) ?? 1) < 0.01;
const confirmedNormal = byTag((t) => t.startsWith('match')).filter((r) => !vacuous(r));
const vacuousMatch = byTag((t) => t.startsWith('match')).filter(vacuous);
const disagree = byTag((t) => t === 'SHAPE' || t === 'OUTSIDE-BOUNDS');
const unswept = byTag((t) => t === 'not in sweep' || t === 'UNREADABLE' || t === 'UNPARSED');

const fmt = (r: Row) => `[${tierOf(r) ?? '-'}] ${(r.family + '/' + r.pid).padEnd(24)} ${r.name.padEnd(34)} ${r.min}..${r.max}`.padEnd(72) + ` tc 0x${r.typecode.toString(16)} step ${r.step} default→${r.defValue === null ? '—' : r.defValue.toFixed(2)}  [${tag(r)}]`;
console.log(`float rows: ${rows.length}; base gate (integral bounds, scale 1, integer default): ${base.length}; tier A/B matches: ${sig.length} (measured identity among them: ${sig.filter((r) => r.measured).length}/${measured.length})`);
console.log(`\nMEASURED (valueMap identity) — do they ALL match the signature?  ${measured.every(shape)}`);
for (const r of measured) console.log('  ' + fmt(r));
console.log(`\nCONTRADICTED by the sweep (signature matches, unit disagrees with our served value, NOT already marked): ${disagree.length}`);
for (const r of disagree) console.log('  ' + fmt(r));
console.log(`\nCOUNTER-EXAMPLES (signature matches but the unit CONFIRMED the normalised mapping): ${confirmedNormal.length}`);
for (const r of confirmedNormal) console.log('  ' + fmt(r));
console.log(`\nVACUOUS 'match' (read at norm < 0.01 — identity and normalised agree there; NOT evidence either way): ${vacuousMatch.length}`);
for (const r of vacuousMatch) console.log('  ' + fmt(r));
console.log(`\nCANDIDATES TO MEASURE ON HARDWARE (signature matches, no unit display for the current preset): ${unswept.length}`);
for (const r of unswept) console.log('  ' + fmt(r));
console.log(`\ntier precision on swept rows: ${measured.length} measured identity vs ${confirmedNormal.length} informative counter-examples. A shape is NOT a measurement — read each candidate's display at a non-trivial raw before flipping.`);
