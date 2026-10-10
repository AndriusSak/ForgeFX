// Gen-3 PER-PRESET SWITCH definitions (§3.8) — the read route and the per-FIELD write bound.
//
// The fixtures are the owner's real preset 410 dumps. Capture A (`preset-perform/preset-410.bin`) has the
// switch block PRESENT but UNCONFIGURED — that pins the marker's position in a real decompressed body and
// confirms marker+148 as PP#1's target byte. Captures B–H are one edit each by the owner plus one read-only
// dump; every target byte and action code beyond PP#1 was located BY PREDICTION, each value stated before its
// capture was read (`check-switch-offsets.ts` re-runs all seven steps, MODEL HOLDS, zero unexplained bytes).
// Capture H tested the switch COUNT itself — FM3-Edit lists 24 rows while the codec assumed 12 — by setting
// PP#13 and PP#24 at the two ends of the extra range. Indices 14–23 are therefore the honest gap: they exist,
// both strides fit across them, and nothing has been observed there, so they read as unread.
//
// Offline/mocked, NO hardware.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { PROFILES } from '../../src/devices.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { buildTestApp } from '../helpers/api.js';
import { createRouter } from '../../src/runtime/router.js';
import * as store from '../../src/store.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
export const PER_PRESET_SWITCH_DRIVER_CASE_COUNT = 19;

function framesFrom(bytes: Uint8Array): number[][] {
  const frames: number[][] = [];
  let cur: number[] | null = null;
  for (const b of bytes) {
    if (b === 0xf0) cur = [b];
    else if (cur) { cur.push(b); if (b === 0xf7) { frames.push(cur); cur = null; } }
  }
  return frames;
}

/** An edit buffer that ADOPTS what is written to it (see the perform-slot-write suite): the only mock
 *  shape in which a read-back verdict can be exercised at all. */
function makeEditBufferMock(frames: number[][]): MockTransport {
  const mock = new MockTransport('serial', 'mock-switch-write');
  mock.isOpen = true;
  let buffer = frames.map((f) => [...f]);
  const adopt = (bytes: readonly number[]): void => {
    if (bytes[0] !== 0xf0 || bytes.length < 6) return;
    const fn = bytes[5];
    if (fn === 0x77) buffer = [[...bytes]];
    else if (fn === 0x78 || fn === 0x79) buffer = [...buffer, [...bytes]];
  };
  mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(MODEL)] : req[5] === 0x03 ? buffer : []);
  mock.sendPaced = async (bytes) => { mock.sent.push([...bytes]); adopt(bytes); };
  mock.sendQueued = async (bytes) => { mock.sent.push([...bytes]); adopt(bytes); };
  return mock;
}

function makeDriver(mock: MockTransport): ReturnType<typeof createGen3Driver> {
  return createGen3Driver(PROFILES[MODEL]!, {
    transport: async () => mock,
    emit: () => {},
    getCadence: () => cadenceFor(MODEL, 'balanced')
  });
}

/** A stub carrying only what these routes touch (`capabilities` is a property, not a method). */
function stubDriver(extra: Record<string, unknown> = {}): unknown {
  return { modelId: MODEL, key: 'fm3', name: 'FM3', capabilities: {}, ...extra };
}

/** One of the real captures, parsed through the driver (each is a full preset dump). */
async function pageOf(file: string): Promise<NonNullable<Awaited<ReturnType<NonNullable<ReturnType<typeof createGen3Driver>['perPresetSwitches']>>>>> {
  const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL(file, import.meta.url))));
  const page = await makeDriver(makeEditBufferMock(framesFrom(bytes))).perPresetSwitches!();
  if (!page) throw new Error(`no switch block in ${file}`);
  return page;
}

