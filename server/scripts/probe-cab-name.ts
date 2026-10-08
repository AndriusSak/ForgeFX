// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-cab-name — READ-ONLY sweep of the gen-3 GET_CAB_NAME opcode (fn 0x12).
//
// WHY: §2.5 (user-cab IR upload) needs two things the repo has never measured:
//   (a) the CAB NUMBER ↔ slot map (where the user bank / scratchpad slots sit in the device's own
//       numbering), and
//   (b) an INDEPENDENT ORACLE for a load test — a way to read back a slot's NAME after an upload that
//       is not the upload's own echo. fn 0x12 is the documented gen-3 GET_CAB_NAME (the same opcode
//       name the gen-2 table carries as CABNAME = 0x12); its reply carries the slot's name string.
//
// NOTHING IS WRITTEN. This probe only sends read requests and prints what came back, raw hex first.
// A number that draws no reply is reported as SILENT — never as "empty slot", because silence and an
// empty name are not the same observation on this device (see the 0x64 finding in the skill).
//
// USAGE
//   npx tsx scripts/probe-cab-name.ts                       # default: a coarse sweep that finds the map
//   npx tsx scripts/probe-cab-name.ts --from 1 --to 64      # a contiguous range
//   npx tsx scripts/probe-cab-name.ts --nums 1,1024,1025,2048,2049,2238,2750
//   npx tsx scripts/probe-cab-name.ts --one-byte            # send the cab number as ONE 7-bit byte
//   npx tsx scripts/probe-cab-name.ts --port /dev/ttyACM0 --model fm3
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { fractalChecksum } from 'forgefx-midi/shared';

const FN_GET_CAB_NAME = 0x12;
const MFR = [0x00, 0x01, 0x74] as const;

/** Envelope: F0 00 01 74 <model> <fn> <payload...> <cs> F7.
 *  The checksum covers F0 THROUGH the last payload byte (verified against the wiki's own worked
 *  example `F0 00 01 74 08 14 00 00 19 F7`, where 0xF0^0x00^0x01^0x74^0x08^0x14 = 0x19 — the
 *  gen-3 codec's buildEnvelope uses the same convention). Excluding F0 (as the first cut of this
 *  probe did) makes the FM3 answer `0x64` with result 0x00/0x01 instead of doing the requested work. */
function envelope(modelByte: number, fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, ...MFR, modelByte, fn, ...payload];
  const cs = fractalChecksum(body);
  return [...body, cs, 0xf7];
}

function encode14(value: number): [number, number] {
  return [value & 0x7f, (value >> 7) & 0x7f];
}

/** Printable ASCII of the reply's data bytes, stopping at the first NUL (the spec's terminator). */
function decodeName(frame: readonly number[]): string {
  if (frame.length < 8) return '';
  const data = frame.slice(6, frame.length - 2); // drop F0+mfr+model+fn, then cs+F7
  const out: string[] = [];
  for (const b of data) {
    if (b === 0x00) break;
    out.push(b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '\u00b7');
  }
  return out.join('').trimEnd();
}

const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');

interface Opts {
  model: number;
  port?: string;
  nums?: number[];
  from?: number;
  to?: number;
  oneByte: boolean;
  step: number;
  timeoutMs: number;
}

function parseArgs(argv: string[]): Opts | { error: string } {
  const o: Opts = { model: 0x11, oneByte: false, step: 1, timeoutMs: 700 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') {
      const k = argv[++i];
      const map: Record<string, number> = { fm3: 0x11, fm9: 0x12, axe3: 0x10 };
      if (!(k in map)) return { error: `unknown --model ${k}` };
      o.model = map[k]!;
    } else if (a === '--port') o.port = argv[++i];
    else if (a === '--from') o.from = Number(argv[++i]);
    else if (a === '--to') o.to = Number(argv[++i]);
    else if (a === '--step') o.step = Number(argv[++i]);
    else if (a === '--nums') o.nums = (argv[++i] ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    else if (a === '--one-byte') o.oneByte = true;
    else if (a === '--timeout') o.timeoutMs = Number(argv[++i]);
    else if (a === '-h' || a === '--help') return { error: 'help' };
    else return { error: `unknown argument ${a}` };
  }
  return o;
}

/** The default sweep: probe the boundaries that separate factory / legacy / user / scratchpad ranges. */
function boundarySweep(): number[] {
  const nums: number[] = [];
  for (let n = 1; n <= 8; n++) nums.push(n);
  for (const centre of [512, 1024, 1025, 2048, 2049, 2238, 2239, 2300, 2500, 2750, 2766, 3000, 3072]) {
    for (let d = -2; d <= 2; d++) nums.push(centre + d);
  }
  return [...new Set(nums.filter((n) => n >= 1))].sort((a, b) => a - b);
}

export async function main(argv: string[], log: (l: string) => void = console.log): Promise<number> {
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    log(parsed.error === 'help' ? 'probe-cab-name — see the header comment for usage' : parsed.error);
    return 1;
  }
  const o = parsed;

  const opened = await openProbeSession(o.model, o.port);
  if (!opened.ok) {
    log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`);
    return 3;
  }
  const { session } = opened;
  log(`device: ${session.label} (model 0x${o.model.toString(16)}) — READ-ONLY cab-name sweep, nothing is written`);

  const nums = o.nums ?? boundarySweep();
  if (o.from != null && o.to != null) {
    nums.length = 0;
    for (let n = o.from; n <= o.to; n += o.step) nums.push(n);
  }

  log(`probing ${nums.length} cab number(s)${o.oneByte ? ' (1-byte encoding)' : ' (2-byte 14-bit LE encoding)'}`);
  let answered = 0;
  let named = 0;
  const silent: number[] = [];
  try {
    for (const n of nums) {
      const payload = o.oneByte ? [n & 0x7f] : encode14(n);
      const frame = envelope(o.model, FN_GET_CAB_NAME, payload);
      let frames: number[][] = [];
      try {
        frames = await session.transport.request(frame, { timeoutMs: o.timeoutMs, quietMs: 60 });
      } catch (e) {
        log(`  cab ${String(n).padStart(4)}: TRANSPORT ERROR ${(e as Error)?.message ?? String(e)}`);
        continue;
      }
      const replies = frames.filter((f) => f[5] === FN_GET_CAB_NAME && f.length >= 8);
      if (replies.length === 0) {
        silent.push(n);
        continue;
      }
      for (const r of replies) {
        const name = decodeName(r);
        answered++;
        if (name) named++;
        log(`  cab ${String(n).padStart(4)}: ${name ? JSON.stringify(name) : '(empty name)'}   [${hex(r)}]`);
      }
    }
  } finally {
    await session.close();
  }

  log('');
  log(`summary: ${answered} answered, ${named} carried a name, ${silent.length} SILENT (no reply at all)`);
  if (silent.length) {
    log(`silent numbers (NOT "empty slot" — the device said nothing): ${silent.slice(0, 40).join(', ')}${silent.length > 40 ? ` … +${silent.length - 40}` : ''}`);
  }
  return answered > 0 ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
