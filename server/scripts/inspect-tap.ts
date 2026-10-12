// ────────────────────────────────────────────────────────────────────────────────────────────────
// inspect-tap — read a `FORGEFX_TAP` log (the format every hardware probe writes) and report what is in it.
//
// WHY: the project has `analyze-cab-capture.ts` for USBPcap `.pcapng` files, but the taps our OWN probes write
// are a different format (`<epoch-ms> TX|RX <hex bytes>`). Until now the only way to look at one was by eye —
// and reading device bytes by eye is a documented way to land a wrong story (a hand-read once called marker+26
// zero). This tool is the tool-based counterpart: group by function byte and `fn=0x01` sub-action, count, list
// lengths and DISTINCT payloads, and diff two frames at explicit offsets.
//
// USAGE
//   npx tsx scripts/inspect-tap.ts <tap.log>                       # histogram by fn / sub
//   npx tsx scripts/inspect-tap.ts <tap.log> --sub 2e              # per-frame lengths + distinct payloads for a sub
//   npx tsx scripts/inspect-tap.ts <tap.log> --sub 2e --diff A,B   # byte-level diff of two frames (indices into that sub's list)
//   npx tsx scripts/inspect-tap.ts <tap.log> --sub 2e --dump 1     # hex dump of one frame, offset-labelled
//   npx tsx scripts/inspect-tap.ts <tap.log> --sub 2e --runs 1     # the repeated byte runs in a frame (table-shaped?)
//
// It INTERPRETS nothing: it reports lengths, distinctness, offsets and runs. Meaning is the reader's job, and
// a tool that guessed a meaning would be the thing the next reader trusts by mistake.
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface TapFrame {
  ts: number;
  dir: 'TX' | 'RX';
  bytes: number[];
  line: number;
}

export function parseTap(text: string): TapFrame[] {
  const out: TapFrame[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const m = /^(\d+)\s+(TX|RX)\s+([0-9a-f ]+)$/i.exec(line);
    if (!m) return;
    out.push({
      ts: Number(m[1]),
      dir: m[2]!.toUpperCase() as 'TX' | 'RX',
      bytes: m[3]!.trim().split(/\s+/).map((x) => parseInt(x, 16)),
      line: i + 1,
    });
  });
  return out;
}

const hex = (b: readonly number[], from = 0) => b.slice(from).map((x) => x.toString(16).padStart(2, '0')).join(' ');

/** The `fn` byte (envelope position 5) and, for fn=0x01, the sub-action at position 6. */
const fnOf = (f: TapFrame) => f.bytes[5] ?? -1;
const subOf = (f: TapFrame) => f.bytes[6] ?? -1;

