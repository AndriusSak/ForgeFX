// decode-capture-slot-names — every per-slot `fn=0x01 sub=0x4B` exchange in a capture, paired and decoded to
// a NAME. This is the read §2.5c was chasing: the slot name is carried in the reply's 7-bit-repacked
// 32-character field (see decodeCabSlotName). It exists so a capture answers "what names does the unit hold"
// without touching the device at all.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readChunks, framesOf } from './scan-usb-capture.js';
import { decodeCabSlotName } from 'forgefx-midi/devices/gen3';

export function main(argv: string[]): number {
  const path = argv.find((a) => !a.startsWith('--'));
  if (!path) { console.log('usage: npx tsx scripts/decode-capture-slot-names.ts <capture.pcapng>'); return 2; }
  const { chunks } = readChunks(readFileSync(path));
  const { frames } = framesOf(chunks);
  // Pair by ORDER, not by walking timestamps: a request and its reply can share a timestamp, and the sort
  // then decides which looks first. The capture is a clean alternating conversation, so the Nth host frame
  // belongs with the Nth device frame — and a count mismatch is reported rather than silently mis-paired.
  const isFourB = (f: (typeof frames)[number]) => f.fn === 0x01 && f.bytes[6] === 0x4b;
  const fromHost = frames.filter((f) => isFourB(f) && (f.ep === 2 || f.ep === 0)).map((f) => f.bytes);
  const fromDevice = frames.filter((f) => isFourB(f) && f.ep !== 2 && f.ep !== 0).map((f) => f.bytes);
  if (fromHost.length !== fromDevice.length) {
    console.log(`WARNING: ${fromHost.length} host frames vs ${fromDevice.length} device frames for sub 0x4B — pairing is by order and may be wrong.`);
  }
  const rows: { index: number; page: number; flag: number; name: string | undefined }[] = [];
  for (let i = 0; i < Math.min(fromHost.length, fromDevice.length); i++) {
    const req = fromHost[i]!;
    const payload = fromDevice[i]!.slice(6, -2);
    rows.push({
      // The query carries [index, page] at payload offsets 6 and 7, i.e. frame offsets 12 and 13 — NOT a
      // 14-bit little-endian pair; reading it as one labels every slot with a plausible-looking wrong address.
      index: req[12] ?? 0,
      page: req[13] ?? 0,
      flag: payload[6] ?? -1,
      name: decodeCabSlotName(payload)
    });
  }
  const seen = new Set<string>();
  let named = 0;
  for (const r of rows) {
    const key = `${r.page}:${r.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const slot = r.page === 0x20 ? `S${String(r.index + 1).padStart(2, '0')}` : `U${String((r.page - 0x10) * 128 + r.index + 1).padStart(4, '0')}`;
    if (r.flag === 0x01) named++;
    console.log(`${slot}  page 0x${r.page.toString(16)} idx ${String(r.index).padStart(3)}  flag 0x${(r.flag & 0xff).toString(16).padStart(2, '0')}  ${r.flag === 0x01 ? 'populated' : r.flag === 0x7f ? 'empty    ' : 'UNKNOWN  '}  name ${JSON.stringify(r.name)}`);
  }
  console.log(`\n${seen.size} distinct slots in this capture · ${named} populated · decoder returned a string for all: ${rows.every((r) => r.name !== undefined)}`);
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
