// ────────────────────────────────────────────────────────────────────────────────────────────────
// perform-write-roundtrip — prove a perform-page WRITE in the byte domain, with no device involved.
//
// The page's tables are FIXED SIZE (10 x u16 eids + 10 x u16 pids = 40 bytes), so a change is a
// length-preserving patch of the DECOMPRESSED body. This does the full loop:
//   dump bytes → decompress → parse the page → PATCH a slot → recompress → rebuild the dump
//   → decompress that dump again → parse the page again → assert the patch survived
// and it re-checks the body CRC on the rebuilt dump. If the loop closes, the BYTES are writable; whether
// the unit accepts a host-written dump is a separate question this script deliberately does not answer.
//
// USAGE  npx tsx scripts/perform-write-roundtrip.ts <preset.bin> [--slot N --eid E --pid P]
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parsePresetDump, decodeRawPatch, reencodeRawPatch, reencodeDumpFromRawPatch, parsePerformPage, patchPerformSlot } from 'forgefx-midi/devices/gen3';

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);

export function main(argv: string[]): number {
  const file = argv.find((a) => !a.startsWith('--'));
  const argOf = (n: string, d: number): number => { const i = argv.indexOf(n); return i >= 0 ? Number(argv[i + 1]) : d; };
  if (!file) { console.log('usage: npx tsx scripts/perform-write-roundtrip.ts <preset.bin> [--slot N --eid E --pid P]'); return 2; }
  const slot = argOf('--slot', 1) - 1;
  const newEid = argOf('--eid', 62);   // default: point slot 1 at the Cab block
  const newPid = argOf('--pid', 41);   // and at its proximity frequency — a target we can verify by eye
  const argS = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const effectLabel = argS('--effect-label');
  const paramLabel = argS('--param-label');
  const dump = new Uint8Array(readFileSync(file.replace('~', process.env.HOME ?? '')));

  const parsed = parsePresetDump(dump);
  const dec = decodeRawPatch(parsed.chunkPayloads) as unknown as { rawPatch: Uint8Array; body: Uint8Array; crcValid: boolean };
  console.log(`dump ${dump.length} B · body ${dec.body.length} B · stored-CRC valid: ${dec.crcValid}`);
  const before = parsePerformPage(dec.body)!;
  const at = before.at;
  console.log(`slot ${slot + 1} BEFORE: eid ${before.slots[slot]!.effectId} pid ${before.slots[slot]!.paramId} label ${JSON.stringify(before.slots[slot]!.paramLabel)}`);

  // ── the patch: length-preserving tables AND the label windows, together ──
  // The first run of this script patched the tables alone, which left the OLD label in place — a page that
  // passes every structural check and shows a stale name. patchPerformSlot writes both, and the labels are
  // truncated-and-NUL-padded to the 32-byte window rather than resized.
  const body = new Uint8Array(dec.body);
  const patched = patchPerformSlot(body, slot + 1, {
    effectId: newEid,
    paramId: newPid,
    effectLabel: effectLabel ?? 'CAB',
    paramLabel: paramLabel ?? 'Proximity Frequ'
  });
  if (!patched) { console.log('patch refused (no page, or slot out of range)'); return 1; }
  console.log(`patched to eid ${newEid} pid ${newPid} with labels ${JSON.stringify(effectLabel ?? 'CAB')} / ${JSON.stringify(paramLabel ?? 'Proximity Frequ')} (tables AND label windows)`);

  // ── recompress and rebuild the dump ──
  const newRaw = reencodeRawPatch(dec.rawPatch, body);
  console.log(`raw patch ${dec.rawPatch.length} → ${newRaw.length} B (recompressed)`);
  // reframe + CRC + footer xor are the AUTHOR path's job — do not hand-roll them here.
  const out = reencodeDumpFromRawPatch(dump, newRaw);
  writeFileSync('/home/insn/.hermes/cache/scratch/presets/patched.bin', Buffer.from(out));

  // ── read it back through the SAME path a consumer would use ──
  const re = parsePresetDump(new Uint8Array(readFileSync('/home/insn/.hermes/cache/scratch/presets/patched.bin')));
  const redec = decodeRawPatch(re.chunkPayloads) as unknown as { body: Uint8Array; crcValid: boolean };
  const after = parsePerformPage(redec.body);
  console.log(`rebuilt dump ${out.length} B · body ${redec.body.length} B · stored-CRC valid: ${redec.crcValid}`);
  if (!after) { console.log('ROUND TRIP FAILED: the rebuilt dump no longer parses as a page'); return 1; }
  const s = after.slots[slot]!;
  const ok = s.effectId === newEid && s.paramId === newPid;
  console.log(`slot ${slot + 1} AFTER : eid ${s.effectId} pid ${s.paramId} label ${JSON.stringify(s.paramLabel)}`);
  console.log(ok ? 'ROUND TRIP OK — the patch survives recompress + reframe and reads back.' : 'ROUND TRIP FAILED — the patch did not survive.');
  console.log('NOTE: this proves the BYTES. Whether the unit accepts a host-written dump is NOT tested here.');
  return ok ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
