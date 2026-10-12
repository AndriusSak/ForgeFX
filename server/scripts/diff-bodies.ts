// diff-bodies — OFFLINE (no device). Pairwise diff of preset BODIES, every offset labelled with the
// switch-block array it belongs to. Reads a .hex body (no spaces) or a raw dump .bin (fn 0x77/0x78/0x79
// frames) and decodes the latter. Built to attribute the ROUND 15 → ROUND 16 body drift byte by byte, after
// a claim about that drift turned out to be wrong in an earlier draft.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parsePresetDump, decodeRawPatch } from 'forgefx-midi/devices/gen3';

const load = (p: string): number[] => {
  const raw = readFileSync(p);
  const isHex = /\.hex$/i.test(p);
  if (isHex) {
    const t = raw.toString('utf8').trim();
    if (/\s/.test(t)) return t.split(/\s+/).filter(Boolean).map((x) => parseInt(x, 16));
    const out: number[] = [];
    for (let i = 0; i + 1 < t.length; i += 2) out.push(parseInt(t.slice(i, i + 2), 16));
    return out;
  }
  const parsed = parsePresetDump(Uint8Array.from(raw), 0, 0x11);
  return Array.from(decodeRawPatch(parsed.chunkPayloads).body);
};

const sha = (b: number[]) => createHash('sha256').update(Buffer.from(b)).digest('hex').slice(0, 16);
const marker = (b: number[]): number => {
  for (let i = 0; i + 4 < b.length; i++) if (b[i] === 0xf5 && b[i + 1] === 0x05 && b[i + 2] === 0x01 && b[i + 3] === 0x00) return i;
  return -1;
};
/** The switch-block arrays, derived: actionCode @+4+2(i-1), functionIndex @+52+2(i-1), record+0 @+148+12(i-1). */
const label = (rel: number): string => {
  if (rel >= 4 && rel < 52) return `ACTION-CODE PP#${1 + Math.floor((rel - 4) / 2)}`;
  if (rel >= 52 && rel < 100) return `FUNCTION-INDEX PP#${1 + Math.floor((rel - 52) / 2)}`;
  if (rel >= 148 && rel < 148 + 288) {
    const r = rel - 148; const i = 1 + Math.floor(r / 12); const f = r % 12;
    return `RECORD PP#${i} +${f}${f === 0 ? ' (record+0/target)' : ` (field ${Math.floor(f / 2)})`}`;
  }
  return rel >= 100 && rel < 148 ? `switch-block GAP +${rel}` : `outside the switch block (${rel >= 0 ? '+' : ''}${rel})`;
};

const files = process.argv.slice(2);
const bodies = files.map((f) => ({ f, b: load(f) }));
for (const { f, b } of bodies) console.log(`${f}\n   ${b.length} B  sha ${sha(b)}  marker ${marker(b)}`);
console.log();
for (let i = 0; i < bodies.length; i++) {
  for (let j = i + 1; j < bodies.length; j++) {
    const A = bodies[i]!, B = bodies[j]!;
    const at: number[] = [];
    for (let k = 0; k < Math.min(A.b.length, B.b.length); k++) if (A.b[k] !== B.b[k]) at.push(k);
    console.log(`── ${A.f}  vs  ${B.f}: ${at.length} differing byte(s)`);
    const m = marker(B.b);
    for (const k of at) {
      const v = (x: number) => (x.toString(16).padStart(2, '0'));
      console.log(`   body ${k} (marker${k - m >= 0 ? '+' : ''}${k - m}): ${v(A.b[k]!)} -> ${v(B.b[k]!)}   [${label(k - m)}]`);
    }
    console.log();
  }
}
