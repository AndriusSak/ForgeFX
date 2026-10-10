// ────────────────────────────────────────────────────────────────────────────────
// diff-switch-capture — compare two real captures of the same preset and report EVERY moved byte in
// marker-relative terms (§3.8). This is the tool for "one edit + one dump": run it after an edit and it
// says where the change landed, so a new anchor (and any surprise) is read off the bytes.
//
//   npx tsx scripts/diff-switch-capture.ts --baseline <a.bin> --new <b.bin>
//
// It deliberately does NOT decide which byte is "the" target: it prints every difference against the
// marker plus a labelled offset table, because the interesting result is often a byte that moved where
// the model said it shouldn't.
// ────────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parsePresetDump, decodeRawPatch, findPerPresetSwitchBlock, PP_MEASURED_OFFSETS, ppTargetLabel } from 'forgefx-midi/devices/gen3';

function load(p: string): Uint8Array {
  const bytes = new Uint8Array(readFileSync(p));
  const { body } = decodeRawPatch(parsePresetDump(bytes, 0, 0x11).chunkPayloads);
  return body;
}

/** Names for the offsets the model currently reads — read from the CODEC's table, so this label cannot
 *  outlive the model (it used to hard-code a flat one-per-switch target array, refuted 2026-10-09). */
function labelFor(rel: number): string {
  for (const [i, off] of Object.entries(PP_MEASURED_OFFSETS)) {
    if (rel === off.actionCode) return `PP#${i} action code (u16 low, MEASURED)`;
    if (rel === off.actionCode + 1) return `PP#${i} action code (u16 high)`;
    if (off.target !== undefined && rel === off.target) return `PP#${i} target byte (MEASURED)`;
  }
  return '(not one of the offsets the model reads)';
}

export async function main(argv: string[]): Promise<number> {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const aPath = arg('--baseline');
  const bPath = arg('--new');
  if (!aPath || !bPath) { console.log('usage: npx tsx scripts/diff-switch-capture.ts --baseline A.bin --new B.bin'); return 2; }

  const a = load(aPath);
  const b = load(bPath);
  if (a.length !== b.length) console.log(`!! body lengths differ (${a.length} vs ${b.length}) — diff is not meaningful past the shorter`);
  const at = findPerPresetSwitchBlock(b) ?? findPerPresetSwitchBlock(a);
  if (at === undefined) { console.log('no switch marker in either capture'); return 1; }
  console.log(`marker at ${at} · comparing "${aPath}" → "${bPath}"`);

  const diff: number[] = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) diff.push(i);

  console.log(`\n${diff.length} differing byte(s):`);
  for (const o of diff) {
    const rel = o - at;
    const relTxt = rel >= 0 ? `marker+${rel}` : `marker${rel}`;
    const val = b[o] ?? 0;
    const named = ppTargetLabel(val);
    const asTarget = val > 0 ? `  [as a target value: ${val}${named ? ` = ${named}` : ' (unlabelled index)'}]` : '';
    console.log(`  @${o} (${relTxt}) : ${a[o]} → ${b[o]}   ${labelFor(rel)}${asTarget}`);
  }

  // The block AS THE CODEC READS IT: one row per index with an OBSERVED offset, from the table. This used to
  // print four rows off `PP_TARGET_OFFSET + i` — the flat one-per-switch array that was refuted — so it showed
  // models of bytes the write path never touches.
  console.log('\nswitch block now (codec table):');
  for (const i of Object.keys(PP_MEASURED_OFFSETS).map(Number).sort((x, y) => x - y)) {
    const off = PP_MEASURED_OFFSETS[i]!;
    const code = (b[at + off.actionCode] ?? 0) | ((b[at + off.actionCode + 1] ?? 0) << 8);
    const tgt = off.target === undefined ? null : (b[at + off.target] ?? 0);
    const named = tgt === null ? null : ppTargetLabel(tgt);
    console.log(`  PP#${i}: action 0x${code.toString(16).padStart(2, '0')} · ` +
      (tgt === null ? 'target byte NOT located' : `marker+${off.target} = ${tgt}${named ? ` (${named})` : ''}`));
  }
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
