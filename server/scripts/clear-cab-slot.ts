// ────────────────────────────────────────────────────────────────────────────────────────────────
// clear-cab-slot — ERASE a user cab slot. DESTRUCTIVE; dry-run by default.
//
// WHY THIS EXISTS: there is no remove opcode, but there IS a delete. MEASURED 2026-10-08: a container
// whose entire chunk area is `0x7F` (the blank fill Fractal's own loader ships as `empty_ir.syx`) is
// ACCEPTED by the unit — every one of the 2048 words is identical, so their XOR is 0 and the close
// frame is `00 00 00 00 00` — and the destination slot then reads **EMPTY**, indistinguishable from a
// never-written slot. Verified on an empty slot and on eight slots that held real IRs.
//
// NOT to be confused with zeroing SAMPLES: that keeps a real name, is stored, and reads `populated`
// (a silent IR, not an empty slot). The blank FILL is the device's own "unwritten" pattern.
//
// The clear is confirmed through the device's slot-state read-back (`fn=0x01 sub=0x4B`): `ok` requires
// the `0x00` close answer AND a post-read of `empty`. Never assume it worked — check the output.
//
// USAGE
//   npx tsx scripts/clear-cab-slot.ts --user 30           # DRY RUN: prints the plan, exits 4
//   npx tsx scripts/clear-cab-slot.ts --user 30 --go      # actually erase slot 30
//   npx tsx scripts/clear-cab-slot.ts --page 16 --index 5 --go
//   npx tsx scripts/clear-cab-slot.ts --user 30 --port /dev/ttyACM0
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { buildBlankCabIrContainer, cabIrUserSlot, cabIrScratchpad } from 'forgefx-midi/devices/gen3';

const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');

export async function main(argv: string[]): Promise<number> {
  let user: number | undefined;
  let page: number | undefined;
  let index = 0;
  let go = false;
  let port: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--user') user = Number(argv[++i]);
    else if (a === '--page') page = Number(argv[++i]);
    else if (a === '--index') index = Number(argv[++i]);
    else if (a === '--port') port = argv[++i];
    else if (a === '--go') go = true;
  }
  if (user == null && page == null) {
    console.log('usage: npx tsx scripts/clear-cab-slot.ts (--user N | --page P [--index I]) [--go] [--port /dev/...]');
    return 2;
  }
  const target = user != null ? cabIrUserSlot(user) : { page: page!, index };
  const label = user != null ? `user slot ${user}` : `page 0x${target.page.toString(16)} index ${target.index}`;

  const opened = await openProbeSession(0x11, port);
  if (!opened.ok) {
    console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`);
    return 3;
  }
  const { session } = opened;
  try {
    const before = (await session.driver.queryCabSlots!({ page: target.page, from: target.index, to: target.index }))[0]!;
    console.log(`device      ${session.label}`);
    console.log(`target      ${label}  (page 0x${target.page.toString(16)}, index ${target.index})`);
    console.log(`state now   ${before.populated === true ? 'POPULATED' : before.populated === false ? 'empty' : `UNREADABLE (${before.note})`}`);
    console.log(`method      send the BLANK container — every chunk byte 0x7F, close ${hex([0, 0, 0, 0, 0])}`);
    console.log(`then        confirm via the slot-state read-back (ok needs close 0x00 AND a post-read of empty)`);
    if (!go) {
      console.log('');
      console.log('DRY RUN — nothing was written. Re-run with --go to ERASE this slot. It cannot be undone from here.');
      return 4;
    }
    console.log('');
    console.log('erasing…');
    const res = await session.driver.clearCabSlot!({ page: target.page, from: target.index, to: target.index });
    console.log(`close answer 0x${res.closeCode?.toString(16) ?? '--'} · was ${res.wasPopulated} · now ${res.nowPopulated}`);
    console.log(res.ok ? 'CLEARED' : 'NOT CLEARED');
    console.log(`  ${res.reason}`);
    return res.ok ? 0 : 2;
  } finally {
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
