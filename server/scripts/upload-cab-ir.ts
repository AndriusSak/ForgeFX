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
//   npx tsx scripts/upload-cab-ir.ts <file.syx>                     # DRY RUN: prints the plan, exits 4
//   npx tsx scripts/upload-cab-ir.ts <file.syx> --go --allow-unverified   # send it (verbatim; REQUIRED)
//   npx tsx scripts/upload-cab-ir.ts <file.syx> --go --rename "X"   # send with a new name (32 chars max)
//   npx tsx scripts/upload-cab-ir.ts <file.syx> --go --select-scratchpad 1   # aim the cab block at scratchpad 1 first
//   npx tsx scripts/upload-cab-ir.ts <file.syx> --go --scratchpad 1   # MEASURED destination: scratchpad 1
//   npx tsx scripts/upload-cab-ir.ts <file.syx> --port /dev/ttyACM0
//
// EXIT CODES  0 sent (with --go) · 2 the file was refused before anything was sent · 3 no device
//             4 dry run: a plan was printed and NOTHING was written.
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { parseCabIrSyx, buildCabIrSyx, cabIrScratchpad, cabIrUserSlot, interpretCabIrAcks } from 'forgefx-midi/devices/gen3';

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
    bytes = buildCabIrSyx(parsed, { name: rename, dest });
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

  if (go && !allowUnverified) {
    log('');
    log('REFUSING to send: this wire path is measured-REFUSED on fw 13 — replaying an FM3-Edit IR export');
    log('verbatim drew a 0x64 on every frame (fn=0x7A → result 0x16, fn=0x7B → result 0x10 bad message');
    log('length, fn=0x7C likewise). The container is not accepted as-is and the real IR-upload opcodes are');
    log('still uncaptured. Re-run with --allow-unverified only to measure that, and watch the inbound');
    log('stream this script prints — the refusals are the evidence.');
    await s.close();
    return 2;
  }

  if (!go) {
    log('');
    log('DRY RUN — nothing was written. Re-run with --go to apply the selection and send these frames.');
    if (!selPlan.length) {
      log('human check: the IR lands where the UNIT has its cab slot selected — add --select-scratchpad N');
      log('             to point slot 1 at the experimentation memories first.');
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
  log('SENT — that is all this establishes. There is no cab-name read-back on this firmware');
  log('(fn=0x12 is refused), so nothing here proves the unit stored the IR.');
  log(`human check: on the FM3 (or FM3-Edit) select Cab block slot 1 → Bank SCRATCHPAD → IR 1; its name`);
  log(`             should read ${JSON.stringify(rename ?? parsed.name)}. If it still shows the old/blank name, the`);
  log('             upload was NOT accepted — report that rather than re-running.');
  if (original.length) log(`             (the cab block selection itself was put back${restored ? '' : ' — CHECK IT, a restore was refused'})`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
