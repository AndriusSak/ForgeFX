// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-cab-oracle — READ-ONLY: (1) prove the frame builder against a KNOWN-GOOD opcode, then
// (2) try the candidate GET_CAB_NAME shapes. Nothing is written.
//
// The control matters more than the probe: fn 0x0D (QUERY PATCH NAME, documented in the gen-3
// third-party spec AND already implemented in the codec) goes out through the SAME envelope helper.
// If 0x0D answers with a preset name and 0x12 stays silent, the silence is a property of the DEVICE,
// not of our framing. That is the whole point of running the control first.
//
// USAGE: npx tsx scripts/probe-cab-oracle.ts [--port /dev/ttyACM0] [--model fm3]
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { fractalChecksum } from 'forgefx-midi/shared';
import { describeMultipurposeResultCode } from 'forgefx-midi/gen3/axe-fx-iii';

const MFR = [0x00, 0x01, 0x74] as const;

function envelope(modelByte: number, fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, ...MFR, modelByte, fn, ...payload];
  return [...body, fractalChecksum(body), 0xf7];
}
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const ascii = (b: readonly number[]) =>
  b.map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.')).join('');

export async function main(argv: string[]): Promise<number> {
  let model = 0x11;
  let port: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') port = argv[++i];
    else if (argv[i] === '--model') model = { fm3: 0x11, fm9: 0x12, axe3: 0x10 }[argv[++i] ?? ''] ?? 0x11;
  }
  const opened = await openProbeSession(model, port);
  if (!opened.ok) {
    console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`);
    return 3;
  }
  const s = opened.session;
  console.log(`device: ${s.label} (model 0x${model.toString(16)}) — READ-ONLY\n`);

  interface Case {
    what: string;
    frame: number[];
    /** fn byte a reply must carry for us to call it an answer. */
    replyFn: number;
    /** When set, the frame is emitted with this checksum byte instead (calibration only). */
    forceChecksum?: number;
  }
  const badCs = (frame: number[]): number[] => {
    const out = [...frame];
    out[out.length - 2] = (out[out.length - 2]! + 1) & 0x7f;
    return out;
  };
  const cases: Case[] = [
    // CONTROL — documented, known-good. A reply here proves the envelope + the port are right.
    { what: 'CONTROL fn=0x0D QUERY PATCH NAME (current)', frame: envelope(model, 0x0d, [0x7f, 0x7f]), replyFn: 0x0d },
    { what: 'CALIBRATION fn=0x0D with a DELIBERATELY BAD checksum', frame: badCs(envelope(model, 0x0d, [0x7f, 0x7f])), replyFn: 0x0d },
    { what: 'CONTROL fn=0x13 STATUS DUMP', frame: envelope(model, 0x13, []), replyFn: 0x13 },
    // CANDIDATES — GET_CAB_NAME shapes.
    { what: 'fn=0x12 cab 1 (1 byte)', frame: envelope(model, 0x12, [0x01]), replyFn: 0x12 },
    { what: 'fn=0x12 cab 1 (2 bytes 14-bit LE)', frame: envelope(model, 0x12, [0x01, 0x00]), replyFn: 0x12 },
    { what: 'fn=0x12 cab 1 (0x20 0x00 prefix + 2 bytes)', frame: envelope(model, 0x12, [0x20, 0x00, 0x01, 0x00]), replyFn: 0x12 },
    { what: 'fn=0x12 cab 1025 (2 bytes)', frame: envelope(model, 0x12, [0x01, 0x08]), replyFn: 0x12 },
    { what: 'fn=0x12 cab 1 (0x7F sentinel = "current"?)', frame: envelope(model, 0x12, [0x7f]), replyFn: 0x12 },
    { what: 'CALIBRATION fn=0x12 with a DELIBERATELY BAD checksum', frame: badCs(envelope(model, 0x12, [0x01])), replyFn: 0x12 },
    { what: 'CONTROL fn=0x0E QUERY SCENE NAME (current)', frame: envelope(model, 0x0e, [0x7f]), replyFn: 0x0e },
  ];

  try {
    for (const c of cases) {
      console.log(`── ${c.what}`);
      console.log(`   sent: ${hex(c.frame)}`);
      let frames: number[][] = [];
      try {
        frames = await s.transport.request(c.frame, { timeoutMs: 900, quietMs: 80 });
      } catch (e) {
        console.log(`   TRANSPORT ERROR ${(e as Error)?.message ?? String(e)}`);
        continue;
      }
      if (!frames.length) {
        console.log('   reply: NONE (silent)');
        continue;
      }
      for (const f of frames) {
        const isFn = f[5] === c.replyFn;
        const note = f[5] === 0x64
          ? `  ← 0x64 MULTIPURPOSE: echoed fn 0x${(f[6] ?? 0).toString(16)}, result ${describeMultipurposeResultCode(f[7] ?? 0) ?? `0x${(f[7] ?? 0).toString(16)}`}`
          : '';
        console.log(`   reply${isFn ? '' : ' (other fn)'}: ${hex(f)}   |${ascii(f)}|${note}`);
      }
      console.log('');
    }
  } finally {
    await s.close();
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