export function main(argv: string[]): number {
  const path = argv.find((a) => !a.startsWith('--'));
  if (!path) { console.log('usage: npx tsx scripts/inspect-tap.ts <tap.log> [--sub NN] [--dir TX|RX] [--diff A,B] [--dump N] [--runs N]'); return 2; }
  const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const subArg = arg('--sub');
  const dirArg = arg('--dir')?.toUpperCase();
  const frames = parseTap(readFileSync(path, 'utf8'));
  if (!frames.length) { console.log(`${path}: no frames parsed — is this a FORGEFX_TAP log?`); return 1; }
  console.log(`${path}: ${frames.length} frames, ${frames.filter((f) => f.dir === 'TX').length} TX / ${frames.filter((f) => f.dir === 'RX').length} RX`);

  const sub = subArg === undefined ? undefined : parseInt(subArg, 16);
  const sel = frames.filter((f) => (sub === undefined || (fnOf(f) === 0x01 && subOf(f) === sub))
    && (dirArg === undefined || f.dir === dirArg));
  if (sub === undefined) {
    // Histogram by fn, with the fn=0x01 sub-actions broken out — the view that finds an unmapped sub.
    const byFn = new Map<number, number>();
    for (const f of frames) byFn.set(fnOf(f), (byFn.get(fnOf(f)) ?? 0) + 1);
    console.log('\nfn histogram:');
    for (const [fn, n] of [...byFn].sort((a, b) => b[1] - a[1])) {
      console.log(`  fn 0x${fn.toString(16).padStart(2, '0')} (${fn === 0x01 ? 'parameter read/write family' : '—'}): ${n}`);
      if (fn !== 0x01) continue;
      const bySub = new Map<number, { n: number; len: number[] }>();
      for (const f of frames.filter((g) => fnOf(g) === 0x01)) {
        const s = subOf(f);
        const e = bySub.get(s) ?? { n: 0, len: [] };
        e.n++; e.len.push(f.bytes.length);
        bySub.set(s, e);
      }
      for (const [s, e] of [...bySub].sort((a, b) => a[0] - b[0])) {
        const lens = [...new Set(e.len)].sort((x, y) => x - y);
        console.log(`      sub 0x${s.toString(16).padStart(2, '0')}: ${e.n} frame(s), length(s) ${lens.join('/')}`);
      }
    }
    return 0;
  }

  console.log(`\nsub 0x${sub.toString(16).padStart(2, '0')}${dirArg ? ` (${dirArg} only)` : ''}: ${sel.length} frame(s)`);
  sel.forEach((f, i) => console.log(`  [${i}] line ${f.line} ${f.dir} ${f.bytes.length}B @${f.ts} from byte 6: ${hex(f.bytes, 6).slice(0, 90)}${f.bytes.length > 40 ? ' …' : ''}`));

  const dumpIdx = arg('--dump');
  if (dumpIdx !== undefined) {
    const f = sel[Number(dumpIdx)];
    if (!f) { console.log(`no frame ${dumpIdx}`); return 1; }
    console.log(`\nframe [${dumpIdx}] ${f.dir} ${f.bytes.length}B, offset-labelled:`);
    for (let o = 0; o < f.bytes.length; o += 16) {
      const row = f.bytes.slice(o, o + 16);
      console.log(`  +${String(o).padStart(4)}  ${hex(row).padEnd(47)}  ${row.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('')}`);
    }
  }

  const diffArg = arg('--diff');
  if (diffArg) {
    const [ai, bi] = diffArg.split(',').map(Number);
    const a = sel[ai!]!; const b = sel[bi!]!;
    if (!a || !b) { console.log('--diff needs two valid indices'); return 1; }
    const n = Math.min(a.bytes.length, b.bytes.length);
    const diffs: number[] = [];
    for (let i = 0; i < n; i++) if (a.bytes[i] !== b.bytes[i]) diffs.push(i);
    console.log(`\ndiff [${ai}] (${a.bytes.length}B) vs [${bi}] (${b.bytes.length}B): ${diffs.length} differing byte(s)${a.bytes.length !== b.bytes.length ? ` · LENGTHS DIFFER` : ''}`);
    for (const i of diffs.slice(0, 40)) console.log(`  +${i}: ${a.bytes[i]!.toString(16).padStart(2, '0')} → ${b.bytes[i]!.toString(16).padStart(2, '0')}`);
    if (diffs.length > 40) console.log(`  … ${diffs.length - 40} more`);
  }

  const runsIdx = arg('--runs');
  if (runsIdx !== undefined) {
    const f = sel[Number(runsIdx)];
    if (!f) { console.log(`no frame ${runsIdx}`); return 1; }
    console.log(`\nrepeated byte-runs in frame [${runsIdx}] (length ≥ 4, appearing ≥ 3 times) — a table usually shows this:`);
    for (const len of [4, 6, 8]) {
      const count = new Map<string, number>();
      for (let o = 6; o + len <= f.bytes.length - 2; o++) {
        const k = hex(f.bytes.slice(o, o + len));
        count.set(k, (count.get(k) ?? 0) + 1);
      }
      const top = [...count].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 6);
      if (top.length) console.log(`  ${len}-byte runs: ${top.map(([k, n]) => `"${k}"×${n}`).join(' · ')}`);
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
