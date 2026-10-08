// ────────────────────────────────────────────────────────────────────────────────────────────────
// find-perform-page — locate the PER-PRESET PERFORMANCE PAGE in a dumped preset (§2.2).
//
// MEASURED LAYOUT (fixture pair: factory 406 vs the owner's copy 409 with four controls dragged in):
//   • 10 × uint16 LE — the slot table of EFFECT ids (Amp1 58, Delay1 70, Reverb1 66 …), 0 = unassigned;
//   • immediately followed by 10 × uint16 LE — the PARAM ids for those slots, in the same order;
//   • then per-slot label records (~32 B stride) holding 16-bit-character strings: a block/effect label
//     ("AMP1", "DLY1", "REV1") and a parameter label ("Gain", "Mix", "Fat") plus min/max text ("Off / On").
// Verified against the profile: the owner's four controls decode to eid 58/70/66/66 with pids 7/0/13/22,
// and DELAY_MIX=0, REVERB_MIX=13, REVERB_BYPASS=22 are exactly the profile's ids for those params.
// The tables are FIXED SIZE (10+10 uint16 = 40 B), which is what makes a length-preserving WRITE possible.
//
// STATUS — NOT TRUSTWORTHY YET, and it says so on every run. MEASURED PROBLEM: the scan returns the
// GRID/BLOCK table at body offset 258 in BOTH fixtures as its first candidate, because "10 small u16 then
// 10 small u16" also describes that table perfectly, and requiring nearby text did not exclude it. The
// page's true tables are at ~10698, found by hand and verified against the profile. DO NOT TRUST A CANDIDATE
// FROM THIS SCRIPT WITHOUT CHECKING THE EIDS AGAINST WHAT THE PRESET ACTUALLY HOLDS.
// The better anchor is the reverse direction: find the ~300-byte run of 16-bit-character label text first
// (that shape is rare), then read the tables that precede it.
//
// USAGE  npx tsx scripts/find-perform-page.ts <preset.bin> [...]
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parsePresetDump, decodeRawPatch, effectName } from 'forgefx-midi/devices/gen3';

const SLOTS = 10;
const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const txt16 = (b: Uint8Array, o: number, max = 16): string => {
  let s = '';
  for (let i = 0; i < max; i++) { const c = u16(b, o + i * 2); if (c === 0) break; s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '·'; }
  return s;
};

/** Find the page: 10 uint16 eids followed by 10 uint16 pids, all small, at least one non-zero. */
export function findPerformPage(body: Uint8Array): { at: number; eids: number[]; pids: number[] } | undefined {
  for (let at = 0; at + SLOTS * 4 <= body.length; at += 2) {
    const eids: number[] = []; const pids: number[] = [];
    for (let i = 0; i < SLOTS; i++) eids.push(u16(body, at + i * 2));
    for (let i = 0; i < SLOTS; i++) pids.push(u16(body, at + SLOTS * 2 + i * 2));
    const small = (v: number) => v === 0 || v < 0x1000;
    if (!eids.every(small) || !pids.every(small)) continue;
    if (!eids.some((v) => v !== 0)) continue;
    if (pids.filter((v) => v !== 0).length > SLOTS) continue;
    // REQUIRE LAID-OUT TEXT. Without this the scan returns a confident false positive: the grid/block
    // table (offset 258 in both fixtures) satisfies "10 small u16 then 10 small u16" perfectly. The page
    // carries 16-bit-character label strings just after its tables ("AMP1", "Gain", "Off / On"), so a
    // candidate must have at least two text runs of >=3 chars within 400 bytes — otherwise it is not the
    // page, and reporting it as one is worse than reporting nothing.
    let runs = 0;
    for (let o = at + SLOTS * 4; o < Math.min(body.length - 6, at + SLOTS * 4 + 400); o += 2) {
      if (txt16(body, o, 12).length >= 3 && u16(body, o + 2) !== 0) { runs++; o += 24; }
    }
    if (runs < 2) continue;
    return { at, eids, pids };
  }
  return undefined;
}

export function main(argv: string[]): number {
  const files = argv.filter((a) => !a.startsWith('--'));
  if (!files.length) { console.log('usage: npx tsx scripts/find-perform-page.ts <preset.bin> [...]'); return 2; }
  for (const f of files) {
    const p = f.replace('~', process.env.HOME ?? '');
    const b = (decodeRawPatch(parsePresetDump(new Uint8Array(readFileSync(p))).chunkPayloads) as unknown as { body: Uint8Array }).body;
    const page = findPerformPage(b);
    console.log(`\n${f}  (body ${b.length} B)`);
    if (!page) { console.log('  NO PERFORM PAGE FOUND by this heuristic (10+10 tables with label text after them).'); continue; }
    console.log(`  CANDIDATE (unverified — check the eids against the preset!) tables at body offset ${page.at}`);
    page.eids.forEach((e, i) => {
      const pid = page.pids[i]!;
      const label = e === 0 ? '(unassigned)' : `eid ${e} ${effectName(e)} pid ${pid}`;
      const rec = page.at + SLOTS * 4 + i * 32;
      const txt = rec + 32 <= b.length ? `${JSON.stringify(txt16(b, rec + 16))}` : '';
      console.log(`    slot ${String(i + 1).padStart(2)}: ${label.padEnd(34)} ${txt}`);
    });
  }
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
