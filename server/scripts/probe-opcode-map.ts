// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-opcode-map — READ-CLASS instrument: which function bytes does this FM3 actually implement,
// and which payload SHAPES does it recognise for the blob-transfer opcodes around 0x7A/0x7B/0x7C?
//
// WHY: the §2.5 IR-upload load test drew a specific refusal per frame (`fn=0x7A` → result 0x16,
// `fn=0x7B` → result 0x10 "bad message length", `fn=0x7C` likewise) rather than "message not
// recognized". That means those function bytes EXIST on gen-3 and were rejected for their payload —
// so the useful question is not "is 0x7B the IR opcode" but "what shape does 0x7B want, and what else
// is implemented here at all". This maps that, and it is the cheap experiment before a USB capture.
//
// SAFE BY CONSTRUCTION:
//   • `--mode map` sends every function byte with an EMPTY payload. An empty payload cannot carry a
//     value, a preset number or a data block, so nothing can be stored — the worst case is a refusal.
//     A short list of functions whose empty form could still have a visible side effect is SKIPPED and
//     the list is printed, so the gaps in the map are explicit rather than silently missing.
//   • `--mode shapes` varies only the LENGTH/shape of the blob-transfer opcodes. No close/commit frame
//     is ever fabricated, so no transfer can complete; the dummy bytes cannot become an IR.
//   • DRY RUN BY DEFAULT: prints exactly what it will send and exits 4. `--go` sends.
//   • It LISTENS: every reply is collected and classified (see CLASSIFICATION).
//
// CLASSIFICATION (calibrated on this device 2026-10-08):
//   DATA REPLY      the function answered with its own function byte + payload → implemented, and it
//                   did the work. This is the only class that means "accepted".
//   RECOGNIZED      ONE 0x64 echoing the fn with a result code → the fn exists and rejected this
//                   request (result codes are AxeEdit III's MIDI_ERROR_* table).
//   NOT-RECOGNIZED  TWO 0x64 frames (0x01 then 0x00) → the framing was bad / the fn is not handled.
//   SILENT          no reply at all → the unit ignored it; NOT the same as acceptance.
//
// USAGE
//   npx tsx scripts/probe-opcode-map.ts                    # dry run, map mode
//   npx tsx scripts/probe-opcode-map.ts --go               # send the empty-payload sweep
//   npx tsx scripts/probe-opcode-map.ts --go --mode shapes  # payload-shape variants for 0x7A/0x7B
//   npx tsx scripts/probe-opcode-map.ts --go --from 0x70 --to 0x7f
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { fractalChecksum } from 'forgefx-midi/shared';
import { describeMultipurposeResultCode } from 'forgefx-midi/gen3/axe-fx-iii';

const MFR = [0x00, 0x01, 0x74] as const;
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');

/**
 * Functions whose EMPTY-payload form could still have a visible side effect on the unit, with the
 * reason. Skipped in `map` mode and printed, so a missing row is never mistaken for "not implemented".
 */
const SKIP: Record<number, string> = {
  0x0c: 'scene select — could change the active scene',
  0x10: 'tempo TAP — would tap the tempo',
  0x11: 'tuner on/off — could open the tuner display',
  0x3d: 'preset recall — could switch preset',
  0x40: 'IR-capture control (gen-2 semantics)',
  0x41: 'DELETE CAB IR (gen-2 semantics) — never send blind',
  0x42: 'editor disconnect — would drop a session',
  0x7d: 'firmware-update start (gen-2 semantics)',
  0x7e: 'firmware-update data (gen-2 semantics)',
};

function envelope(model: number, fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, ...MFR, model, fn, ...payload];
  return [...body, fractalChecksum(body), 0xf7];
}

type Klass = 'DATA REPLY' | 'RECOGNIZED' | 'NOT-RECOGNIZED' | 'SILENT';

interface Row {
  label: string;
  fn: number;
  sent: number[];
  klass: Klass;
  results: string[];
  reply: string;
}

