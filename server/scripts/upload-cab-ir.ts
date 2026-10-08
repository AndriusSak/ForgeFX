// ────────────────────────────────────────────────────────────────────────────────────────────────
// upload-cab-ir — send a user-cab IR `.syx` container to the FM3, and print what it actually
// established (§2.5). DRY-RUN BY DEFAULT: nothing is written unless `--go` is given.
//
// WHY A SCRIPT AND NOT THE SERVER: this is the load test. It runs on the machine with the cable, opens
// the port itself, and prints the plan before touching the unit — the same shape as probe-device.ts,
// because the two write incidents on this device both came from acting without looking first.
//
// WHAT IT KNOWS: the container geometry is MEASURED from a real FM3-Edit export (1×0x7A + 8×0x7B +
// 1×0x7C, 256 five-byte chunks per data frame, 32-char name in the first 8 chunks, 2040 sample slots).
// The default path REPLAYS THE FILE'S BYTES VERBATIM — the sample payload is not decoded and the
// 0x7C value is never recomputed.
//
// MEASURED RESULT (2026-10-08, fw 13): THE UNIT REFUSES THE REPLAY. Every frame drew a 0x64 —
// fn=0x7A → result 0x16, all eight fn=0x7B → result 0x10 (MIDI_ERROR_BAD_MSG_LENGTH), fn=0x7C too. So the
// export container is NOT accepted as-is, the gen-2 0x7A/0x7B/0x7C IR-download family is not what this
// device listens for, and sending therefore requires --allow-unverified. This script is the instrument
// that produced that negative and the one to re-run once a capture of FM3-Edit loading an IR exists.
//
// WHAT IT DOES NOT KNOW, and therefore does not claim:
//   • that the FM3 accepts the stream — that is exactly what this run measures;
//   • where the IR LANDS. The measured container carries `7F 7F` (the "no explicit destination"
//     sentinel); the device's documented workflow stores to the cab slot the UNIT has selected, so
//     the current cab-block state is printed before anything is sent. `--target N` patches the 0x7A
//     field as an EXPERIMENT (the septet order is unverified — `--order msb|lsb` picks one).
//   • whether a rename survives. A rename rewrites the 32 name slots and leaves the 0x7C value
//     verbatim; whether that value covers the name is unverified.
//
// THE ONLY ORACLE IS A PERSON. This firmware refuses `fn=0x12` GET_CAB_NAME, so nothing can read a
// user slot's name back over the wire. The script therefore prints a `human check:` line naming what
// to look at. A `{ok:true}` here means the frames were SENT, never that the IR is installed.
//
// USAGE
//   npx tsx scripts/upload-cab-ir.ts <file.syx> --user 13           # DRY RUN: prints the plan
//   npx tsx scripts/upload-cab-ir.ts <file.syx> --user 13 --go      # send it to user slot 13 (verbatim)
//   npx tsx scripts/upload-cab-ir.ts <file.syx> --user 13 --go --rename "X"   # rename (measured working)
//   npx tsx scripts/upload-cab-ir.ts <file.syx> --user 13 --go --allow-unverified
//                                                                   # send a STALE close to measure the discard
//   npx tsx scripts/upload-cab-ir.ts <file.syx> --dest 16:0 --go    # explicit [page,index]
//   npx tsx scripts/upload-cab-ir.ts <file.syx> --port /dev/ttyACM0
//
// A destination is REQUIRED and the scratchpad is NOT one: the unit refused page 0x20 in every probe,
// so `--scratchpad N` sends nothing the device will take. To confirm a slot afterwards, read it back
// with scripts/probe-cab-slot-state.ts (occupancy + content region — NOT a name).
//
// EXIT CODES  0 sent (with --go) · 2 the file was refused before anything was sent · 3 no device
//             4 dry run: a plan was printed and NOTHING was written.
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { parseCabIrSyx, buildCabIrSyx, cabIrScratchpad, cabIrUserSlot, interpretCabIrAcks, CAB_IR_FN_END, CAB_IR_CLOSE_ACCEPTED, CAB_IR_CLOSE_MISMATCH } from 'forgefx-midi/devices/gen3';

const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');