export async function runPerPresetSwitchDriverTests(): Promise<void> {
  const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL('../fixtures/preset-perform/preset-410.bin', import.meta.url))));
  const frames = framesFrom(bytes);
  const populated = new Uint8Array(readFileSync(fileURLToPath(new URL('../fixtures/preset-switches/preset-410-pp1.bin', import.meta.url))));
  const populatedFrames = framesFrom(populated);

  // 1. The REAL body: the marker is found, and it lands exactly where the documented PP#1 anchor says.
  {
    const page = await makeDriver(makeEditBufferMock(frames)).perPresetSwitches!();
    assert(page, 'perPresetSwitches() must report the block — the marker is present in this preset');
    assertEqual(page.at, 11420, 'the marker sits at body offset 11420 in this fixture');
    assertEqual(page.at + 148, 11568, 'and marker+148 IS the doc\'s measured PP#1 target offset');
    assertEqual(page.populated, false, 'this preset has NO per-preset switch configured (the region is zero)');
    assertEqual(page.geometry, 'per-index-observed-offsets', 'the decode names its own model');
  }

  // 2. Row confidence is a THREE-WAY split, per field: PP#1–PP#3 have both offsets observed, PP#4 has none —
  //    so it reads nothing rather than guessing. (Which indices have an observed offset is DATA, and it moved
  //    on 2026-10-09: PP#2 and PP#3 gained a target byte, so a 'partial' row no longer exists in this table.)
  {
    const page = (await makeDriver(makeEditBufferMock(frames)).perPresetSwitches!())!;
    assertEqual(page.switches[0]!.index, 1, 'rows are 1-based');
    assertEqual(page.switches[0]!.confidence, 'measured', 'PP#1: both offsets observed');
    assertEqual(page.switches[1]!.confidence, 'measured', 'PP#2: both offsets observed (target byte at marker+160)');
    assertEqual(page.switches[2]!.confidence, 'measured', 'PP#3: both offsets observed (action code at marker+8, target at marker+172)');
    assertEqual(page.switches[3]!.confidence, 'measured', 'PP#4: both offsets observed (marker+10 / marker+184)');
    assertEqual(page.switches[4]!.confidence, 'measured', 'PP#5: both offsets observed (marker+12 / marker+196)');
    assertEqual(page.switches[10]!.confidence, 'measured', 'PP#11: the table reaches marker+24 / marker+268');
    assertEqual(page.switches[11]!.confidence, 'measured', 'PP#12: marker+26 / marker+280');
    assertEqual(page.switches[12]!.confidence, 'measured', 'PP#13: marker+28 / marker+292 — the unit has more than twelve');
    assertEqual(page.switches[13]!.confidence, 'unknown', 'PP#14: no observed offset — the stride predicts it, nothing more');
    assertEqual(page.switches[23]!.confidence, 'measured', 'PP#24: marker+50 / marker+424, the far end of the range');
    assertEqual(page.switches.length, 24, 'twenty-four rows: the switch count came from FM3-Edit and was then MEASURED');
    assertEqual(page.switches.filter((s) => s.confidence === 'unknown').length, 10, 'ten of them (14–23) are still unread');
    assertEqual(page.switches[0]!.action, 'unassigned', 'the unconfigured PP#1 reads as unassigned');
  }

  // 3. A live-shaped WRITE of PP#1 confirms by read-back (ids + the target byte), to the edit buffer.
  {
    const mock = makeEditBufferMock(frames);
    const res = await makeDriver(mock).setPerPresetSwitch!(1, { actionCode: 0x04, targetIndex: 51 });
    assert(res.ok, `the write must confirm by read-back (got ${JSON.stringify(res)})`);
    assertEqual(res.readback!.actionCode, 0x04, 'read-back action code');
    assertEqual(res.readback!.targetIndex, 51, 'read-back target index');
    assertEqual(res.readback!.targetLabel, 'Reverb 1', 'and the measured anchor names the target');
    assertEqual(mock.sent[0]![5], 0x03, 'the op starts with the dump REQUEST');
    const wrote = mock.sent.slice(1).filter((f) => f[5] !== 0x03);
    assertEqual(wrote[0]![5], 0x77, 'then re-sends the rebuilt dump, header first');
    assertEqual(wrote[0]![6], 0x7f, 'retargeted to the EDIT BUFFER (numHi)');
    assertEqual(wrote[0]![7], 0x7f, 'retargeted to the EDIT BUFFER (numLo)');
  }

  // 4. A device that ignores the write reports FAILURE — `ok` is a read-back verdict, not "no rejection".
  {
    const mock = new MockTransport('serial', 'mock-ignore');
    mock.isOpen = true;
    mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(MODEL)] : frames); // always the original
    const res = await makeDriver(mock).setPerPresetSwitch!(1, { targetIndex: 51 });
    assertEqual(res.ok, false, 'an ignored write must not report ok:true');
    assertEqual(res.reason, 'readback-mismatch', 'it names the read-back mismatch');
    assertEqual(res.readback!.targetIndex, 0, 'and reports the slot as it actually reads');
  }

  // 5. The write bound is EVIDENCE-DRIVEN per field, and it MOVED with the measurement: PP#1–PP#5 are
  //    writable (both fields), PP#6 has no observed offset at all.
  {
    const mock = makeEditBufferMock(populatedFrames);
    const res = await makeDriver(mock).setPerPresetSwitch!(2, { targetIndex: 51 });
    assert(res.ok, `PP#2 + a target is now ALLOWED — marker+160 was located by prediction: ${JSON.stringify(res)}`);
    assertEqual(res.readback!.targetIndex, 51, 'and the read-back confirms the target it wrote');
  }
  {
    const mock = makeEditBufferMock(populatedFrames);
    const res = await makeDriver(mock).setPerPresetSwitch!(1, { targetIndex: 51 });
    assert(res.ok, `PP#1 + a target is allowed (its target offset IS observed): ${JSON.stringify(res)}`);
  }
  {
    const mock = makeEditBufferMock(populatedFrames);
    const res = await makeDriver(mock).setPerPresetSwitch!(3, { actionCode: 0x04, targetIndex: 2 });
    assert(res.ok, `PP#3 is writable on BOTH fields too: ${JSON.stringify(res)}`);
    assertEqual(res.readback!.targetIndex, 2, 'with its target byte read back from marker+172');
  }
  {
    const mock = makeEditBufferMock(populatedFrames);
    const res = await makeDriver(mock).setPerPresetSwitch!(25, { actionCode: 0x04 });
    assertEqual(res.ok, false, 'PP#25 is past the switch count (24)');
    assertEqual(res.reason, 'unsupported-index', 'refused with the index named');
    assertEqual(mock.sent.length, 1, 'and nothing written');
  }

  // 6. Route validation, per FIELD, with both surfaces agreeing. The per-field REFUSAL branch
  //    (`no-target-offset`) is unreachable while no index has an action code without a located target — it
  //    stays in the handler because it is the guard for the next index someone measures only half of.
  {
    const { app, registry } = await buildTestApp(MODEL, stubDriver({ setPerPresetSwitch: async (i: number) => ({ ok: true, index: i, requested: {}, readback: null }) }) as never);
    const pp2Target = await app.inject({ method: 'PUT', url: '/preset/switches/2', payload: { targetIndex: 51 } });
    assertEqual(pp2Target.statusCode, 200, 'PP#2 + target → 200 once its target byte is located');

    const actionOnly = await app.inject({ method: 'PUT', url: '/preset/switches/2', payload: { actionCode: 4 } });
    assertEqual(actionOnly.statusCode, 200, 'PP#2 + action code → 200');

    // PP#12 is writable like the rest. The refusals that remain are BOTH kinds, and both are worth pinning:
    // an index that exists but whose offset nobody has observed (PP#14 — the unit has 24 switches and 14–23 are
    // unmeasured) and an index past the count entirely (PP#25). The third branch, `target byte offset has not
    // been located`, needs an index with an action code but no target offset — none exists today; it stays as
    // the guard for the next index someone measures only half of.
    const pp12 = await app.inject({ method: 'PUT', url: '/preset/switches/12', payload: { targetIndex: 3 } });
    assertEqual(pp12.statusCode, 200, 'PP#12 + target → 200');
    const unread = await app.inject({ method: 'PUT', url: '/preset/switches/14', payload: { targetIndex: 3 } });
    assertEqual(unread.statusCode, 400, 'PP#14 → 400: the switch EXISTS (24 of them) but its offset was never observed');
    assert(/PP#14 has no observed byte offset/.test((unread.json() as { error: string }).error), 'and the error says exactly that');
    const past = await app.inject({ method: 'PUT', url: '/preset/switches/25', payload: { actionCode: 4 } });
    assertEqual(past.statusCode, 400, 'PP#25 → 400 (past PP_SWITCH_COUNT)');
    assert(/index must be an integer 1\.\.24/.test((past.json() as { error: string }).error), 'and the error names the valid range');

    const empty = await app.inject({ method: 'PUT', url: '/preset/switches/1', payload: {} });
    assertEqual(empty.statusCode, 400, 'an empty patch → 400');
    const zero = await app.inject({ method: 'PUT', url: '/preset/switches/0', payload: { targetIndex: 1 } });
    assertEqual(zero.statusCode, 400, 'index 0 → 400');

    const router = createRouter({ registry, store: store.defaultStore });
    const rtr = await router.handle('PUT', '/preset/switches/25', JSON.stringify({ actionCode: 4 }));
    assertEqual(rtr.status, 400, 'and the runtime router agrees on the refusal (parity)');
    assertEqual(rtr.body, past.payload, 'with the identical body');
    const ok = await router.handle('PUT', '/preset/switches/2', JSON.stringify({ targetIndex: 51 }));
    assertEqual(ok.status, 200, 'and agrees on the acceptance too');
    await app.close();
  }

  // 7. The read route: 501 without the capability, and `null` (not a fabricated block) when there is none.
  {
    const { app } = await buildTestApp(MODEL, stubDriver() as never);
    const res = await app.inject({ method: 'GET', url: '/preset/switches' });
    assertEqual(res.statusCode, 501, 'a device without perPresetSwitches → 501');
    assertEqual((res.json() as { capability: string }).capability, 'perPresetSwitches', 'naming the capability');
    await app.close();
  }
  {
    const { app } = await buildTestApp(MODEL, stubDriver({ perPresetSwitches: async () => undefined }) as never);
    const res = await app.inject({ method: 'GET', url: '/preset/switches' });
    assertEqual(res.statusCode, 200, 'no block → 200');
    assertEqual(res.payload, 'null', 'with a JSON null body, never a synthesised block');
    await app.close();
  }

  // 9. The SECOND real capture (B): PP#1 and PP#2 configured. PP#2's target byte reads 1 — and because the
  //    anchor names were all measured with an EFFECT action, the codec reports the raw index + the FX-slot
  //    anchor while the UI decides whether the name applies (a scene action's target is not an FX slot).
  {
    const page = await pageOf('../fixtures/preset-switches/preset-410-pp1.bin');
    assertEqual(page.at, 11420, 'the marker is at the SAME body offset as the empty capture');
    assertEqual(page.at + 148, 11568, 'and marker+148 is still PP#1\'s target byte');
    assertEqual(page.populated, true, 'this one is populated');
    const pp1 = page.switches[0]!;
    assertEqual(pp1.actionCode, 0x04, 'PP#1 carries the Bypass action code');
    assertEqual(pp1.targetIndex, 20, 'targeting index 20');
    assertEqual(pp1.targetLabel, 'Filter 4', 'which the independently measured anchor names "Filter 4"');
    const pp2 = page.switches[1]!;
    assertEqual(pp2.actionCode, 0x03, 'PP#2 carries the scene-select code (the owner\'s second switch)');
    assertEqual(pp2.targetIndex, 1, 'and its target byte reads 1 — the number is the observation');
    assertEqual(page.evidence.actionCodeIndices.join(','), '1,2,3,4,5,6,7,8,9,10,11,12,13,24', 'the observed indices are 1–13 and 24 — NOT a range, and not a count');
    assertEqual(page.evidence.targetByteIndices.join(','), '1,2,3,4,5,6,7,8,9,10,11,12,13,24', 'and the target bytes carry the same list');
  }

  // 11. The THIRD capture (C): PP#1 → Delay 2, and the flat-target-array reading refuted. PP#2's action
  //     changed too, so a flat one-per-switch target array would have had to move marker+149. It did not.
  {
    const page = await pageOf('../fixtures/preset-switches/preset-410-delay2.bin');
    assertEqual(page.switches[0]!.targetIndex, 8, 'PP#1 now targets index 8');
    assertEqual(page.switches[0]!.targetLabel, 'Delay 2', 'which the wire anchor names "Delay 2"');
    assertEqual(page.switches[1]!.actionCode, 0x04, 'PP#2 action code changed to Effect: Bypass');
    assertEqual(page.switches[1]!.targetIndex, 14, 'and PP#2 targets index 14 = "FB Rtn 2" (the value that was unexplained until marker+160 was located)');
    assertEqual(page.switches[1]!.targetLabel, 'FB Rtn 2', 'named by the anchor measured in capture E');
  }

  // 12. The FOURTH capture (D) — the PREDICTION that settled marker+160: PP#2's target set to a known anchor
  //     (Reverb 1 = 51). The model said 51 must appear there; that is what makes it a location, not a guess.
  {
    const page = await pageOf('../fixtures/preset-switches/preset-410-pp2-reverb1.bin');
    assertEqual(page.switches[0]!.targetIndex, 20, 'PP#1 back to Filter 4 (the control)');
    assertEqual(page.switches[1]!.targetIndex, 51, 'PP#2 target reads 51 — the value predicted before the capture');
    assertEqual(page.switches[1]!.targetLabel, 'Reverb 1', 'and the anchor names it "Reverb 1"');
    assertEqual(page.switches[1]!.confidence, 'measured', 'so PP#2 is a fully measured row');
  }

  // 13. The FIFTH capture (E): the stride PREDICTION over a second index — PP#3 configured (Effect: Bypass →
  //     Chorus 1) with 172 stated in advance, and PP#2 back on FB Rtn 2 reproducing 14.
  {
    const page = await pageOf('../fixtures/preset-switches/preset-410-pp2-fbrtn2-pp3-chorus1.bin');
    assertEqual(page.switches[1]!.targetIndex, 14, 'PP#2 target → 14 = FB Rtn 2 (reproduced from a different direction)');
    const pp3 = page.switches[2]!;
    assertEqual(pp3.actionCode, 0x04, 'PP#3 action code is a THIRD observed u16 slot (marker+8: stride 2 holds)');
    assertEqual(pp3.targetIndex, 2, 'and PP#3 target reads 2 = Chorus 1 (marker+172, stride 12 — predicted, then read)');
    assertEqual(pp3.targetLabel, 'Chorus 1', 'named by the anchor measured on 2026-10-07');
    assertEqual(page.switches[3]!.confidence, 'measured', 'PP#4 in THIS capture reads 0/0 — its offsets exist, its assignment does not');
  }

  // 14. The SIXTH capture (F): the stride over two more indices, both stated in advance — PP#4 → Delay 2 (8 at
  //     marker+184) and PP#5 → Reverb 1 (51 at marker+196), with their action codes at marker+10/12.
  {
    const page = await pageOf('../fixtures/preset-switches/preset-410-pp4-delay2-pp5-reverb1.bin');
    const pp4 = page.switches[3]!;
    assertEqual(pp4.actionCode, 0x04, 'PP#4 action code reads 0x04 at marker+10');
    assertEqual(pp4.targetIndex, 8, 'PP#4 target reads 8 = Delay 2 at marker+184 — predicted, then read');
    assertEqual(pp4.targetLabel, 'Delay 2', 'named by the anchor read off the wire on 2026-10-07');
    const pp5 = page.switches[4]!;
    assertEqual(pp5.actionCode, 0x04, 'PP#5 action code reads 0x04 at marker+12');
    assertEqual(pp5.targetIndex, 51, 'PP#5 target reads 51 = Reverb 1 at marker+196 — predicted, then read');
    assertEqual(page.switches[5]!.confidence, 'measured', 'and PP#6 is measured in the LATER capture (its offsets exist; here its bytes read 0)');
  }

  // 15. The SEVENTH capture (G): the entire remaining range in ONE edit — PP#6..PP#12 set to seven DISTINCT
  //     anchors, every value predicted in advance. This is also what turned the ASSUMED twelve-switch count
  //     into a measurement: PP#12's target byte at marker+280 read the predicted 3.
  {
    const page = await pageOf('../fixtures/preset-switches/preset-410-pp6-pp12.bin');
    const expect: Array<[number, number, string]> = [
      [6, 25, 'Gate 1'], [7, 27, 'GEQ 1'], [8, 29, 'In 1'], [9, 31, 'Looper'], [10, 32, 'Megatap 1'], [11, 38, 'MultDly 1']
    ];
    for (const [index, wanted, name] of expect) {
      const row = page.switches[index - 1]!;
      assertEqual(row.actionCode, 0x04, `PP#${index} action code reads 0x04 at marker+${4 + 2 * (index - 1)}`);
      assertEqual(row.targetIndex, wanted, `PP#${index} target reads ${wanted} = ${name} (predicted, then read)`);
      assertEqual(row.targetLabel, name, `and the measured anchor names it "${name}"`);
    }
    const pp12 = page.switches[11]!;
    assertEqual(pp12.actionCode, 0x04, 'PP#12 action code reads 0x04 at marker+26 — the stride covers the whole range');
    assertEqual(pp12.targetIndex, 3, 'PP#12 target reads 3 = Chorus 2 at marker+280 (predicted, then read)');
    assertEqual(pp12.targetLabel, 'Chorus 2', 'named by the anchor measured on 2026-10-07');
    assertEqual(page.switches.filter((s) => s.confidence === 'unknown').length, 10, 'ten of 24 remain unread (14–23)');
  }

  // 16. The EIGHTH capture (H): the unit has TWENTY-FOUR per-preset switches, not twelve — tested rather than
  //     believed. PP#13 and PP#24 (the two ends of the range FM3-Edit lists) were set to distinct known
  //     anchors, and all four predicted bytes read exactly, which also rules out "two blocks of twelve".
  {
    const page = await pageOf('../fixtures/preset-switches/preset-410-pp13-pp24.bin');
    const pp13 = page.switches[12]!;
    assertEqual(pp13.actionCode, 0x04, 'PP#13 action code reads 0x04 at marker+28');
    assertEqual(pp13.targetIndex, 25, 'PP#13 target reads 25 = Gate 1 at marker+292 (predicted)');
    const pp24 = page.switches[23]!;
    assertEqual(pp24.actionCode, 0x04, 'PP#24 action code reads 0x04 at marker+50 (predicted)');
    assertEqual(pp24.targetIndex, 32, 'PP#24 target reads 32 = Megatap 1 at marker+424 (predicted)');
    assertEqual(pp24.targetLabel, 'Megatap 1', 'named by the anchor measured on 2026-10-07');
    assertEqual(page.switches[13]!.confidence, 'unknown', 'and PP#14 is still unread — the stride across 14–23 is NOT extrapolated');
  }

  // 10. Write-safety: read-only → 403 (both surfaces); `?dryRun=true` → 400, because a read-modify-write
  //    has no preview and a preview must never fall through to a live write.
  {
    const { app, registry, mock } = await buildTestApp(MODEL, stubDriver({ setPerPresetSwitch: async (i: number) => ({ ok: true, index: i, requested: {}, readback: null }) }) as never);
    const before = mock.sent.length;
    const dry = await app.inject({ method: 'PUT', url: '/preset/switches/1?dryRun=true', payload: { targetIndex: 51 } });
    assertEqual(dry.statusCode, 400, 'dry run of the switch write → 400');
    assertEqual((dry.json() as { error: string }).error, 'dry-run-unsupported', 'named as unsupported');
    assertEqual(mock.sent.length, before, 'and it sent NOTHING');

    const ro = await buildTestApp(MODEL, stubDriver({ setPerPresetSwitch: async (i: number) => ({ ok: true, index: i, requested: {}, readback: null }) }) as never, { writes: false });
    const roRes = await ro.app.inject({ method: 'PUT', url: '/preset/switches/1', payload: { targetIndex: 51 } });
    assertEqual(roRes.statusCode, 403, 'read-only switch write → 403');
    const router = createRouter({ registry, store: store.defaultStore, writes: false });
    const rtr = await router.handle('PUT', '/preset/switches/1', JSON.stringify({ targetIndex: 51 }));
    assertEqual(rtr.status, 403, 'read-only 403 parity (app ↔ router)');
    await app.close();
    await ro.app.close();
  }
}