function classify(frames: readonly number[][], fn: number): { klass: Klass; results: string[]; reply: string } {
  if (!frames.length) return { klass: 'SILENT', results: [], reply: '' };
  const own = frames.filter((f) => f[5] === fn);
  if (own.length) {
    return { klass: 'DATA REPLY', results: [], reply: own.map(hex).join('  |  ').slice(0, 200) };
  }
  const rej = frames.filter((f) => f[5] === 0x64);
  const results = rej.map((f) => describeMultipurposeResultCode(f[7] ?? 0) ?? `code 0x${(f[7] ?? 0).toString(16)}`);
  return { klass: rej.length > 1 ? 'NOT-RECOGNIZED' : 'RECOGNIZED', results, reply: rej.map(hex).join('  |  ') };
}

/** 0x7A start-frame shapes: the measured export's, the gen-2 form, and structural variants around them. */
function startShapes(): { label: string; payload: number[] }[] {
  return [
    { label: 'empty', payload: [] },
    { label: 'gen-2 form 20 00 10', payload: [0x20, 0x00, 0x10] },
    { label: 'export form 7f 7f 00 10', payload: [0x7f, 0x7f, 0x00, 0x10] },
    { label: 'export minus tail 7f 7f 00', payload: [0x7f, 0x7f, 0x00] },
    { label: 'target only 7f 7f', payload: [0x7f, 0x7f] },
    { label: 'zero target 00 00 00 10', payload: [0x00, 0x00, 0x00, 0x10] },
    { label: 'slot 1 msb 00 01 00 10', payload: [0x00, 0x01, 0x00, 0x10] },
    { label: 'slot 1 lsb 01 00 00 10', payload: [0x01, 0x00, 0x00, 0x10] },
    { label: 'tail only 00 10', payload: [0x00, 0x10] },
    { label: '0x10 only', payload: [0x10] },
    { label: 'gen-2 + zero 20 00 10 00', payload: [0x20, 0x00, 0x10, 0x00] },
    { label: 'gen-2 short 20 00', payload: [0x20, 0x00] },
  ];
}

/** 0x7B data-frame shapes: payload LENGTH is what the device complained about (result 0x10). */
function dataShapes(): { label: string; payload: number[] }[] {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => i & 0x7f);
  return [
    { label: 'empty', payload: [] },
    { label: '2 bytes (gen-2 prefix only)', payload: [0x20, 0x00] },
    { label: '3 bytes', payload: mk(3) },
    { label: '34 bytes', payload: mk(34) },
    { label: '66 bytes', payload: mk(66) },
    { label: '98 bytes', payload: mk(98) },
    { label: '130 bytes', payload: mk(130) },
    { label: '162 bytes (gen-2 32-chunk)', payload: [0x20, 0x00, ...mk(160)] },
    { label: '258 bytes (64-chunk)', payload: [0x00, 0x02, ...mk(256)] },
    { label: '514 bytes (128-chunk)', payload: [0x00, 0x02, ...mk(512)] },
    { label: '1026 bytes (256-chunk, no prefix)', payload: mk(1026) },
    { label: `1282 bytes (the export's own)`, payload: [0x00, 0x02, ...mk(1280)] },
  ];
}

/** Cab-number-addressed probes: the two function bytes whose EMPTY-payload reply differed from their
 *  neighbours in a cab-specific way (0x75, 0x78), plus the rest of the neighbourhood for contrast.
 *  If this firmware has a cab-name READ opcode, one of these should answer with a data reply carrying
 *  ASCII — which is exactly the oracle §2.5 lacks. Nothing here writes data: every payload is a bare
 *  cab number in a different encoding. */
function cabProbes(): { label: string; fn: number; payload: number[] }[] {
  const fns = [0x75, 0x78, 0x74, 0x76, 0x79, 0x7a, 0x7b, 0x7c, 0x12, 0x44];
  const encodings: { label: string; enc: (n: number) => number[] }[] = [
    { label: '1-byte', enc: (n) => [n & 0x7f] },
    { label: '14-bit lsb', enc: (n) => [n & 0x7f, (n >> 7) & 0x7f] },
    { label: '14-bit msb', enc: (n) => [(n >> 7) & 0x7f, n & 0x7f] },
  ];
  const out: { label: string; fn: number; payload: number[] }[] = [];
  for (const fn of fns) {
    for (const n of [1, 1024]) {
      for (const e of encodings) {
        out.push({ label: `0x${fn.toString(16)} cab ${n} ${e.label}`, fn, payload: e.enc(n) });
      }
    }
  }
  return out;
}

