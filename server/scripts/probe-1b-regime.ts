// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-1b-regime — MODE: WRITES. Everything is a read except ONE self-restoring scene select
// (fn=0x0c, scene N → N+1 → N, restored and then re-read so the restore is proven, not assumed).
//
// WHY (2026-10-29). The hole record's 9-byte content had two measured shapes: `00 … 02` at scene 0 and
// `01 … 02` at scene 1, reverting 5/5 (probe-hole-vs-scene) — i.e. byte 0 tracked the SCENE. On the same
// morning the record read `00` at 11:07Z and `28 00 00 00 00 02 00 00 00` from 11:26Z through 13:50Z with
// scene unchanged at 0, and after a scene arm (0 → 1 → 0) it read `00` again. So the same logical state
// produced two different kinds of value and the field is NOT a pure function of the scene.
//
// WHAT THIS MEASURES, in one connection, all on the hole anchor [00 24 00 00 00]:
//   A   the value now
//   B   the value at the next scene (one write, fn=0x0c)
//   C   the value back at the starting scene (the restore, verified by re-reading the scene index)
//   D   the value again after 3 s of no traffic (does it settle?)
// It answers: is byte 0 still the scene index (A=00, B=01, C=00), or is it an opaque handle that a write
// reassigns and that does not come back (the 2026-10-29 morning shape)?
//
// SAFETY: the only write is a scene select, self-restored, with the scene index re-read afterwards. No
// parameter, no structure, no store. Exit 0 read+restored · 2 could not restore · 3 no device.
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { openProbeSession } from './probe-device.js';
import { fractalChecksum } from 'forgefx-midi/shared';

const MODEL = 0x11;
const HOLE = [0x00, 0x24, 0x00, 0x00, 0x00] as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');

function subQuery(sub: number, at: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, 0x01, sub, ...at];
  while (body.length < 20) body.push(0x00);
  return [...body, fractalChecksum(body), 0xf7];
}

function content(frames: readonly number[][], sub: number): string | null {
  const f = frames.find((x) => x[5] === 0x01 && x[6] === sub && x.length <= 100 && x.length > 10);
  return f ? hex(f.slice(7, -1).slice(5, 14)) : null; // C9 = data 5..13
}

void (async () => {
  const pi = process.argv.indexOf('--port');
  const opened = await openProbeSession(MODEL, pi > 0 ? process.argv[pi + 1] : undefined);
  if (!opened.ok) { console.log('no device'); process.exit(3); }
  const { session } = opened;
  const read = async () => content(await session.transport.request(subQuery(0x1b, HOLE), { timeoutMs: 900, quietMs: 15 }), 0x1b) ?? '(silent)';
  const scene = async () => (await session.driver.getScene?.())?.index ?? -1;

  const s0 = await scene();
  const A = await read();
  const s1 = (s0 + 1) % 8;
  console.log(`scene ${s0} · A hole = ${A}`);

  const w1 = await session.driver.setScene?.(s1);
  await sleep(800);
  const B = await read();
  console.log(`scene ${await scene()} · B hole = ${B}   (setScene ${JSON.stringify(w1)})`);

  const w2 = await session.driver.setScene?.(s0);
  await sleep(800);
  const C = await read();
  console.log(`scene ${await scene()} · C hole = ${C}   (restore ${JSON.stringify(w2)})`);

  await sleep(3000);
  const D = await read();
  console.log(`scene ${await scene()} · D hole = ${D}   (after 3 s idle)`);

  const back = await scene();
  console.log(`\nA vs C: ${A === C ? 'same' : 'different'} · B vs A: ${B === A ? 'same' : 'different'} · C vs D: ${C === D ? 'stable after 3 s' : 'still settling'}`);
  if (back !== s0) { console.log(`ABORT-WORTHY: scene is ${back}, expected ${s0}`); process.exit(2); }
  const sceneIndexed = A === C && B !== A;
  console.log(sceneIndexed
    ? 'READING: byte 0 still behaves like the SCENE INDEX (A=C, B differs).'
    : 'READING: not a scene index — the write reassigned it and it did not come back (handle regime).');
  await session.close?.();
})();
