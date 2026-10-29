// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-hole-vs-ack — MODE: WRITES. One self-restoring enum write pair (param 4: 0 AUTO → 1 → 0 AUTO,
// the same pair the HIL enum gate uses), to test one specific hypothesis in one connection:
//
//   the hole record's HANDLE MODE prefix (fn=0x01 sub=0x1b, bytes c0..c4) is the SAME FIVE BYTES the
//   device returns in the ack of a parameter write (fn=0x01 sub=0x4e, payload after the echoed address).
//
// WHY. probe-write-refusal (2026-10-29) sent a valid set-parameter frame and its ack carried
// `28 03 00 00 00 05 00 00 00`; the hole record sampled three minutes earlier read `28 03 00 00 00 02 00 00
// 00`. If the prefix tracks the write ack's token, then "handle mode" is not a mystery regime at all: it is
// the device reporting the last edit revision, and index mode is what you get after a scene select resets it.
//
// WHAT THIS MEASURES: the hole prefix before any write, then after each of the two writes, beside the ack
// token of that write. Agreement on all three is the answer; disagreement refutes it.
//
// SAFETY: parameter 4 of the Input block is an enum; the pair 0→1→0 is the exact pair the HIL enum gate has
// run repeatedly (probe enum write gate, 2026-10-29), and the second write restores the first. No store, no
// structure, no scene change. Exit 0 restored · 2 could not restore · 3 no device.
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { openProbeSession } from './probe-device.js';
import { fractalChecksum } from 'forgefx-midi/shared';

const MODEL = 0x11;
const HOLE = [0x00, 0x24, 0x00, 0x00, 0x00] as const;
const EID = 0x25;
const PID = 0x04;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');

function subQuery(sub: number, at: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, 0x01, sub, ...at];
  while (body.length < 20) body.push(0x00);
  return [...body, fractalChecksum(body), 0xf7];
}

function setParam(eid: number, pid: number, value: number): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, 0x01, 0x4e, eid >> 8, eid & 0xff, pid >> 8, pid & 0xff,
    (value >> 8) & 0xff, value & 0xff, 0x00, 0x00];
  return [...body, fractalChecksum(body), 0xf7];
}

void (async () => {
  const pi = process.argv.indexOf('--port');
  const opened = await openProbeSession(MODEL, pi > 0 ? process.argv[pi + 1] : undefined);
  if (!opened.ok) { console.log('no device'); process.exit(3); }
  const { session } = opened;

  const holePrefix = async (): Promise<string> => {
    const f = (await session.transport.request(subQuery(0x1b, HOLE), { timeoutMs: 900, quietMs: 15 }))
      .find((x) => x[5] === 0x01 && x[6] === 0x1b && x.length > 10 && x.length <= 100);
    return f ? hex(f.slice(7, -1).slice(5, 10)) : '(silent)';
  };

  const write = async (value: number): Promise<{ token: string; frames: number }> => {
    const frames = await session.transport.request(setParam(EID, PID, value), { timeoutMs: 900, quietMs: 60 });
    const ack = frames.find((f) => f[5] === 0x01 && f[6] === 0x4e);
    // payload after the echoed 5-byte address (eid 2 + pid 2 + value 2 + 2 spare) — the 9 state bytes
    return { token: ack ? hex(ack.slice(7, -1).slice(5, 10)) : '(no ack)', frames: frames.length };
  };

  const before = await holePrefix();
  console.log(`hole before writes: [${before}]`);

  const w1 = await write(0x0001);
  await sleep(250);
  const h1 = await holePrefix();
  console.log(`write 1 -> ack token [${w1.token}]  hole now [${h1}]  ${w1.token === h1 ? 'AGREE' : 'differ'}`);

  const w2 = await write(0x0000);
  await sleep(250);
  const h2 = await holePrefix();
  console.log(`restore -> ack token [${w2.token}]  hole now [${h2}]  ${w2.token === h2 ? 'AGREE' : 'differ'}`);

  // prove the restore, not assume it: the ack of the restore should echo value 0 and the body stay put
  console.log(`\nverdict: ${h1 === w1.token && h2 === w2.token
    ? 'the hole prefix IS the write ack token (handle mode = last edit revision)'
    : 'no consistent match — the token hypothesis is refuted'}`);
  await session.close?.();
  process.exit(0);
})();
