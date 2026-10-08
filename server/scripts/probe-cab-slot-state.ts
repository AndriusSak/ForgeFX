// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-cab-slot-state — READ-ONLY: what does the device's own per-slot cab query say about a slot?
//
// WHY: §2.5's load test had no independent confirmation — fw 13 refuses GET_CAB_NAME (fn 0x12), so
// "the upload was accepted" rested on the upload's own acks. FM3-Edit's cab-list refresh turns out to
// answer that: `fn=0x01 sub=0x4B` takes the SAME `[index, page]` pair the IR upload's start frame takes
// (byte 12 = index, byte 13 = page; 0x10-0x13 user banks, 0x20 scratchpad) and answers a 60-byte reply.
//
// MEASURED FROM A CAPTURE OF THE EDITOR (refresh_cab.pcapng, 528 requests = 512 user + 16 scratchpad):
//   • payload byte 6 is 0x01 for a POPULATED slot and 0x7F for an empty one — 12 populated (U0001-U0012)
//     against 500 empty user slots + all 16 empty scratchpad slots, which shared one identical payload;
//   • the two slots the capture's upload wrote with the SAME IR (U0001, U0012) shared 50 of 52 payload
//     bytes — consistent with the varying region being CONTENT-DERIVED, though the encoding is NOT
//     decoded and no packing scheme tried yields the known name. So this is a POPULATED/FINGERPRINT
//     oracle, NOT a name oracle. Say "populated", never "holds <name>".
//
// NOTHING IS WRITTEN: read requests only, and the raw hex is printed before any interpretation.
//
// USAGE
//   npx tsx scripts/probe-cab-slot-state.ts                    # bank 1 slots 1-16 + 2 bank-2 slots + scratchpad 1
//   npx tsx scripts/probe-cab-slot-state.ts --scan             # all 528 slots (512 user + 16 scratchpad)
//   npx tsx scripts/probe-cab-slot-state.ts --slots 1,12,13,513
//   npx tsx scripts/probe-cab-slot-state.ts --port /dev/ttyACM0
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { decodeCabSlotName } from 'forgefx-midi/devices/gen3';
import { fractalChecksum } from 'forgefx-midi/shared';
import { cabIrUserSlot, cabIrScratchpad } from 'forgefx-midi/devices/gen3';

const FN_QUERY = 0x01;
const SUB_CAB_SLOT = 0x4b;
const PAGE_EMPTY_FLAG = 6; // payload offset of the populated flag
const POPULATED = 0x01;
const EMPTY = 0x7f;

function envelope(modelByte: number, fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, modelByte, fn, ...payload];
  return [...body, fractalChecksum(body), 0xf7];
}

