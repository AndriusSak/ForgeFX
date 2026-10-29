// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-fn-range — MODE: WRITES (state-neutral: every frame is a set of param 4 to the value it already
// holds, 0 = AUTO, with only the FUNCTION byte varied).
//
// WHY. Two measurements disagreed about what an unknown function earns: fn=0x12 answers ONE 0x64, fen=0x6f
// answers NOTHING (probe-write-refusal, 2026-10-29). Either the unit has a bounded known-function window and
// drops everything above it, or refusal depends on something else. This walks a small, deliberately chosen
// set of function bytes to find where the transition happens.
//
// WHAT IS DELIBERATELY *NOT* SENT — the device's own destructive verbs are skipped, because a refusal test
// must never be able to succeed: 0x40 (IR-capture control), 0x41 **delete cab IR**, 0x42 (editor disconnect),
// 0x7a/0x7b/0x7c (IR download family), 0x7d/0x7e (firmware update), 0x77/0x78/0x79 (body dump). A blind sweep
// of 0x00..0x7f would be an efficient way to delete an IR.
//
// SAFETY: payload is the address of param 4 plus value 0 — its current value, re-read at the end. No store,
// no structure, no scene change. Exit 0 · 3 no device.
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { openProbeSession } from './probe-device.js';
import { fractalChecksum } from 'forgefx-midi/shared';
import { parsePresetDump, decodeRawPatch } from 'forgefx-midi/devices/gen3';
import { createHash } from 'node:crypto';

const MODEL = 0x11;
const EDIT_BUFFER = 0x7f;
const EID = 0x25;
const PID = 0x04;
const SKIP = new Set([0x40, 0x41, 0x42, 0x77, 0x78, 0x79, 0x7a, 0x7b, 0x7c, 0x7d, 0x7e]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');

async function bodyHash(session: any): Promise<string> {
  const frames = await session.transport.request(session.codec.buildRequestPresetDump(EDIT_BUFFER), {
    timeoutMs: 8000, quietMs: 300, match: (fs: number[][]) => fs.some((f) => f[5] === 0x79)
  });
  const parsed = parsePresetDump(Uint8Array.from(frames.flat()), 0, MODEL);
  const { body } = decodeRawPatch(parsed.chunkPayloads);
  return createHash('sha256').update(Buffer.from(body)).digest('hex');
}

function frameWithFn(fn: number): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, fn, 0x4e, EID >> 8, EID & 0xff, PID >> 8, PID & 0xff,
    0x00, 0x00, 0x00, 0x00];
  return [...body, fractalChecksum(body), 0xf7];
}

void (async () => {
  const pi = process.argv.indexOf('--port');
  const opened = await openProbeSession(MODEL, pi > 0 ? process.argv[pi + 1] : undefined);
  if (!opened.ok) { console.log('no device'); process.exit(3); }
  const { session } = opened;

  const h0 = await bodyHash(session);
  const fns = [0x11, 0x12, 0x13, 0x14, 0x15, 0x1f, 0x60, 0x61, 0x65, 0x68, 0x6a, 0x6c, 0x6e, 0x6f].filter((f) => !SKIP.has(f));
  console.log(`fn walk (param 4 ← 0, its current value). edit buffer sha ${h0.slice(0, 16)}\n`);
  console.log('  fn    frames  0x64  codes            first');
  const table: Array<[number, number, number, string]> = [];

  for (const fn of fns) {
    const arrivals: number[] = [];
    const t0 = performance.now();
    const unsub = session.transport.onFrame?.(() => arrivals.push(performance.now() - t0));
    let frames: number[][] = [];
    try {
      frames = await session.transport.request(frameWithFn(fn), { timeoutMs: 500, quietMs: 60 });
    } finally { unsub?.(); }
    const ref = frames.filter((f) => f[5] === 0x64);
    const codes = ref.map((f) => hex(f.slice(7, -1))).join(' | ');
    const first = arrivals.length ? `${Math.round(arrivals[0])} ms` : '-';
    console.log(`  0x${fn.toString(16).padStart(2, '0')}  ${String(frames.length).padStart(5)}  `
      + `${String(ref.length).padStart(4)}  ${(codes || '—').padEnd(16)} ${first}`);
    table.push([fn, frames.length, ref.length, codes]);
    await sleep(140);
  }

  const h1 = await bodyHash(session);
  console.log(`\nedit buffer after: sha ${h1.slice(0, 16)}  ${h0 === h1 ? 'UNCHANGED' : 'CHANGED — INVESTIGATE'}`);

  const refused = table.filter(([, , n]) => n > 0).map(([fn]) => fn);
  const silent = table.filter(([fn, , n]) => n === 0 && !refused.includes(fn)).map(([fn]) => fn);
  const hi = (xs: number[]) => (xs.length ? `0x${Math.max(...xs).toString(16)}` : 'none');
  const lo = (xs: number[]) => (xs.length ? `0x${Math.min(...xs).toString(16)}` : 'none');
  console.log(`refused: ${refused.map((f) => '0x' + f.toString(16)).join(' ') || 'none'}`);
  console.log(`silent : ${silent.map((f) => '0x' + f.toString(16)).join(' ') || 'none'}`);
  console.log(`highest refused 0x64: ${hi(refused)} · lowest silent: ${lo(silent)}`);
  await session.close?.();
  process.exit(0);
})();
