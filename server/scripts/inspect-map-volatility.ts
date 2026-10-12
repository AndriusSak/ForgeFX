// ────────────────────────────────────────────────────────────────────────────────────────────────
// inspect-map-volatility — the ONLY part of the 590-byte `fn=0x01 sub=0x2e` reply that moves:
// the three "volatile" data bytes at data-relative `+22`/`+23`/`+24` (frame offsets 34/35/36) and the
// checksum. Reports them per reply, in tap order, so the session-vs-read question can be answered from
// data instead of from a story.
//
// WHY: until those three bytes are explained, NO byte of that reply may be used as a stable identity —
// the rule the cab-slot region already taught (never build on a volatile region). This tool interprets
// nothing: it prints the values, the order, the gaps between replies, and whether the rest of the reply
// is byte-identical across the set.
//
// The trio is read at frame offsets 34/35/36 = data (frame bytes 12..len-3) offsets 22/23/24. If the
// probe that wrote the tap also recorded a CONNECTION ordinal in the tap (`#conn N`), it is honoured —
// otherwise the reply timestamps are printed so the reader can see where the connection boundary sits.
//
// USAGE  npx tsx scripts/inspect-map-volatility.ts <tap.log>
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseTap } from './inspect-tap.js';

const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const VOL = [22, 23, 24]; // data-relative

export function main(argv: string[]): number {
  const path = argv.find((a) => !a.startsWith('--'));
  if (!path) { console.log('usage: npx tsx scripts/inspect-map-volatility.ts <tap.log>'); return 2; }
  const text = readFileSync(path, 'utf8');

  // Connection markers, when the probe wrote them, as `<epoch-ms> #conn N`.
  const connBoundaries: Array<{ ts: number; conn: number }> = [];
  for (const raw of text.split('\n')) {
    const m = /^(\d+)\s+#conn\s+(\d+)\s*$/.exec(raw.trim());
    if (m) connBoundaries.push({ ts: Number(m[1]), conn: Number(m[2]) });
  }
  const connOf = (ts: number): number => {
    let c = 0;
    for (const b of connBoundaries) if (b.ts <= ts) c = b.conn;
    return c;
  };

  const frames = parseTap(text).filter((f) => f.dir === 'RX' && f.bytes[5] === 0x01 && f.bytes[6] === 0x2e && f.bytes.length > 100);
  if (!frames.length) { console.log(`${path}: no long sub=0x2e reply in this tap`); return 1; }

  const datas = frames.map((f) => f.bytes.slice(12, -2));
  console.log(`${path}: ${frames.length} long sub=0x2e repl(y|ies)${connBoundaries.length ? ` · ${connBoundaries.length} #conn marker(s)` : ' · NO #conn markers (ordering is tap order)'}`);
  console.log('\nord  conn  @ts-delta  +22 +23 +24   checksum   rest-of-reply-vs-first');
  const first = datas[0]!;
  const trioSeen: string[] = [];
  frames.forEach((f, i) => {
    const d = datas[i]!;
    const trio = VOL.map((o) => d[o]!);
    // The checksum is the ONE byte before F7 (frame[588] on a 590-byte frame); it is expected to
    // follow the trio, since the trio sits inside the checksummed data region.
    const ck = f.bytes.slice(-2, -1);
    const restDiffs: number[] = [];
    for (let o = 0; o < Math.min(first.length, d.length); o++) {
      if (VOL.includes(o)) continue;
      if (first[o] !== d[o]) restDiffs.push(o);
    }
    const delta = i === 0 ? 0 : f.ts - frames[i - 1]!.ts;
    console.log(`  [${i}]   ${connOf(f.ts)}    ${String(i === 0 ? '-' : delta).padStart(7)}ms  ${hex(trio)}   ${hex(ck)}   ${restDiffs.length ? `DIFFERS at +${restDiffs.join(', +')}` : 'identical'}`);
    trioSeen.push(hex(trio));
  });

  console.log(`\ndistinct trios: ${new Set(trioSeen).size}/${trioSeen.length} → ${[...new Set(trioSeen)].join(' | ')}`);
  console.log('reading (a trio that changes WITHIN one connection is per-READ, not per-connection; a trio that');
  console.log('repeats across connections at the same ordinal is session-scoped):');
  console.log('  a counter/nonce would move monotonically with read ordinal; look at the deltas above, not the words here.');

  // Byte-run worth naming: is any of the three a monotone counter across the whole set?
  const series = VOL.map((o) => datas.map((d) => d[o]!));
  series.forEach((s, k) => {
    const mono = s.every((v, i) => i === 0 || ((s[i]! - s[i - 1]! + 256) % 256) <= 4 || s[i] === s[i - 1]);
    console.log(`  +${VOL[k]} series ${s.map((v) => v.toString(16).padStart(2, '0')).join(' ')}${mono ? '  (monotone-ish on a 256 clock)' : ''}`);
  });
  console.log('\nNOTHING HERE IS DECODED. These are the values; what produces them is still open.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
