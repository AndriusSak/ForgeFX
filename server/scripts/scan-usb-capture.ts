// ────────────────────────────────────────────────────────────────────────────────────────────────
// scan-usb-capture — read a USB capture of the FM3 and pull the Fractal SysEx conversation out of it.
//
// WHY: the only way to learn an undocumented opcode on this device is to capture FM3-Edit doing it.
// This turns such a capture into something readable: per-endpoint streams, then F0..F7 frames, with the
// request/reply pairing for the `fn=0x01` sub-action calls the editor lives on.
//
// WHAT IT IS CAREFUL ABOUT (each cost a wasted pass when it was got wrong):
//   • A SysEx frame SPANS SEVERAL URBs on this device, so frames are split out of each endpoint's
//     REASSEMBLED byte stream — never out of one packet.
//   • DIRECTION IS READ OFF THE DATA, not assumed from the pseudo-header's info bit. Interleaved
//     request/reply pairs and the `fn=0x64` acks make it obvious which endpoint answers; an assumption
//     here silently inverts everything.
//   • The stream is ordered by TIMESTAMP before anything is interpreted, because pcapng write order is
//     not conversation order.
//   • It REPORTS and does not interpret: fn byte, length, raw hex, ASCII runs. Opcode meaning is
//     established elsewhere (see the stack's device notes); nothing is inferred here.
//
// USAGE
//   npx tsx scripts/scan-usb-capture.ts <file.pcapng>                    # streams + fn histogram + ASCII
//   npx tsx scripts/scan-usb-capture.ts <file.pcapng> --pair 0x4b 8      # 8 request/reply pairs for fn=0x01 sub=0x4B
//   npx tsx scripts/scan-usb-capture.ts <file.pcapng> --window 0x7a      # 12 frames either side of each fn=0x7A
//   npx tsx scripts/scan-usb-capture.ts <file.pcapng> --septets          # also try the container's 4-chars-per-5-septets text packing
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const LINKTYPE_USBPCAP = 249;
const LINKTYPE_USBMON_MMAPPED = 220;
const LINKTYPE_USBMON = 189;

interface Frame {
  ts: number;
  ep: number;
  fn: number;
  bytes: number[];
}

const hex = (b: readonly number[], n = 48) =>
  b.slice(0, n).map((x) => x.toString(16).padStart(2, '0')).join(' ') + (b.length > n ? ` ...(${b.length})` : '');
const ascii = (b: readonly number[]) => b.map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.')).join('.');