export async function main(argv: string[], log: (l: string) => void = console.log): Promise<number> {
  let go = false;
  let mode: 'map' | 'shapes' | 'cab' = 'map';
  let from = 0x00;
  let to = 0x7f;
  let port: string | undefined;
  let model = 0x11;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--go') go = true;
    else if (a === '--mode') mode = (argv[++i] as 'map' | 'shapes' | 'cab') ?? 'map';
    else if (a === '--from') from = Number(argv[++i]);
    else if (a === '--to') to = Number(argv[++i]);
    else if (a === '--port') port = argv[++i];
    else if (a === '-h' || a === '--help') { log('see the header of scripts/probe-opcode-map.ts'); return 0; }
    else { log(`unknown argument ${a}`); return 2; }
  }

  const plan: { label: string; fn: number; payload: number[] }[] = [];
  if (mode === 'map') {
    for (let fn = from; fn <= to; fn++) {
      if (fn in SKIP) continue;
      plan.push({ label: `fn 0x${fn.toString(16).padStart(2, '0')}`, fn, payload: [] });
    }
  } else if (mode === 'cab') {
    for (const p of cabProbes()) plan.push(p);
  } else {
    for (const s of startShapes()) plan.push({ label: `0x7A ${s.label}`, fn: 0x7a, payload: s.payload });
    for (const s of dataShapes()) plan.push({ label: `0x7B ${s.label}`, fn: 0x7b, payload: s.payload });
  }

  log(`mode ${mode} · ${plan.length} frame(s) planned · model 0x${model.toString(16)}`);
  if (mode === 'map' && Object.keys(SKIP).length) {
    log('skipped (empty-payload form could have a side effect, so the map has these holes):');
    for (const [fn, why] of Object.entries(SKIP)) log(`  0x${Number(fn).toString(16).padStart(2, '0')}  ${why}`);
  }
  log('nothing is stored by this instrument: map mode sends EMPTY payloads, shapes mode never fabricates a');
  log('close/commit frame, and no real IR data is used.');

  if (!go) {
    log('');
    for (const p of plan.slice(0, 40)) log(`  would send: ${p.label.padEnd(34)} ${hex(envelope(model, p.fn, p.payload))}`);
    if (plan.length > 40) log(`  … +${plan.length - 40} more`);
    log('');
    log('DRY RUN — nothing was sent. Re-run with --go.');
    return 4;
  }

  const opened = await openProbeSession(model, port);
  if (!opened.ok) {
    log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`);
    return 3;
  }
  const s = opened.session;
  log(`device ${s.label}`);
  log('');

  const rows: Row[] = [];
  for (const p of plan) {
    const frame = envelope(model, p.fn, p.payload);
    let frames: number[][] = [];
    try {
      frames = await s.transport.request(frame, { timeoutMs: 600, quietMs: 60 });
    } catch (e) {
      log(`  ${p.label}: TRANSPORT ERROR ${(e as Error).message}`);
      continue;
    }
    const { klass, results, reply } = classify(frames, p.fn);
    rows.push({ ...p, sent: frame, klass, results, reply });
    const note = results.length ? `  ← ${results.join(' / ')}` : '';
    log(`  ${p.label.padEnd(34)} ${klass.padEnd(15)}${note}${klass === 'DATA REPLY' ? `  ${reply}` : ''}`);
  }
  await s.close();

  // The summary is the point: only DATA REPLY means the request was actually served.
  const byKlass = (k: Klass) => rows.filter((r) => r.klass === k);
  log('');
  log('── summary ──');
  for (const k of ['DATA REPLY', 'RECOGNIZED', 'NOT-RECOGNIZED', 'SILENT'] as Klass[]) {
    const list = byKlass(k);
    log(`${k.padEnd(15)} ${String(list.length).padStart(3)}  ${list.map((r) => (mode === 'map' ? `0x${r.fn.toString(16).padStart(2, '0')}` : r.label)).join(', ')}`);
  }
  log('');
  log('Reading it: RECOGNIZED rows are function bytes this firmware implements (the result code says');
  log('what it disliked); a row whose result code CHANGES between shapes in shapes mode is a length it');
  log('did not mind — that is how the real blob frame size would show up. SILENT is not acceptance.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