export async function main(argv: string[], log: (l: string) => void = console.log): Promise<number> {
  let file: string | undefined;
  let go = false;
  let rename: string | undefined;
  let dest: { page: number; index: number } | undefined;
  let destLabel = '';
  let port: string | undefined;
  let model = 0x11;
  /** Point the cab block's slot 1 at a SCRATCHPAD IR first (the destination the unit will use). */
  let selectScratchpad: number | undefined;
  /** The measured result is a REFUSAL, so sending requires an explicit opt-in (see the header). */
  let allowUnverified = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--go') go = true;
    else if (a === '--allow-unverified') allowUnverified = true;
    else if (a === '--rename') rename = argv[++i];
    else if (a === '--select-scratchpad') selectScratchpad = Number(argv[++i]);
    else if (a === '--dest') { const [pg, ix] = (argv[++i] ?? '').split(':').map(Number); dest = { page: pg ?? 0, index: ix ?? 0 }; destLabel = `page 0x${(pg ?? 0).toString(16)} index ${ix}`; }
    else if (a === '--scratchpad') { const n = Number(argv[++i]); dest = cabIrScratchpad(n); destLabel = `scratchpad ${n}`; }
    else if (a === '--user') { const n = Number(argv[++i]); dest = cabIrUserSlot(n); destLabel = `user slot ${n}`; }
    else if (a === '--port') port = argv[++i];
    else if (a === '--model') model = { fm3: 0x11, fm9: 0x12, axe3: 0x10 }[argv[++i] ?? ''] ?? 0x11;
    else if (a === '-h' || a === '--help') { log('see the header of scripts/upload-cab-ir.ts'); return 0; }
    else if (a.startsWith('--')) { log(`unknown argument ${a}`); return 2; }
    else file = a;
  }
  if (!file) { log('usage: npx tsx scripts/upload-cab-ir.ts <file.syx> [--go] [--rename X] [--scratchpad N|--user N|--dest page:index]'); return 2; }

  // ── parse + build BEFORE opening the port: a refused container must never reach the device ──
  const raw = Array.from(readFileSync(file));
  let parsed;
  try {
    parsed = parseCabIrSyx(raw);
  } catch (e) {
    log(`REFUSED (nothing was sent): ${(e as Error).message}`);
    return 2;
  }
  if (parsed.modelId !== model) {
    log(`REFUSED (nothing was sent): container model byte 0x${parsed.modelId.toString(16)} ≠ device 0x${model.toString(16)}`);
    return 2;
  }
  let bytes: number[];
  try {
    // --allow-unverified now means "send the close frame UNRECOMPUTED", i.e. deliberately stale, so the
    // unit's discard (close-code 0x13) can be measured. Without it the close is recomputed — a no-op for
    // an untouched container and the fix for a rename (measured-working, 2026-10-08).
    bytes = buildCabIrSyx(parsed, { name: rename, dest, recomputeClose: !allowUnverified });
  } catch (e) {
    log(`REFUSED (nothing was sent): ${(e as Error).message}`);
    return 2;
  }


  log(`file        ${file} (${raw.length} bytes)`);
  log(`container   model 0x${parsed.modelId.toString(16)} · ${parsed.frames.length} frames · ${parsed.sampleSlots} sample slots`);
  log(`name        ${JSON.stringify(rename ?? parsed.name)}${rename ? `  (renamed from ${JSON.stringify(parsed.name)})` : ''}`);
  log(`start frame ${hex(parsed.startPayload)}${dest ? `  → destination ${destLabel} (${hex(bytes.slice(6, 10))})` : '  (carries the 7F 7F "no explicit destination" sentinel)'}`);
  log(`destination  ${dest ? destLabel + ' — MEASURED field: [index, page] in the 0x7A payload' : 'none given: the export sentinel is sent as-is, which the unit REFUSED on 2026-10-08'}`);
  log(`end frame   ${hex(parsed.endPayload)}  (carried verbatim — never recomputed)`);
  log(`wire        ${bytes.length} bytes${bytes.length === raw.length ? ' (identical length to the file)' : ''}`);

  const opened = await openProbeSession(model, port);
  if (!opened.ok) {
    log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`);
    return 3;
  }
  const s = opened.session;
  log(`device      ${s.label}`);

  // Where is the unit currently pointing? The container names no destination, so the cab block's
  // current selection is the most likely landing place — print it before anything is written.
  let cab: Awaited<ReturnType<typeof s.driver.cabState>> | null = null;
  try {
    cab = await s.driver.cabState(62);
    if ('slots' in cab) {
      const slots = cab.slots.map((sl) => `slot ${sl.slot}: ${sl.bank.label} #${sl.irIndex + 1} ${JSON.stringify(sl.irName)}`).join(' | ');
      log(`cab block   mode ${cab.mode.label} · ${slots}`);
    }
  } catch (e) {
    log(`cab block   (could not read cab state: ${(e as Error).message})`);
  }

  // Optional: point slot 1 at a SCRATCHPAD IR before uploading. This is a PRESET edit-buffer write
  // (mode/bank/IR selection on the cab block) — the same writes the editor's picker makes — and it is
  // what makes the upload land on the experimentation memories instead of wherever the unit happened
  // to be pointing. Printed as a plan in dry-run; never performed without --go.
  const selPlan: { paramId: number; value: number; what: string }[] = [];
  if (selectScratchpad != null && cab && 'slots' in cab) {
    const bankOrd = cab.bankOptions.indexOf('SCRATCHPAD');
    if (bankOrd < 0) { log('REFUSED: this device does not list a SCRATCHPAD cab bank'); await s.close(); return 2; }
    if (!(selectScratchpad >= 1 && selectScratchpad <= 16)) { log(`REFUSED: scratchpad slot ${selectScratchpad} is outside 1..16`); await s.close(); return 2; }
    selPlan.push({ paramId: cab.modeParam, value: 0, what: 'mode → LEGACY (scratchpad IRs are selected in Legacy mode)' });
    selPlan.push({ paramId: cab.slots[0]!.bankParam, value: bankOrd, what: `slot 1 bank → SCRATCHPAD (ordinal ${bankOrd})` });
    selPlan.push({ paramId: cab.slots[0]!.irParam, value: selectScratchpad - 1, what: `slot 1 IR → scratchpad ${selectScratchpad} (index ${selectScratchpad - 1})` });
    log('');
    log('cab-block selection plan (a PRESET edit-buffer change — not a stored cab):');
    for (const p of selPlan) log(`  eid 62 pid ${String(p.paramId).padStart(4)} = ${p.value}   ${p.what}`);
  }

  // No path here needs an opt-in any more: a VERBATIM send and a RENAME are both MEASURED-WORKING
  // (2026-10-08 — the close frame is a checksum over the content, recomputed for a rename, and the unit
  // answered 0x00 with the destination populated). --allow-unverified remains for measuring a
  // deliberately stale container, which the driver refuses by default because the unit DISCARDS it.

  if (!go) {
    log('');
    log('DRY RUN — nothing was written. Re-run with --go to send these frames.');
    if (!selPlan.length) {
      log('the destination above is written INTO the 0x7A start frame — it does not depend on what the');
      log('unit has selected. Afterwards, read the slot back with probe-cab-slot-state.ts to confirm it.');
    }
    await s.close();
    return 4;
  }

  // Capture the ORIGINAL cab selection before touching it, so it can be put back after the upload.
  // The upload does not need the selection to persist — the IR goes into the scratchpad memory — and
  // leaving a preset edit behind on someone's unit is exactly what this stack does not do.
  const original: { paramId: number; value: number; what: string }[] = [];
  if (selPlan.length && cab && 'slots' in cab) {
    original.push({ paramId: cab.modeParam, value: cab.mode.value, what: `mode → ${cab.mode.label}` });
    original.push({ paramId: cab.slots[0]!.bankParam, value: cab.bankOptions.indexOf(cab.slots[0]!.bank.label), what: `slot 1 bank → ${cab.slots[0]!.bank.label}` });
    original.push({ paramId: cab.slots[0]!.irParam, value: cab.slots[0]!.irIndex, what: `slot 1 IR → index ${cab.slots[0]!.irIndex}` });
  }

  if (selPlan.length) {
    log('');
    for (const p of selPlan) {
      const r = await s.driver.setParam(62, p.paramId, p.value, false); // discrete: enums take their ordinal
      log(`  wrote eid 62 pid ${p.paramId} = ${p.value} → ${r.ok ? 'accepted (no 0x64 within the window)' : 'REFUSED (0x64)'}`);
      if (!r.ok) { log('STOPPING before the upload: the selection was refused, so the destination is unknown.'); await s.close(); return 2; }
    }
    // Same-path read-back: this proves our writes LANDED, not that the unit agrees they mean what we
    // think they mean — so it is reported as the device's report, never as "verified".
    const after = await s.driver.cabState(62);
    if ('slots' in after) log(`  unit now reports: mode ${after.mode.label} · slot 1 ${after.slots[0]!.bank.label} #${after.slots[0]!.irIndex + 1} ${JSON.stringify(after.slots[0]!.irName)}`);
  }

  log('');
  log(`sending ${parsed.frames.length} frames, paced…`);
  // LISTEN while sending. A paced send is fire-and-forget, so the unit's own answer is easy to throw
  // away — and on this device the answer is the only wire-side evidence there is. Calibration from the
  // oracle probe (2026-10-08): a VALID frame naming an UNSUPPORTED function draws ONE 0x64 (echoed fn +
  // result), a MALFORMED frame draws TWO (0x01 then 0x00), and an accepted write draws NOTHING at all.
  // So: frames here = the unit objected (report the echoed function + result); silence = no objection,
  // which is NOT the same as acceptance.
  const inbound: number[][] = [];
  const off = s.transport.onFrame((f) => inbound.push([...f]));
  if (s.transport.sendPaced) await s.transport.sendPaced(bytes);
  else await s.transport.sendQueued(bytes);
  // Give the unit time to chew through the frames before the port closes — a close mid-write is the
  // one way this script could lose the transfer it just sent. (The restore below still needs the port,
  // so the close happens after it, not here.)
  await new Promise((r) => setTimeout(r, 1500));
  off();

  const acks = interpretCabIrAcks(inbound, parsed.frames.filter((f) => f[5] === 0x7b).length);
  log('');
  if (!inbound.length) {
    log('unit answered: NOTHING — no ack at all. On this device that is NOT acceptance:');
    log('the editor\'s own upload was acknowledged frame by frame, so expect start/data/end acks.');
  } else {
    log(`unit answered: ${inbound.length} frame(s) — ${acks.complete ? 'START + ALL DATA + END ACKNOWLEDGED' : 'INCOMPLETE'}`);
    log(`  start acked: ${acks.start} · data acks: ${acks.data}/${acks.expectedData} · end acked: ${acks.end}`);
    log(`  raw [echoed fn, code] pairs: ${acks.codes.map((c) => `[0x${c.fn.toString(16)}, 0x${c.code.toString(16)}]`).join(' ')}`);
    log('  NOTE: do NOT read those codes through a label table — the MIDI_ERROR_* names in this codebase');
    log('  are an ASSUMED index mapping and contradict this device. Measured here: every ACCEPTED frame');
    log('  (the editor\'s own upload included) is answered with code 0x00.');
    // The CLOSE frame's code is not decoration — it decides whether the unit KEPT the upload.
    const closeCode = acks.codes.find((c) => c.fn === CAB_IR_FN_END)?.code ?? null;
    if (closeCode === CAB_IR_CLOSE_MISMATCH) {
      log('');
      log('*** the unit DISCARDED this upload ***');
      log('the close frame answered 0x13: the container\'s close-frame value does not match its content,');
      log('so the unit threw the whole transfer away and left the destination UNTOUCHED.');
      log('MEASURED in four controlled arms (2026-10-08) — verbatim -> 0x00 -> the slot became');
      log('populated; name changed, samples zeroed, and close-value-mutated all -> 0x13, and in every');
      log('0x13 arm an EMPTY destination slot STAYED EMPTY. Only a container byte-identical to one the');
      log('device or FM3-Edit produced is accepted; any edit needs the close value RECOMPUTED, and its');
      log('encoding is not decoded. Do NOT report this as a successful send.');
    } else if (closeCode === CAB_IR_CLOSE_ACCEPTED) {
      log('  close frame answered 0x00 — the container\'s close value matches its content (accepted).');
    } else {
      log(`  close frame answered ${closeCode === null ? 'NOTHING' : `0x${closeCode.toString(16)}`} — acceptance NOT established.`);
    }
  }

  // Put the cab selection back. Restoring is reported honestly: the read-back is the same path that
  // wrote, so it shows the unit reports the original value — not that the original was captured right.
  let restored = original.length > 0;
  if (original.length) {
    log('');
    log('restoring the cab-block selection we changed:');
    for (const p of original) {
      const r = await s.driver.setParam(62, p.paramId, p.value, false);
      log(`  wrote eid 62 pid ${p.paramId} = ${p.value} (${p.what}) → ${r.ok ? 'accepted' : 'REFUSED (0x64)'}`);
      restored = restored && r.ok;
    }
    try {
      const back = await s.driver.cabState(62);
      if ('slots' in back) log(`  unit now reports: mode ${back.mode.label} · slot 1 ${back.slots[0]!.bank.label} #${back.slots[0]!.irIndex + 1}`);
    } catch { /* best effort */ }
  }
  await s.close();

  log('');
  const closeCodeFinal = interpretCabIrAcks(inbound, parsed.frames.filter((f) => f[5] === 0x7b).length).codes.find((c) => c.fn === CAB_IR_FN_END)?.code ?? null;
  if (closeCodeFinal === CAB_IR_CLOSE_MISMATCH) {
    log('DISCARDED — every frame was acknowledged and the unit still threw the transfer away. Nothing was stored.');
  } else {
    log('SENT — the unit acknowledged every frame and the close frame answered 0x00 (accepted).');
  }
  log('to CONFIRM the slot, read its state back (read-only):');
  const slotArg = dest && dest.page >= 0x10 && dest.page <= 0x13 ? `--slots ${(dest.page - 0x10) * 128 + dest.index + 1}` : dest && dest.page === 0x20 ? `--slots ${512 + dest.index + 1}` : '--slots <n>';
  log(`  npx tsx scripts/probe-cab-slot-state.ts ${slotArg}`);
  log('  → "populated" plus a content region; two slots holding the same IR share it byte for byte.');
  log('  It is NOT a name (the region is not decoded), so this proves occupancy and identity-by-content,');
  log('  never "the slot holds <name>".');
  if (original.length) log(`             (the cab block selection itself was put back${restored ? '' : ' — CHECK IT, a restore was refused'})`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
