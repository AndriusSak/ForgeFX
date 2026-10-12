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
import { parsePresetDump, decodeRawPatch, findPerPresetSwitchBlock, PP_MEASURED_OFFSETS, PP_FUNCTION_INDEX_BASE, PP_HOLD_ACTION_BASE, PP_SWITCH_COUNT, ppTargetLabel, ppTargetIsFxSlot, ppActionName, ppFunctionName } from 'forgefx-midi/devices/gen3';

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
  if (rel >= PP_FUNCTION_INDEX_BASE && rel < PP_FUNCTION_INDEX_BASE + 2 * PP_SWITCH_COUNT) {
    return `slot ${Math.floor((rel - PP_FUNCTION_INDEX_BASE) / 2) + 1} of the FUNCTION-INDEX array (u16, stride 2)`;
  }
  if (rel >= PP_HOLD_ACTION_BASE && rel < PP_HOLD_ACTION_BASE + 2 * PP_SWITCH_COUNT) {
    return `slot ${Math.floor((rel - PP_HOLD_ACTION_BASE) / 2) + 1} of the HOLD action-code array (u16, stride 2)`;
  }
  return '(not one of the offsets the model reads)';
}

/**
 * The hint printed beside a moved byte. A name is attached ONLY where the codec's rule allows one, because a
 * target byte's MEANING depends on its row: the anchor table was measured with Effect: Bypass, so naming
 * "Delay 1" beside a HOLD code (both are 7) or "Amp 1" beside a Looper row's record+0 was an over-claim of the
 * same class the Axis panel was fixed for.
 */
function hintFor(rel: number, val: number, body: Uint8Array, at: number): string {
  if (val <= 0) return '';
  for (const [i, off] of Object.entries(PP_MEASURED_OFFSETS)) {
    if (off.target !== rel) continue;
    const n = Number(i);
    const code = (body[at + off.actionCode] ?? 0) | ((body[at + off.actionCode + 1] ?? 0) << 8);
    const fi = (body[at + PP_FUNCTION_INDEX_BASE + 2 * (n - 1)] ?? 0) |
      ((body[at + PP_FUNCTION_INDEX_BASE + 2 * (n - 1) + 1] ?? 0) << 8);
    return ppTargetIsFxSlot(code, fi)
      ? `  [as an FX-slot value: ${val} = ${ppTargetLabel(val) ?? '(unlabelled)'}]`
      : `  [as a target value: ${val} — PP#${n} stores no FX slot (${ppActionName(code) ?? 'unknown category'}), so no anchor name applies]`;
  }
  if (rel >= PP_HOLD_ACTION_BASE && rel < PP_HOLD_ACTION_BASE + 2 * PP_SWITCH_COUNT) {
    return `  [as a HOLD action code: ${val} = ${ppActionName(val) ?? '(unmapped)'}]`;
  }
  if (rel >= PP_FUNCTION_INDEX_BASE && rel < PP_FUNCTION_INDEX_BASE + 2 * PP_SWITCH_COUNT) {
    return `  [as a function index: ${val} — the NAME depends on that row's category]`;
  }
  return `  [value ${val}]`;
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
    console.log(`  @${o} (${relTxt}) : ${a[o]} → ${b[o]}   ${labelFor(rel)}${hintFor(rel, val, b, at)}`);
  }

  // The block AS THE CODEC READS IT: one row per index with an OBSERVED offset, from the table. This used to
  // print four rows off `PP_TARGET_OFFSET + i` — the flat one-per-switch array that was refuted — so it showed
  // models of bytes the write path never touches.
  console.log('\nswitch block now (codec table):');
  for (const i of Object.keys(PP_MEASURED_OFFSETS).map(Number).sort((x, y) => x - y)) {
    const off = PP_MEASURED_OFFSETS[i]!;
    const code = (b[at + off.actionCode] ?? 0) | ((b[at + off.actionCode + 1] ?? 0) << 8);
    const tgt = off.target === undefined ? null : (b[at + off.target] ?? 0);
    const fi = (b[at + PP_FUNCTION_INDEX_BASE + 2 * (i - 1)] ?? 0) |
      ((b[at + PP_FUNCTION_INDEX_BASE + 2 * (i - 1) + 1] ?? 0) << 8);
    // Same rule as the diff lines above: the anchor name appears only where the codec says the byte IS an
    // FX slot, and the row's own function is printed beside it so the reading can be checked at a glance.
    const named = tgt === null || !ppTargetIsFxSlot(code, fi) ? null : ppTargetLabel(tgt);
    const fn = ppFunctionName(code, fi);
    console.log(`  PP#${i}: action 0x${code.toString(16).padStart(2, '0')}` +
      `${fn ? ` (${fn})` : ''} · ` +
      (tgt === null
        ? 'target byte NOT located'
        : `marker+${off.target} = ${tgt}${named ? ` (${named})` : ' (no FX-slot name — this category stores something else)'}`));
  }
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
