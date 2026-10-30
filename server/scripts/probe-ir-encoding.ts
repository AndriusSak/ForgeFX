// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-ir-encoding — WRITE (two IR slots, owner-authorised: unoccupied slots above 15).
//
// QUESTION: `cabIrConvert` encodes sample slots as little-endian IEEE-754 float32 — an ASSUMPTION (A1),
// because an impulse reads identically under float32 and int32 Q31 and the unit's close check validates
// bytes, not meaning. A NON-impulse IR discriminates them: encode the SAME wav both ways, upload each to
// its own free slot, and listen. One sounds like a cabinet; the other does not.
//
// WHAT IT DOES
//   • reads a WAV, converts it twice with `convertWavToCabIr` (float32 assumed vs int32 Q31),
//   • prints both containers' frame counts + close values (equal content ⇒ different words ⇒ different close),
//   • with --go, POSTs each to /cab/ir/upload?user=N&name=... (server on :5056), then reads both slots back
//     through /cab/slots?user=N to confirm POPULATED.
//
// WHAT IT DOES NOT CLAIM: that the upload "worked" beyond the unit's own acks and the slot-state flag.
// The only oracle for encoding is a person listening through the Cab block.
//
//   npx tsx scripts/probe-ir-encoding.ts /tmp/test-ir.wav 17 18        # dry run
//   npx tsx scripts/probe-ir-encoding.ts /tmp/test-ir.wav 17 18 --go
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { convertWavToCabIr, ASSUMED_FLOAT32_ENCODING, parseCabIrSyx, type CabIrSampleEncoding } from 'forgefx-midi/devices/gen3/cabIrConvert';

const SERVER = process.env.FORGEFX_SERVER ?? 'http://127.0.0.1:5056';

const buf = new ArrayBuffer(4);
const f32 = new Float32Array(buf);
const i32 = new Int32Array(buf);

/** The rival hypothesis: every slot is a signed Q31 fixed-point sample in [-1, 1). */
const Q31_ENCODING: CabIrSampleEncoding = {
  id: 'int32-q31',
  label: 'int32 Q31 (rival hypothesis)',
  assumed: false,
  encode(sample: number): number {
    const s = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
    return Math.round(s * 2147483647) >>> 0;
  },
  decode(word: number): number {
    i32[0] = word | 0;
    return i32[0]! / 2147483648;
  }
};

async function main(argv: string[]): Promise<number> {
  const [file, slotA, slotB] = argv.filter((a) => !a.startsWith('--'));
  const go = argv.includes('--go');
  if (!file || !slotA || !slotB) { console.error('usage: probe-ir-encoding <wav> <userSlotA> <userSlotB> [--go]'); return 2; }
  const wav = readFileSync(file);

  const arms = [
    { slot: Number(slotA), encoding: ASSUMED_FLOAT32_ENCODING, name: 'LYKOS F32' },
    { slot: Number(slotB), encoding: Q31_ENCODING, name: 'LYKOS Q31' }
  ] as const;

  const built = arms.map((a) => {
    const r = convertWavToCabIr(wav, { model: 0x11, filename: a.name, encoding: a.encoding, name: a.name });
    const parsed = parseCabIrSyx(Uint8Array.from(r.container));
    const close = parsed.endPayload.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    console.log(`${a.name} → user ${a.slot}: ${r.container.length} bytes, ${parsed.frames.length} frames, close ${close}`);
    console.log(`  steps: ${r.report.steps.join(' · ')}`);
    return { ...a, bytes: r.container, close };
  });

  if (built[0]!.close === built[1]!.close) {
    console.log('WARNING: both arms share a close value — the close cannot tell the encodings apart on this file.');
  }

  if (!go) { console.log('\nDRY RUN — nothing sent. Re-run with --go.'); return 4; }

  for (const arm of built) {
    const url = `${SERVER}/cab/ir/upload?user=${arm.slot}&name=${encodeURIComponent(arm.name)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Uint8Array.from(arm.bytes)
    });
    const body = await res.json().catch(() => null);
    console.log(`\nPOST user ${arm.slot} → ${res.status} ${JSON.stringify(body)}`);
  }

  for (const arm of built) {
    const res = await fetch(`${SERVER}/cab/slots?user=${arm.slot}`);
    const body = (await res.json()) as Array<{ populated?: boolean; name?: string }>;
    console.log(`slot ${arm.slot} state: ${JSON.stringify(body)}`);
  }

  console.log('\nhuman check: load user slot ' + slotA + ' in the Cab block, play, then slot ' + slotB + '.');
  console.log('  The arm that sounds like a guitar cabinet is the unit\'s encoding; the other is the wrong one.');
  return 0;
}

main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
