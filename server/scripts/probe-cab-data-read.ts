// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-cab-data-read — READ-SHAPED probe: is there a way to read a user cab slot's DATA back?
//
// WHY: two open cab items depend on it. If a slot-data read exists it (a) answers the user-slot NAME
// question (the name lives inside the slot's data), and (b) makes REORDER possible without a device op.
// If it does not exist, that is almost certainly deliberate — user cab data is exactly what protects
// commercial IR vendors from extraction — and the honest answer is "the editor cannot do it either".
//
// WHAT IT SENDS (bounded: a handful of requests, all read-shaped, one slot, no writes):
//   • fn=0x01 with the per-slot sub-actions ADJACENT to the known state query (0x4A/0x4C/0x4D/0x4E),
//     same [index, page] body the state query uses;
//   • fn=0x7D/0x7E/0x7F/0x79 with the same [index, page] body — the neighbours of the IR upload trio
//     (0x7A start / 0x7B data / 0x7C close), in both measured payload shapes.
//
// SAFETY: the caller must run `snapshot-cab-bank.ts save` FIRST and `diff` afterwards. This probe only
// prints what came back; it interprets nothing, and silence is reported as SILENCE (never as "no data
// exists" — an empty reply and a refused request are different observations on this device). It refuses
// to run without a snapshot file, so a side effect cannot go unnoticed.
//
// USAGE
//   npx tsx scripts/snapshot-cab-bank.ts save /tmp/bank.json
//   npx tsx scripts/probe-cab-data-read.ts /tmp/bank.json
//   npx tsx scripts/snapshot-cab-bank.ts diff /tmp/bank.json
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { fractalChecksum } from 'forgefx-midi/shared';

const MODEL = 0x11;
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const printable = (b: readonly number[]) => b.map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.')).join('');

function envelope(fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, fn, ...payload];
  return [...body, fractalChecksum(body), 0xf7];
}

/** The state query's body shape: [sub, 0×5, index, page, 0×7]. */
const bodyA = (index: number, page: number) => [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, index, page, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
/** The upload start frame's shape: [index, page, 0x00, 0x10] + zeros. */
const bodyB = (index: number, page: number) => [index, page, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];

export async function main(argv: string[]): Promise<number> {
  const snapshot = argv[0];
  if (!snapshot || !existsSync(snapshot)) {
    console.log('refusing to probe without a snapshot: run snapshot-cab-bank.ts save <file> first, so any');
    console.log('side effect is detectable and undoable. usage: probe-cab-data-read.ts <snapshot.json>');
    return 2;
  }
  const index = argv[1] ? Number(argv[1]) : 0; // U0001 — a slot known to hold a real IR
  const page = argv[2] ? Number(argv[2]) : 0x10;

  const opened = await openProbeSession(MODEL, argv[3]);
  if (!opened.ok) { console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`); return 3; }
  const { session } = opened;
  const candidates: { label: string; frame: number[] }[] = [
    ...([0x4a, 0x4c, 0x4d, 0x4e] as const).map((sub) => ({
      label: `fn=0x01 sub=0x${sub.toString(16)} (state shape)`,
      frame: envelope(0x01, [sub, ...bodyA(index, page).slice(1)]),
    })),
    ...([0x7d, 0x7e, 0x7f, 0x79] as const).flatMap((fn) => [
      { label: `fn=0x${fn.toString(16)} (state shape)`, frame: envelope(fn, bodyA(index, page)) },
      { label: `fn=0x${fn.toString(16)} (upload-start shape)`, frame: envelope(fn, bodyB(index, page)) },
    ]),
  ];
  try {
    console.log(`device ${session.label} · slot index ${index} page 0x${page.toString(16)} · ${candidates.length} read-shaped probes`);
    console.log('(interpretation is NOT performed here — a reply is printed raw, and silence stays silence)');
    console.log('');
    for (const c of candidates) {
      let frames: number[][] = [];
      try {
        frames = await session.transport.request(c.frame, { timeoutMs: 700, quietMs: 60 });
      } catch (e) {
        console.log(`${c.label.padEnd(34)} TRANSPORT ERROR ${(e as Error).message}`);
        continue;
      }
      if (!frames.length) { console.log(`${c.label.padEnd(34)} SILENT (no reply at all)`); continue; }
      for (const f of frames) {
        console.log(`${c.label.padEnd(34)} ← fn=0x${(f[5] ?? 0).toString(16)} len ${f.length} ${f.length > 40 ? `${hex(f.slice(0, 32))} …` : hex(f)}`);
        if (f.length > 24) console.log(`${' '.repeat(34)}   ascii ${JSON.stringify(printable(f.slice(6, -2)).slice(0, 80))}`);
      }
    }
    return 0;
  } finally {
    await session.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