/** 32 bits packed as 5 LSB-first 7-bit bytes → 4 characters (the IR container's text packing). */
function septetText(b: readonly number[], start = 0): string {
  let out = '';
  for (let i = start; i + 5 <= b.length; i += 5) {
    const v = (b[i]! | (b[i + 1]! << 7) | (b[i + 2]! << 14) | (b[i + 3]! << 21) | (b[i + 4]! << 28)) >>> 0;
    out += [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
      .map((c) => (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.'))
      .join('');
  }
  return out;
}

/** Parse a pcapng byte stream into (timestamp, endpoint, payload) chunks. */
export function readChunks(buf: Buffer): { linktypes: number[]; chunks: { ts: number; ep: number; info: number; payload: Buffer }[] } {
  const linktypes: number[] = [];
  const chunks: { ts: number; ep: number; info: number; payload: Buffer }[] = [];
  let off = 0;
  while (off + 12 <= buf.length) {
    const type = buf.readUInt32LE(off);
    const len = buf.readUInt32LE(off + 4);
    if (len < 12 || off + len > buf.length) break;
    if (type === 0x00000001) {
      linktypes.push(buf.readUInt16LE(off + 8));
    } else if (type === 0x00000006) {
      const iface = buf.readUInt32LE(off + 8);
      const ts = buf.readUInt32LE(off + 12) * 2 ** 32 + buf.readUInt32LE(off + 16);
      const capLen = buf.readUInt32LE(off + 20);
      const data = buf.subarray(off + 28, off + 28 + capLen);
      const lt = linktypes[iface];
      if (lt === LINKTYPE_USBPCAP && data.length >= 27) {
        const headerLen = data.readUInt16LE(0);
        chunks.push({ ts, ep: data[21]!, info: data[16]!, payload: data.subarray(Math.min(headerLen, data.length)) });
      } else if ((lt === LINKTYPE_USBMON_MMAPPED || lt === LINKTYPE_USBMON) && data.length >= 48) {
        const hdr = lt === LINKTYPE_USBMON_MMAPPED ? 64 : 48;
        const ep = data[10]!;
        chunks.push({ ts, ep: ep & 0x7f, info: ep & 0x80 ? 1 : 0, payload: data.subarray(hdr) });
      }
    }
    off += len;
  }
  return { linktypes, chunks };
}

/** Split each endpoint's reassembled, timestamp-ordered stream into F0..F7 frames. */
export function framesOf(chunks: { ts: number; ep: number; payload: Buffer }[]): { frames: Frame[]; perEndpoint: Map<number, number> } {
  const byEp = new Map<number, { ts: number; bytes: number[] }[]>();
  for (const c of chunks) {
    if (!byEp.has(c.ep)) byEp.set(c.ep, []);
    byEp.get(c.ep)!.push({ ts: c.ts, bytes: [...c.payload] });
  }
  const frames: Frame[] = [];
  const perEndpoint = new Map<number, number>();
  for (const [ep, parts] of byEp) {
    parts.sort((a, b) => a.ts - b.ts);
    const stream: number[] = [];
    for (const p of parts) stream.push(...p.bytes);
    let i = 0;
    let count = 0;
    while (i < stream.length) {
      if (stream[i] !== 0xf0) {
        i++;
        continue;
      }
      const end = stream.indexOf(0xf7, i);
      if (end < 0) break;
      const bytes = stream.slice(i, end + 1);
      frames.push({ ts: parts[0]!.ts, ep, fn: bytes[5] ?? -1, bytes });
      count++;
      i = end + 1;
    }
    perEndpoint.set(ep, count);
  }
  frames.sort((a, b) => a.ts - b.ts);
  return { frames, perEndpoint };
}

export function main(argv: string[]): number {
  const path = argv.find((a) => !a.startsWith('--'));
  if (!path) {
    console.log('usage: npx tsx scripts/scan-usb-capture.ts <file.pcapng> [--pair <sub-hex> [n]] [--window <fn-hex>] [--septets]');
    return 2;
  }
  const withSeptets = argv.includes('--septets');
  const buf = readFileSync(path);
  const { linktypes, chunks } = readChunks(buf);
  const { frames, perEndpoint } = framesOf(chunks);
  console.log(`file ${path} (${buf.length} bytes) · linktypes ${linktypes.join(',')} · packets ${chunks.length} · frames ${frames.length}`);
  console.log(`per endpoint: ${[...perEndpoint.entries()].map(([ep, n]) => `ep ${ep}: ${n} frames`).join(', ')}`);

  // Which endpoint answers? Read it off interleaving rather than trusting a header bit: the endpoint
  // that carries a reply immediately after another endpoint's request is the one that responds.
  const eps = [...perEndpoint.keys()].sort((a, b) => a - b);
  if (eps.length >= 2) {
    const [a, b] = eps;
    let aThenB = 0;
    let bThenA = 0;
    for (let i = 1; i < frames.length; i++) {
      if (frames[i - 1]!.ep === a && frames[i]!.ep === b) aThenB++;
      if (frames[i - 1]!.ep === b && frames[i]!.ep === a) bThenA++;
    }
    console.log(`interleaving: ep ${a}→${b} ${aThenB}, ep ${b}→${a} ${bThenA}  (the larger is request→reply; verify against the payloads)`);
  }

  const byFn = new Map<number, Frame[]>();
  for (const f of frames) {
    if (!byFn.has(f.fn)) byFn.set(f.fn, []);
    byFn.get(f.fn)!.push(f);
  }
  console.log('\nfn histogram (per direction — report, not interpret):');
  for (const [fn, group] of [...byFn.entries()].sort((x, y) => x[0] - y[0])) {
    const perEp = [...new Set(group.map((g) => g.ep))].sort((x, y) => x - y);
    const lens = [...new Set(group.map((g) => g.bytes.length))].sort((x, y) => x - y);
    console.log(`  0x${fn.toString(16).padStart(2, '0')}: ${String(group.length).padStart(5)} frame(s) on ep ${perEp.join('/')} - lengths ${lens.join(',')}`);
  }

  const pairSub = argv.indexOf('--pair');
  if (pairSub >= 0) {
    const sub = Number(argv[pairSub + 1] ?? '0');
    const want = Number(argv[pairSub + 2] ?? 5);
    const requests = frames.filter((f) => f.fn === 0x01 && f.bytes[6] === sub);
    console.log(`\nfn=0x01 sub=0x${sub.toString(16)}: ${requests.length} request(s); showing ${want} with the next reply on the other endpoint:`);
    for (const req of requests.slice(0, want)) {
      const idx = frames.indexOf(req);
      const reply = frames.slice(idx + 1).find((f) => f.ep !== req.ep);
      console.log(`  req  ep ${req.ep} ${hex(req.bytes, 24)}`);
      if (reply) {
        const payload = reply.bytes.slice(6, -2);
        console.log(`  rep  ep ${reply.ep} len ${reply.bytes.length}: ${hex(reply.bytes, 32)}`);
        console.log(`       ascii  ${JSON.stringify(ascii(payload).slice(0, 96))}`);
        if (withSeptets) console.log(`       septets ${JSON.stringify(septetText(payload, 0).slice(0, 64))} | from+8 ${JSON.stringify(septetText(payload, 8).slice(0, 64))}`);
      } else {
        console.log('  (no reply found)');
      }
    }
  }

  const win = argv.indexOf('--window');
  if (win >= 0) {
    const fn = Number(argv[win + 1] ?? '0');
    const spans = frames.map((f, i) => (f.fn === fn ? i : -1)).filter((i) => i >= 0);
    console.log(`\nfn=0x${fn.toString(16)} appears at ${spans.length} position(s) of ${frames.length}`);
    for (const at of spans.slice(0, 3)) {
      console.log(`\n-- window around position ${at} --`);
      for (let i = Math.max(0, at - 6); i < Math.min(frames.length, at + 14); i++) {
        const f = frames[i]!;
        const body = f.bytes.length <= 32 ? hex(f.bytes) : `len ${f.bytes.length} ${hex(f.bytes, 12)}`;
        console.log(`  ${i === at ? '>>' : '  '} ep ${String(f.ep).padStart(3)} fn=0x${f.fn.toString(16).padStart(2, '0')} ${body}`);
      }
    }
  }

  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