/** The editor's request shape, verbatim: `fn=0x01 sub=0x4B`, then zeroes, then `[index, page]` at 12/13. */
function slotQuery(modelByte: number, index: number, page: number): number[] {
  return envelope(modelByte, FN_QUERY, [SUB_CAB_SLOT, 0x00, 0x00, 0x00, 0x00, 0x00, index, page, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
}

const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const payloadOf = (f: readonly number[]) => f.slice(6, f.length - 2);

interface Opts {
  port?: string;
  model: number;
  scan: boolean;
  slots: number[];
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = { model: 0x11, scan: false, slots: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--port') o.port = argv[++i];
    else if (a === '--model') o.model = Number(argv[++i]);
    else if (a === '--scan') o.scan = true;
    else if (a === '--slots') o.slots = argv[++i]!.split(',').map((s) => Number(s.trim()));
  }
  return o;
}

export async function main(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);
  const opened = await openProbeSession(opts.model, opts.port);
  if (!opened.ok) {
    console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`);
    return 3;
  }
  const { session } = opened;
  try {
    const targets: { label: string; index: number; page: number }[] = [];
    if (opts.scan) {
      for (let n = 1; n <= 512; n++) {
        const d = cabIrUserSlot(n);
        targets.push({ label: `U${d.page - 0x10}${String(d.index + 1).padStart(3, '0')}`, ...d });
      }
      for (let n = 1; n <= 16; n++) {
        const d = cabIrScratchpad(n);
        targets.push({ label: `S${String(n).padStart(2, '0')}`, ...d });
      }
    } else if (opts.slots.length) {
      for (const n of opts.slots) {
        const d = n > 512 ? cabIrScratchpad(n - 512) : cabIrUserSlot(n);
        targets.push({ label: n > 512 ? `S${String(n - 512).padStart(2, '0')}` : `U${d.page - 0x10}${String(d.index + 1).padStart(3, '0')}`, ...d });
      }
    } else {
      for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 129, 513]) {
        const d = n > 512 ? cabIrScratchpad(n - 512) : cabIrUserSlot(n);
        targets.push({ label: n > 512 ? `S${String(n - 512).padStart(2, '0')}` : `U${d.page - 0x10}${String(d.index + 1).padStart(3, '0')}`, ...d });
      }
    }

    console.log(`device: ${session.label} (model 0x${opts.model.toString(16)}) · querying ${targets.length} slot(s), READ-ONLY`);
    const rows: { label: string; state: string; payload?: number[] }[] = [];
    for (const t of targets) {
      let reply: number[][] = [];
      try {
        reply = await session.transport.request(slotQuery(opts.model, t.index, t.page), { timeoutMs: 700, quietMs: 60 });
      } catch (e) {
        rows.push({ label: t.label, state: `TRANSPORT ERROR ${(e as Error)?.message ?? String(e)}` });
        continue;
      }
      const f = reply.find((r) => r.length >= 60 && r[5] === FN_QUERY && r[6] === SUB_CAB_SLOT);
      if (!f) {
        rows.push({ label: t.label, state: 'SILENT' }); // silence is NOT "empty" on this device
        continue;
      }
      const p = payloadOf(f);
      const flag = p[PAGE_EMPTY_FLAG];
      const state = flag === POPULATED ? 'populated' : flag === EMPTY ? 'empty' : `unknown (flag 0x${flag?.toString(16)})`;
      rows.push({ label: t.label, state, payload: p });
    }

    console.log('\nslot   state        flag  payload (52B)');
    for (const r of rows) {
      const flag = r.payload ? `0x${r.payload[PAGE_EMPTY_FLAG]!.toString(16).padStart(2, '0')}` : '  - ';
      // The NAME is decoded from the reply (measured 2026-10-08) — show it, and only trust it for a
      // POPULATED slot: an empty slot's field holds the device's literal "<EMPTY>" plus stale bytes.
      const decoded = r.payload ? decodeCabSlotName(r.payload) : undefined;
      const name = decoded === undefined ? '' : r.state === 'populated' ? `  name "${decoded}"` : `  name field ${JSON.stringify(decoded)} (not a name — slot is ${r.state})`;
      console.log(`${r.label.padEnd(6)} ${r.state.padEnd(12)} ${flag}   ${r.payload ? hex(r.payload) : ''}${name}`);
    }
    const populated = rows.filter((r) => r.state === 'populated').length;
    const empty = rows.filter((r) => r.state === 'empty').length;
    const silent = rows.filter((r) => r.state === 'SILENT').length;
    console.log(`\nsummary: ${populated} populated · ${empty} empty · ${silent} silent`);
    console.log('NOTE: "populated" is a measured flag byte. The name shown above IS decoded from the reply (the field');
    console.log('      carries the 32-char name re-packed as 8-bit chars, MSB-first, into 7-bit septets, NUL-terminated).');
    console.log('      Only a POPULATED slot has a meaningful name: an empty slot holds the device literal "<EMPTY>" plus');
    console.log('      stale bytes, so an empty slot is never reported as holding a particular IR.');
    return 0;
  } finally {
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
