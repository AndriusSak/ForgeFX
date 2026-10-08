// ────────────────────────────────────────────────────────────────────────────────────────────────
// try-preset-write — does the UNIT accept a HOST-WRITTEN preset dump? The one unmeasured step.
//
// WHY THE EDIT BUFFER: the write is aimed at the edit-buffer sentinel (0x3FFF), NOT at a stored preset
// slot. A rejected or mangled write therefore cannot touch a saved preset, and the state is transient:
// reloading the preset from its slot discards whatever is in the edit buffer.
//
// WHAT IT DOES: dump the edit buffer → decompress → parse the perform page → patch slot 1's eid/pid AND
// its labels → recompress + rebuild the dump → retarget the header to the edit buffer → SEND it → wait →
// dump the edit buffer again → compare. The comparison is the measurement; a rejection is reported as a
// rejection, not as a failure to try.
//
// SAFETY: one target (the edit buffer), one field pair, nothing saved. A frame tap is written by
// openProbeSession. If the device accepts it, the edit buffer will differ from the stored preset and
// reloading the preset clears it.
//
// USAGE  npx tsx scripts/try-preset-write.ts [--eid 62 --pid 41]
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import {
  parsePresetDump, decodeRawPatch, reencodeRawPatch, reencodeDumpFromRawPatch,
  parsePerformPage, patchPerformSlot, retargetPresetDumpToEditBuffer
} from 'forgefx-midi/devices/gen3';

const EDIT_BUFFER = 0x3fff;
const hex = (b: readonly number[]) => b.slice(0, 24).map((x) => x.toString(16).padStart(2, '0')).join(' ');

export async function main(argv: string[]): Promise<number> {
  const argOf = (n: string, d: number): number => { const i = argv.indexOf(n); return i >= 0 ? Number(argv[i + 1]) : d; };
  const newEid = argOf('--eid', 62);
  const newPid = argOf('--pid', 41);
  const argS = (n: string, d: string): string => { const i = argv.indexOf(n); return i >= 0 ? (argv[i + 1] ?? d) : d; };
  const newEffectLabel = argS('--effect-label', 'CAB');
  const newParamLabel = argS('--param-label', 'Proximity Frequ');
  const opened = await openProbeSession(0x11);
  if (!opened.ok) { console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`); return 3; }
  const { session } = opened;
  const dump = async (): Promise<number[]> => {
    const frames = await session.transport.request(session.codec.buildRequestPresetDump(EDIT_BUFFER), {
      timeoutMs: 8000, quietMs: 300, match: (fs) => fs.some((f) => f[5] === 0x79)
    });
    if (!frames.some((f) => f[5] === 0x79)) throw new Error(`incomplete dump (${frames.length} frames, no 0x79)`);
    return frames.flat();
  };
  /** Split a byte stream back into F0..F7 frames. */
  const frames = (bytes: readonly number[]): number[][] => {
    const out: number[][] = [];
    let i = 0;
    while (i < bytes.length) {
      if (bytes[i] !== 0xf0) { i++; continue; }
      const end = bytes.indexOf(0xf7, i);
      if (end < 0) break;
      out.push(bytes.slice(i, end + 1));
      i = end + 1;
    }
    return out;
  };
  try {
    console.log('1. dumping the EDIT BUFFER (0x3FFF) as it stands …');
    const before = await dump();
    const dec = decodeRawPatch(parsePresetDump(new Uint8Array(before)).chunkPayloads) as unknown as { rawPatch: Uint8Array; body: Uint8Array };
    const pageBefore = parsePerformPage(dec.body);
    console.log(`   ${before.length} bytes · body ${dec.body.length} B · page slot 1: ${pageBefore ? `eid ${pageBefore.slots[0]!.effectId} pid ${pageBefore.slots[0]!.paramId} ${JSON.stringify(pageBefore.slots[0]!.paramLabel)}` : 'none'}`);

    console.log(`2. patching slot 1 → eid ${newEid} pid ${newPid} (tables AND labels) …`);
    const body = new Uint8Array(dec.body);
    if (!patchPerformSlot(body, 1, { effectId: newEid, paramId: newPid, effectLabel: newEffectLabel, paramLabel: newParamLabel })) {
      console.log('   patch refused — no page in this body'); return 1;
    }
    const rebuilt = reencodeDumpFromRawPatch(new Uint8Array(before), reencodeRawPatch(dec.rawPatch, body));
    const stream = Array.from(rebuilt);
    if (!retargetPresetDumpToEditBuffer(stream)) { console.log('   could not retarget the dump header'); return 1; }
    const outFrames = frames(stream);
    console.log(`3. rebuilt ${rebuilt.length} bytes in ${outFrames.length} frames, retargeted to the edit buffer; sending …`);
    for (const f of outFrames) {
      if (session.transport.sendPaced) await session.transport.sendPaced(f, 64, 4);
      else await session.transport.sendQueued(f, 4);
    }
    await new Promise((r) => setTimeout(r, 1500));

    console.log('4. re-dumping the edit buffer …');
    const after = await dump();
    const decAfter = decodeRawPatch(parsePresetDump(new Uint8Array(after)).chunkPayloads) as unknown as { body: Uint8Array };
    const pageAfter = parsePerformPage(decAfter.body);
    const s = pageAfter?.slots[0];
    console.log(`   ${after.length} bytes · page slot 1: ${s ? `eid ${s.effectId} pid ${s.paramId} ${JSON.stringify(s.paramLabel)}` : 'none'}`);
    const accepted = !!s && s.effectId === newEid && s.paramId === newPid;
    console.log('');
    console.log(accepted
      ? 'ACCEPTED — the unit took a HOST-WRITTEN, host-recompressed dump. The write direction is real.'
      : `NOT ACCEPTED — the edit buffer does not show the patch (slot 1 reads ${s ? `eid ${s.effectId} pid ${s.paramId}` : 'no page'}). The device ignored or refused a host-written dump; that is a result, not a failure.`);
    console.log(`   first bytes of what the device now holds: ${hex(after)}`);
    console.log('   nothing was saved: reload the preset to discard the edit buffer.');
    return accepted ? 0 : 1;
  } finally {
    await session.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
