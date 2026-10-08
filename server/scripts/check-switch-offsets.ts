// ────────────────────────────────────────────────────────────────────────────────────────────────
// check-switch-offsets — the §3.8 offset model, checked against TWO REAL DUMPS of the same preset.
//
// WHY A DIFFERENTIAL: the decompressed body of preset 410 was captured twice — once with no per-preset
// switch configured, once with PP#1 (Effect: Bypass → Filter 4) and PP#2 (Scene: Select) configured. The
// model PREDICTS which bytes move. A difference anywhere else, or a predicted byte that does not move,
// refutes it — which is the only reason a fitted model is worth anything here.
//
// WHAT IT CONFIRMED (2026-10-08): @marker+4 = PP#1's action code, @marker+6 = PP#2's action code (so the
// codes are a contiguous u16 array), @marker+148 = PP#1's target byte, value 20 = "Filter 4" — matching the
// anchor measured independently on the wire. It also shows the two captures differ in the PERFORM PAGE
// (@10746 etc., a label he edited in between), which is why the extras below are classified rather than
// treated as failures: a differential between two captures taken hours apart is not a controlled experiment.
//
// READ-ONLY, offline. Run: npx tsx scripts/check-switch-offsets.ts
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parsePresetDump, decodeRawPatch, findPerPresetSwitchBlock, PP_ACTION_OFFSET, PP_TARGET_OFFSET } from 'forgefx-midi/devices/gen3';

/** Offsets in the older capture that belong to the PERFORM PAGE, not the switch block (labels he edited
 *  between the captures: 'GEQ' → blank). Listed explicitly so an unexplained extra still fails the check. */
const KNOWN_PERFORM_PAGE_OFFSETS = new Set([10746, 10748, 10750]);

export async function main(): Promise<number> {
  const load = (rel: string): Uint8Array => {
    const url = new URL(rel, import.meta.url);
    const { body } = decodeRawPatch(parsePresetDump(new Uint8Array(readFileSync(url)), 0, 0x11).chunkPayloads);
    return body;
  };
  const a = load('../test/fixtures/preset-perform/preset-410.bin');      // no switch configured
  const b = load('../test/fixtures/preset-switches/preset-410-pp1.bin'); // PP#1 + PP#2 configured

  if (a.length !== b.length) {
    console.log(`FAIL: the bodies differ in length (${a.length} vs ${b.length}) — the diff is not meaningful`);
    return 1;
  }
  const diff: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i);

  const at = findPerPresetSwitchBlock(b);
  if (at === undefined) { console.log('FAIL: no switch block marker in the populated fixture'); return 1; }

  // The model, stated as predictions BEFORE looking at the diff.
  const predicted: Array<{ offset: number; want: number; what: string }> = [
    { offset: at + PP_ACTION_OFFSET, want: 0x04, what: 'PP#1 action code low byte (Effect: Bypass)' },
    { offset: at + PP_ACTION_OFFSET + 2, want: 0x03, what: 'PP#2 action code low byte (Scene: Select)' },
    { offset: at + PP_TARGET_OFFSET, want: 20, what: 'PP#1 target byte (Filter 4)' }
  ];

  let bad = 0;
  console.log(`marker at ${at} in both bodies · ${diff.length} differing byte(s)\n`);
  console.log('PREDICTIONS');
  for (const p of predicted) {
    const moved = diff.includes(p.offset);
    const got = b[p.offset];
    const ok = moved && got === p.want;
    if (!ok) bad++;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} @${p.offset} (marker+${p.offset - at}) = ${got}, expected ${p.want} — ${p.what}`);
  }

  const unexplained = diff.filter((o) => !predicted.some((p) => p.offset === o) && !KNOWN_PERFORM_PAGE_OFFSETS.has(o));
  console.log(`\nextras: ${diff.filter((o) => KNOWN_PERFORM_PAGE_OFFSETS.has(o)).length} known perform-page byte(s), ${unexplained.length} UNEXPLAINED`);
  for (const o of unexplained) console.log(`  ${a[o]} → ${b[o]} @${o} (marker+${o - at})`);

  console.log(`\n${bad === 0 && unexplained.length === 0 ? 'MODEL HOLDS' : 'MODEL NOT CONFIRMED'}`);
  return bad === 0 && unexplained.length === 0 ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then((c) => process.exit(c));
