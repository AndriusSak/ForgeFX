// ────────────────────────────────────────────────────────────────────────────────────────────────
// dump-preset-bytes — pull a preset off the unit RAW, write it to a file, and DIFF two of them.
//
// WHY: §2.2 needs a fixture whose performance-page config is known, and the fastest way to find where a
// config lands in the preset body is a DIFFERENTIAL: dump the same preset with and without the config and
// look at what moved. This does the dump and the diff in one pass so the answer does not depend on
// remembering which file was which.
//
// READ-ONLY on the device: the 0x77/0x78/0x79 dump chain.
//
// USAGE  npx tsx scripts/dump-preset-bytes.ts --presets 406,409 [--dir ~/.hermes/cache/scratch/presets]
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';

const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');

export async function main(argv: string[]): Promise<number> {
  const argOf = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const nums = (argOf('--presets') ?? '').split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0);
  const dir = (argOf('--dir') ?? `${process.env.HOME}/.hermes/cache/scratch/presets`).replace('~', process.env.HOME ?? '');
  if (!nums.length) { console.log('usage: npx tsx scripts/dump-preset-bytes.ts --presets 406,409 [--dir DIR]'); return 2; }
  const opened = await openProbeSession(0x11);
  if (!opened.ok) { console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`); return 3; }
  const { session } = opened;
  try {
    mkdirSync(dir, { recursive: true });
    const dumps: { n: number; name: string; bytes: number[]; file: string }[] = [];
    for (const n of nums) {
      const b = await session.driver.backupPreset?.(n);
      if (!b) { console.log(`preset ${n}: no backup method on this driver`); continue; }
      const file = join(dir, `preset-${n}.bin`);
      writeFileSync(file, Buffer.from(b.bytes));
      const sha = createHash('sha256').update(Buffer.from(b.bytes)).digest('hex').slice(0, 12);
      console.log(`preset ${String(n).padStart(3)}  “${b.name}”  ${b.bytes.length} bytes  sha ${sha}  → ${file}`);
      dumps.push({ n, name: b.name, bytes: b.bytes, file });
    }
    // Pairwise diff in the order given — reported as ranges, with the bytes themselves, because "N bytes
    // differ" is useless without knowing WHERE and WHAT.
    for (let i = 1; i < dumps.length; i++) {
      const a = dumps[i - 1]!; const b = dumps[i]!;
      console.log(`\n=== diff ${a.n} (“${a.name}”) → ${b.n} (“${b.name}”) : lengths ${a.bytes.length} vs ${b.bytes.length} ===`);
      const len = Math.max(a.bytes.length, b.bytes.length);
      const diffAt: number[] = [];
      for (let k = 0; k < len; k++) if (a.bytes[k] !== b.bytes[k]) diffAt.push(k);
      if (!diffAt.length) { console.log('  identical — no byte differs'); continue; }
      console.log(`  ${diffAt.length} differing byte(s), first at ${diffAt[0]}, last at ${diffAt[diffAt.length - 1]}`);
      // group into ranges (gap > 16 bytes starts a new range)
      const ranges: [number, number][] = [];
      let s = diffAt[0]!; let prev = diffAt[0]!;
      for (const k of diffAt.slice(1)) { if (k - prev > 16) { ranges.push([s, prev]); s = k; } prev = k; }
      ranges.push([s, prev]);
      console.log(`  ${ranges.length} differing region(s):`);
      for (const [from, to] of ranges.slice(0, 12)) {
        const aSlice = a.bytes.slice(from, to + 1); const bSlice = b.bytes.slice(from, to + 1);
        console.log(`    @${from}..${to} (${to - from + 1} B)`);
        console.log(`      A: ${hex(aSlice.slice(0, 60))}${aSlice.length > 60 ? ' …' : ''}`);
        console.log(`      B: ${hex(bSlice.slice(0, 60))}${bSlice.length > 60 ? ' …' : ''}`);
      }
      if (ranges.length > 12) console.log(`    … and ${ranges.length - 12} more region(s)`);
    }
    return 0;
  } finally {
    await session.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
