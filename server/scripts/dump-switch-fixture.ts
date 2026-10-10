// ────────────────────────────────────────────────────────────────────────────────────────────────
// dump-switch-fixture — pull the CURRENT EDIT BUFFER off the unit and decode its per-preset switch
// block, so a fixture with a CONFIGURED switch can be committed (§3.8).
//
// WHY the edit buffer and not a stored slot: the switch definitions the codec decodes live in whatever the
// unit is holding, and the populated example available was an unsaved edit-buffer state. The existing
// preset-410 fixture is an edit-buffer dump too, so this matches it.
//
// READ-ONLY on the device: the 0x77/0x78/0x79 dump chain. Nothing is written.
//
// USAGE  npx tsx scripts/dump-switch-fixture.ts [--out <file>]
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { parsePresetDump, decodeRawPatch, parsePerPresetSwitches, PP_MEASURED_OFFSETS, PP_REGION_BYTES } from 'forgefx-midi/devices/gen3';

const EDIT_BUFFER = 0x3fff;

export async function main(argv: string[]): Promise<number> {
  const i = argv.indexOf('--out');
  const out = i >= 0 && argv[i + 1] ? argv[i + 1]! : 'test/fixtures/preset-switches/preset-410-pp1.bin';
  const opened = await openProbeSession(0x11);
  if (!opened.ok) { console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`); return 3; }
  const { session } = opened;
  try {
    const frames = await session.transport.request(session.codec.buildRequestPresetDump(EDIT_BUFFER), {
      timeoutMs: 8000,
      quietMs: 300,
      match: (fs) => fs.some((f) => f[5] === 0x79)
    });
    if (!frames.some((f) => f[5] === 0x79)) { console.log(`incomplete dump (${frames.length} frames, no 0x79)`); return 1; }
    const bytes = frames.flat();
    const parsed = parsePresetDump(Uint8Array.from(bytes), 0, 0x11);
    const { body } = decodeRawPatch(parsed.chunkPayloads);
    const block = parsePerPresetSwitches(body);
    console.log(`dump: ${bytes.length} bytes in ${frames.length} frames · body ${body.length} B`);
    if (!block) {
      console.log('NO switch block in this edit buffer — nothing to commit. Configure PP#1 on the unit first.');
      return 1;
    }
    console.log(`block at body offset ${block.at} · populated=${block.populated}`);
    if (!block.populated) {
      console.log('the block is present but ALL ZERO — that is not the populated fixture §3.8 needs.');
      return 1;
    }
    // SAVE BEFORE PRINTING. Measured 2026-10-09 on the live unit: a row whose fields are unobserved carries a NULL
    // actionCode (by design — the codec never extrapolates), the old print loop called .toString(16) on it
    // and threw AFTER a successful dump and BEFORE the write, so a real capture of the unit was lost and the
    // frame tap was the only copy. A display bug must never cost the artifact.
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, Buffer.from(bytes));
    const sha = createHash('sha256').update(Buffer.from(bytes)).digest('hex').slice(0, 12);
    console.log(`wrote ${out}  sha256 ${sha}`);
    const code = (c: number | null, label?: string | null): string =>
      c === null ? 'code null (no observed offset)' : `code 0x${c.toString(16).padStart(2, '0')} (${label ?? 'unmeasured'})`;
    for (const s of block.switches.slice(0, Object.keys(PP_MEASURED_OFFSETS).length + 1)) {
      console.log(`  PP#${s.index}  ${code(s.actionCode, s.action)}` +
        ` → target ${s.targetIndex} (${s.targetLabel ? `${s.targetLabel} [FX-slot name — measured with Effect: Bypass only]` : 'unlabelled'})  [${s.confidence}]`);
    }
    // The RAW marker-relative window. The offsets the model reads are a handful, and a byte that moved where
    // the model says it should not is the interesting result — so print the bytes rather than only the
    // decoder's reading of them.
    // The offset legend and the window are DERIVED from the codec's table — this banner used to name the
    // offsets in hard-coded text and was wrong the moment PP#3+ were measured.
    console.log(`  [${Object.entries(PP_MEASURED_OFFSETS).map(([i, o]) =>
      `PP#${i}: action@${o.actionCode} target@${o.target ?? 'unlocated'}`).join(' · ')}]`);
    // The window covers a WIDER range than the codec reads — `WINDOW_SWITCHES` entries at the 12-byte target
    // stride — because a byte that moves OUTSIDE the measured offsets is exactly what "does the unit really
    // hold N switches?" looks like, and a window sized to the current table would cut it off. FM3-Edit lists
    // TWENTY-FOUR per-preset switches while `PP_SWITCH_COUNT` is 12, so the window is deliberately sized for
    // 24: PP#24's action code and target would sit at marker+50 and marker+424. Nothing below reads those
    // offsets — the parser only touches the table — this is a print bound, and it is labelled as one.
    const WINDOW_SWITCHES = 24;
    const windowEnd = Math.max(PP_REGION_BYTES + 8, PP_MEASURED_OFFSETS[1]!.target! + 12 * (WINDOW_SWITCHES - 1) + 8);
    for (let o = 0; o < windowEnd; o += 16) {
      const chunk = [...body.slice(block.at + o, block.at + o + 16)];
      const hex = chunk.map((b) => b.toString(16).padStart(2, '0')).join(' ');
      const txt = chunk.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
      console.log(`  marker+${String(o).padStart(3, ' ')}  ${hex.padEnd(47, ' ')}  ${txt}`);
    }
    return 0;
  } finally {
    await session.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
