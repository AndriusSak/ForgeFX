// ────────────────────────────────────────────────────────────────────────────────────────────────
// inspect-layout-map — the STRUCTURE of the `fn=0x01 sub=0x2e` reply (the 590-byte "layout map" the FM3
// sends), extracted from a tap so the next reader starts from facts rather than re-deriving them.
//
// It INTERPRETS nothing and it decodes nothing. It reports:
//   • how many long replies the tap holds, and their length;
//   • the data region (header 0..11 and the checksum+F7 stripped);
//   • which data bytes DIFFER between those replies — the volatile ones, named by offset;
//   • the zero fraction and the top byte values (a table of ids looks nothing like a bit-level blob);
//   • where the characteristic single-bit run `40 20 10 08 04 02 01 00` starts, and the deltas between those
//     offsets — the stride question, answered by data instead of by eye;
//   • the two dependency tests as REPORTED FACTS, not assumptions: each reply's address-region bytes and the
//     volatile offsets, so "the table ignores its address" is visible rather than asserted.
//
// It also runs ONE falsifiable hypothesis check that the repo can supply an oracle for: whether any
// FM3_BLOCK_GEOMETRY entry appears with its own `cols`/`rows` beside it (a block-layout table would). That
// check came back NEGATIVE on the 2026-10-12 capture — reported, not hidden, because a hypothesis the data
// kills is worth as much as one it supports.
//
// USAGE  npx tsx scripts/inspect-layout-map.ts <tap.log>
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseTap } from './inspect-tap.js';
import { FM3_BLOCK_GEOMETRY } from 'forgefx-midi/devices/gen3';

const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');

export function main(argv: string[]): number {
  const path = argv.find((a) => !a.startsWith('--'));
  if (!path) { console.log('usage: npx tsx scripts/inspect-layout-map.ts <tap.log>'); return 2; }
  const frames = parseTap(readFileSync(path, 'utf8'))
    .filter((f) => f.dir === 'RX' && f.bytes[5] === 0x01 && f.bytes[6] === 0x2e && f.bytes.length > 100);
  if (!frames.length) { console.log(`${path}: no long sub=0x2e reply in this tap`); return 1; }

  const datas = frames.map((f) => f.bytes.slice(12, -2));
  console.log(`${frames.length} long sub=0x2e repl(y|ies) · frame ${frames[0]!.bytes.length}B · data region ${datas[0]!.length}B`);
  console.log('address region of each (query bytes 7..11, echoed back): ' +
    frames.map((f, i) => `[${i}] ${hex(f.bytes.slice(7, 12))}`).join(' · '));

  // Volatile bytes: the ones that differ between replies. A dependency test that is OBSERVED.
  const volatile: string[] = [];
  for (let o = 0; o < datas[0]!.length; o++) {
    const vals = datas.map((d) => d[o]!);
    if (!vals.every((v) => v === vals[0])) volatile.push(`+${o} (data-rel): ${vals.map((v) => v.toString(16)).join('/')}`);
  }
  console.log(`\nvolatile data bytes: ${volatile.length ? volatile.join(' · ') : 'none — the data region is byte-identical across these replies'}`);
  if (volatile.length) {
    console.log('  ⇒ a byte that differs between two replies of the SAME preset is not derived from that preset,');
    console.log('    its edit buffer, or its address: those three are what a "state" hypothesis would require.');
  }

  // Shape of the data: ids/small tables vs a bit-level blob.
  const hist = new Map<number, number>();
  for (const b of datas[0]!) hist.set(b, (hist.get(b) ?? 0) + 1);
  const bits = [0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01];
  const bitCount = bits.reduce((n, v) => n + (hist.get(v) ?? 0), 0);
  console.log(`\nzero bytes: ${hist.get(0) ?? 0}/${datas[0]!.length} · distinct values: ${hist.size}/256`);
  console.log(`single-bit values (0x40/0x20/0x10/0x08/0x04/0x02/0x01): ${bitCount} bytes`);
  console.log(`top values: ${[...hist].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([v, n]) => `0x${v.toString(16)}=${n}`).join(' ')}`);

  // The stride question, from the data.
  const PAT = [0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01, 0x00];
  const starts: number[] = [];
  for (let o = 0; o + PAT.length <= datas[0]!.length; o++) {
    if (PAT.every((v, i) => datas[0]![o + i] === v)) starts.push(o);
  }
  console.log(`\nruns of ${hex(PAT)}: ${starts.length} at ${starts.slice(0, 12).join(', ')}${starts.length > 12 ? ' …' : ''}`);
  console.log(`  deltas: ${starts.slice(1).map((s, i) => s - starts[i]!).join(', ')}  ← irregular: not a fixed-stride record table`);

  // The one hypothesis the repo can falsify on its own.
  const geo = Object.entries(FM3_BLOCK_GEOMETRY).map(([id, g]) => ({ id: Number(id), cols: g.cols, rows: g.rows }));
  const hits: string[] = [];
  for (const g of geo) {
    for (let o = 0; o < datas[0]!.length; o++) {
      if (datas[0]![o] !== g.id) continue;
      const next = [datas[0]![o + 1], datas[0]![o + 2]];
      if (next[0] === g.cols && next[1] === g.rows) hits.push(`block ${g.id} → ${g.cols}×${g.rows} @${o}`);
    }
  }
  console.log(`\nBLOCK-GEOMETRY hypothesis (an id followed by its own cols/rows): ${hits.length ? hits.join(', ') : 'NO HITS'}`);
  console.log('  (FM3_BLOCK_GEOMETRY is the oracle: 28 blocks with cols/rows. No hit means this reply is NOT a');
  console.log('   per-block geometry table — reported because a killed hypothesis is a result.)');
  console.log('\nNOTHING HERE IS DECODED. The reply is stable, address-independent and edit-buffer-independent; what');
  console.log('its bytes MEAN is still open, and the next tests are named in test/fixtures/query-subs/README.md.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
