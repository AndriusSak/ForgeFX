// inspect-capture-subs — per-sub-action look at a capture: how many frames, which lengths, how many DISTINCT
// payloads, and the longest/shortest examples. Use when a sub is UNMAPPED and you need to know whether it is
// a poll (few distinct payloads, short) or a DUMP (long, distinct) before deciding what to do about it.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readChunks, framesOf } from './scan-usb-capture.js';

const hex = (a: readonly number[], n = 60) => a.slice(0, n).map((x) => x.toString(16).padStart(2, '0')).join(' ');

export function main(argv: string[]): number {
  const path = argv.find((a) => !a.startsWith('--'));
  if (!path) { console.log('usage: npx tsx scripts/inspect-capture-subs.ts <capture.pcapng> [subs like 56,2e,00]'); return 2; }
  const subsArg = argv.filter((a) => !a.startsWith('--'))[1];
  const wantSubs = subsArg ? subsArg.split(',').map((x) => parseInt(x, 16)) : null;
  const { chunks } = readChunks(readFileSync(path));
  const { frames } = framesOf(chunks);
  console.log(`${path}: ${frames.length} frames`);
  const bySub = new Map<number, typeof frames>();
  for (const f of frames) {
    if (f.fn !== 0x01) continue;
    const sub = f.bytes[6] ?? -1;
    if (!bySub.has(sub)) bySub.set(sub, []);
    bySub.get(sub)!.push(f);
  }
  for (const [sub, list] of [...bySub].sort((a, b) => a[0] - b[0])) {
    if (wantSubs && !wantSubs.includes(sub)) continue;
    const lens = [...new Set(list.map((f) => f.bytes.length))].sort((a, b) => a - b);
    const eps = [...new Set(list.map((f) => f.ep))].join('/');
    const distinct = new Set(list.map((f) => f.bytes.slice(6, -2).join(','))).size;
    console.log(`\n=== sub 0x${sub.toString(16)} — ${list.length} frames · ep ${eps} · lengths ${lens.join(',')} · ${distinct} DISTINCT payloads ===`);
    const longest = [...list].sort((a, b) => b.bytes.length - a.bytes.length)[0]!;
    const shortest = [...list].sort((a, b) => a.bytes.length - b.bytes.length)[0]!;
    console.log(`  longest  (${longest.bytes.length} B, ep ${longest.ep}): ${hex(longest.bytes)}${longest.bytes.length > 60 ? ' …' : ''}`);
    console.log(`  shortest (${shortest.bytes.length} B, ep ${shortest.ep}): ${hex(shortest.bytes)}`);
  }
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
