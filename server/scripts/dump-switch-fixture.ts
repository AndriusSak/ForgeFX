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
import { parsePresetDump, decodeRawPatch, parsePerPresetSwitches } from 'forgefx-midi/devices/gen3';

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
    for (const s of block.switches.slice(0, 3)) {
      console.log(`  PP#${s.index}  code 0x${s.actionCode.toString(16).padStart(2, '0')} (${s.action ?? 'unmeasured'})` +
        ` → target ${s.targetIndex} (${s.targetLabel ?? 'unlabelled'})  [${s.confidence}]`);
    }
    if (!block.populated) {
      console.log('the block is present but ALL ZERO — that is not the populated fixture §3.8 needs.');
      return 1;
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, Buffer.from(bytes));
    const sha = createHash('sha256').update(Buffer.from(bytes)).digest('hex').slice(0, 12);
    console.log(`wrote ${out}  sha256 ${sha}`);
    return 0;
  } finally {
    await session.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
