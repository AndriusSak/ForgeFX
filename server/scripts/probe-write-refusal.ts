// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-write-refusal — MODE: WRITES (five set-parameter frames, all provably state-neutral).
//
// WHY (2026-10-29, closes NEXT-STEPS Q5). The device's refusal channel (0x64) had been measured only from
// READ slots: a valid frame naming an unsupported function answers ONE 0x64, a bad checksum answers TWO
// (0x01 then 0x00), and a frame with an unknown eid answers NOTHING. What was never measured is the same
// question on the WRITE path — i.e. when the editor sends a parameter value the unit will not take, can it
// tell "refused" from "ignored", and how long does it wait? That matters because the UI currently treats a
// missing ack as success (it re-reads instead), so silence and refusal look identical to the user.
//
// WHAT THIS MEASURES. Five set-parameter frames, one connection, each with its arrival timestamps:
//   A  control        eid 0x25 pid 4 value 0    — a VALID write of the value the zone already holds (no-op)
//   B  bad checksum   A with the checksum byte flipped
//   C  bad function   A with fn=0x01 replaced by 0x6f (checksum recomputed, so ONLY the function is wrong)
//   D  non-block eid  same frame addressed to eid 0x7f
//   E  unknown pid    same frame addressed to pid 0x0fff on a real block
// Output: per case, the frames heard, the 0x64 result codes, and the milliseconds to first reply. Then the
// edit-buffer body hash, which must be unchanged: a refusal that still wrote would be the finding.
//
// SAFETY: every frame either cannot be parsed (B), describes a function the unit does not have (C), names
// something that is not a block (D), or names a parameter that does not exist (E). Case A writes the value
// param 4 already holds (0 = AUTO, re-read by this probe first). No store, no structure, no scene change.
// Exit 0 all five sent and body unchanged · 2 body changed (inspect before trusting anything) · 3 no device.
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { openProbeSession } from './probe-device.js';
import { fractalChecksum } from 'forgefx-midi/shared';
import { parsePresetDump, decodeRawPatch } from 'forgefx-midi/devices/gen3';
import { createHash } from 'node:crypto';

const MODEL = 0x11;
const EDIT_BUFFER = 0x7f;
const EID = 0x25; // Input block
const PID = 0x04; // the zone's first enum, 0 = AUTO
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');

interface Heard { frames: number[][]; firstMs: number | null; ms: number }

async function bodyHash(session: any): Promise<string> {
  const frames = await session.transport.request(session.codec.buildRequestPresetDump(EDIT_BUFFER), {
    timeoutMs: 8000, quietMs: 300, match: (fs: number[][]) => fs.some((f) => f[5] === 0x79)
  });
  if (!frames.some((f) => f[5] === 0x79)) throw new Error(`incomplete dump (${frames.length} frames, no 0x79)`);
  const parsed = parsePresetDump(Uint8Array.from(frames.flat()), 0, MODEL);
  const { body } = decodeRawPatch(parsed.chunkPayloads);
  return createHash('sha256').update(Buffer.from(body)).digest('hex');
}

function setParam(eid: number, pid: number, value: number): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, 0x01, 0x4e, eid >> 8, eid & 0xff, pid >> 8, pid & 0xff,
    (value >> 8) & 0xff, value & 0xff, 0x00, 0x00];
  return [...body, fractalChecksum(body), 0xf7];
}

async function fire(session: any, label: string, frame: number[]): Promise<Heard> {
  const arrivals: number[] = [];
  const t0 = performance.now();
  const unsub = session.transport.onFrame?.(() => arrivals.push(performance.now() - t0));
  let frames: number[][] = [];
  try {
    frames = await session.transport.request(frame, { timeoutMs: 900, quietMs: 60 });
  } finally {
    unsub?.();
  }
  const ms = Math.round(performance.now() - t0);
  const refusals = frames.filter((f) => f[5] === 0x64);
  const codes = refusals.map((f) => hex(f.slice(6, -1)));
  console.log(`  ${label.padEnd(14)} reply ${String(frames.length).padStart(2)} frame(s), `
    + `0x64 x${refusals.length}${codes.length ? ` [${codes.join(' | ')}]` : ''}, `
    + `first ${arrivals.length ? Math.round(arrivals[0]) : '-'} ms, window ${ms} ms`);
  return { frames, firstMs: arrivals.length ? Math.round(arrivals[0]) : null, ms };
}

void (async () => {
  const pi = process.argv.indexOf('--port');
  const opened = await openProbeSession(MODEL, pi > 0 ? process.argv[pi + 1] : undefined);
  if (!opened.ok) { console.log('no device'); process.exit(3); }
  const { session } = opened;

  const h0 = await bodyHash(session);
  console.log(`edit buffer before: sha ${h0.slice(0, 16)}`);

  const control = setParam(EID, PID, 0x0000);
  const badCk = control.slice();
  badCk[badCk.length - 2] = badCk[badCk.length - 2] ^ 0x01;

  const badFn = control.slice();
  badFn[5] = 0x6f;
  badFn[badFn.length - 2] = fractalChecksum(badFn.slice(0, -2));

  console.log('\nfive set-parameter frames (all state-neutral):');
  const A = await fire(session, 'A control', control);
  await sleep(120);
  const B = await fire(session, 'B checksum', badCk);
  await sleep(120);
  const C = await fire(session, 'C function', badFn);
  await sleep(120);
  const D = await fire(session, 'D non-block', setParam(0x7f, PID, 0));
  await sleep(120);
  const E = await fire(session, 'E unknown pid', setParam(EID, 0x0fff, 0));

  const h1 = await bodyHash(session);
  console.log(`\nedit buffer after:  sha ${h1.slice(0, 16)}  ${h0 === h1 ? 'UNCHANGED' : 'CHANGED — INVESTIGATE'}`);

  const refused = (h: Heard) => h.frames.some((f) => f[5] === 0x64);
  const verdict = (h: Heard) => (refused(h) ? 'refused (0x64)' : h.frames.length === 0 ? 'silent' : 'answered, no 0x64');
  console.log(`A ${verdict(A)} · B ${verdict(B)} · C ${verdict(C)} · D ${verdict(D)} · E ${verdict(E)}`);
  console.log(A.firstMs !== null && B.firstMs !== null
    ? `refusal latency: checksum ${B.firstMs} ms · function ${C.firstMs ?? '-'} ms · accepted control ${A.firstMs} ms`
    : 'timing incomplete — one or more cases heard nothing');

  await session.close?.();
  process.exit(h0 === h1 ? 0 : 2);
})();
