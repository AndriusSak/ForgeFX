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
export const PER_PRESET_SWITCH_DRIVER_CASE_COUNT = 28;

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
    assertEqual(page.switches[13]!.confidence, 'measured', 'PP#14: located by the category sweep (marker+30 / marker+304)');
    assertEqual(page.switches[17]!.confidence, 'measured', 'PP#18: BOTH fields are located now — its record+0 offset was located 2026-10-12 by the edit that set the row\'s "Effect" field to Cab 1 (the byte moved, which a zero could never show)');
    assertEqual(page.switches[23]!.confidence, 'measured', 'PP#24: marker+50 / marker+424, the far end of the range');
    assertEqual(page.switches.length, 24, 'twenty-four rows: the switch count came from FM3-Edit and was then MEASURED');
    assertEqual(page.switches.filter((s) => s.confidence === 'unknown').length, 0, 'no row is unread: all 24 action codes are located');
    assertEqual(page.switches.filter((s) => s.confidence === 'partial').length, 2, 'two partial rows (21, 22) — the per-FIELD bound, exercised for real. PP#23 left this set on 2026-10-12: the owner set its Control Switch number 1→4 and marker+412 moved 0x00→0x03, which located its record+0. The count moved 3 → 2 with it; this line still asserted 3 after the codec changed, and only the full stack gate caught it');
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
  {
    // The per-FIELD bound, exercised for real. It moved on 2026-10-12: PP#18's record+0 is LOCATED now (an edit
    // moved that byte, which a zero never could), so PP#21 — whose first record byte has only ever read zero —
    // is the case that still refuses. A bound keyed on the CATEGORY would have had to change here; a bound keyed
    // on the observation does not, which is the whole point of it.
    const mock = makeEditBufferMock(populatedFrames);
    const denied = await makeDriver(mock).setPerPresetSwitch!(21, { targetIndex: 3 });
    assertEqual(denied.ok, false, 'PP#21 + a target is refused');
    assertEqual(denied.reason, 'no-target-offset', 'and the reason names exactly which field is unlocated');
    assertEqual(mock.sent.length, 1, 'nothing was written (only the dump request)');
  }
  {
    // …while PP#18 now takes a target write, the thing that used to be refused on it.
    const mock = makeEditBufferMock(populatedFrames);
    const allowed = await makeDriver(mock).setPerPresetSwitch!(18, { targetIndex: 3 });
    assertEqual(allowed.ok, true, 'PP#18 takes a target write now that its record+0 offset is located');
  }
  {
    const mock = makeEditBufferMock(populatedFrames);
    const res = await makeDriver(mock).setPerPresetSwitch!(25, {});
    assertEqual(res.ok, false, 'an empty patch on an out-of-range index is refused too');
    assertEqual(mock.sent.length, 1, 'and nothing written');
  }

  // 6. Route validation, per FIELD, with both surfaces agreeing. All three refusals are exercised here:
  //    an index whose record+0 is unlocated (PP#18 — Effect: Parameter does not write that field), an index
  //    past the count (PP#25), and an empty patch.
  {
    const { app, registry } = await buildTestApp(MODEL, stubDriver({ setPerPresetSwitch: async (i: number) => ({ ok: true, index: i, requested: {}, readback: null }) }) as never);
    const pp2Target = await app.inject({ method: 'PUT', url: '/preset/switches/2', payload: { targetIndex: 51 } });
    assertEqual(pp2Target.statusCode, 200, 'PP#2 + target → 200 once its target byte is located');

    const actionOnly = await app.inject({ method: 'PUT', url: '/preset/switches/2', payload: { actionCode: 4 } });
    assertEqual(actionOnly.statusCode, 200, 'PP#2 + action code → 200');

    // PP#12 is writable like the rest. The refusals that remain are BOTH kinds, and both are worth pinning:
    // an index past the count entirely (PP#25), and the per-FIELD branch where an index HAS an action code but
    // its record+0 offset was never located — PP#21 is a live example of that today (21, 22 and 23; PP#18 was the
    // fourth until an edit moved its byte on 2026-10-12 and located it).
    const pp12 = await app.inject({ method: 'PUT', url: '/preset/switches/12', payload: { targetIndex: 3 } });
    assertEqual(pp12.statusCode, 200, 'PP#12 + target → 200');
    const located = await app.inject({ method: 'PUT', url: '/preset/switches/14', payload: { targetIndex: 3 } });
    assertEqual(located.statusCode, 200, 'PP#14 + target → 200: the sweep located its offsets');
    const perField = await app.inject({ method: 'PUT', url: '/preset/switches/21', payload: { targetIndex: 3 } });
    assertEqual(perField.statusCode, 400, 'PP#21 + target → 400: its code is located, its record+0 is not');
    assert(/target byte offset has not been located/.test((perField.json() as { error: string }).error), 'and the error names that field specifically');
    const nowLocated = await app.inject({ method: 'PUT', url: '/preset/switches/18', payload: { targetIndex: 3 } });
    assertEqual(nowLocated.statusCode, 200, 'PP#18 + target → 200 since 2026-10-12: the edit that moved its record+0 located that offset');
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
    assertEqual(page.evidence.actionCodeIndices.length, 24, 'all 24 action-code offsets are observed');
    assertEqual(page.evidence.targetByteIndices.join(','), '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,24', 'while the located record+0 set still skips 21, 22, 23 — NOT a range, and not a count');
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
    assertEqual(page.switches.filter((s) => s.confidence === 'partial').length, 3, 'and the three unlocated record+0 rows (21, 22, 23) are the only gap left');
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
    assertEqual(page.switches[13]!.confidence, 'measured', 'and PP#14 is measured too (the category sweep located it)');
  }

  // 17. The NINTH capture (I): a CATEGORY SWEEP — PP#14..PP#23 given ten different functions in one edit. It
  //     located every remaining slot AND showed that the action code names the CATEGORY (the three Effect
  //     functions set that day all read 0x04) while the function lives in the marker+52 array.
  {
    const page = await pageOf('../fixtures/preset-switches/preset-410-pp14-pp23-categories.bin');
    const codes: Array<[number, number, string]> = [
      [14, 0x03, 'Scene'], [15, 0x03, 'Scene'], [16, 0x03, 'scene flavour #2'],
      [17, 0x04, 'Effect function #2 (Chan Toggle)'], [18, 0x04, 'Effect function #3 (Chan Inc/Dec)'],
      [19, 0x02, 'Preset'], [20, 0x02, 'Preset'], [21, 0x05, 'Utility: Tuner'], [22, 0x08, 'Looper'], [23, 0x07, 'Control Switch']
    ];
    for (const [index, code, what] of codes) {
      assertEqual(page.switches[index - 1]!.actionCode, code, `PP#${index} (${what}) reads 0x${code.toString(16)}`);
    }
    assertEqual(page.switches[17]!.confidence, 'measured', 'PP#18 is MEASURED since 2026-10-12 (its record+0 offset was located by an edit that moved that byte); in THIS capture it reads 0 there');
    assertEqual(page.switches[17]!.targetIndex, 0, 'which is a reading of its "Effect" field (Amp 1), not an absence of one');
    assertEqual(page.switches[13]!.targetIndex, 3, 'PP#14 record+0 = 3 — the SCENE number, not an FX slot');
    assertEqual(page.switches[18]!.targetIndex, 28, 'PP#19 record+0 = 28 — a PRESET number');
    assertEqual(page.switches[20]!.targetIndex, null, 'PP#21 (Tuner) reports no record+0 at all: the whole record read zero, and a zero is not an observation');
  }

  // 18. The TENTH capture (ROUND 10, 2026-10-11): the ENUMERATION — one edit that finished the CATEGORY table.
  //     The seven codes this project had only PREDICTED all read exactly as stated before the dump, which is
  //     also what lets the codec name them now, and the same edit exposed the two new arrays.
  {
    const page = await pageOf('../fixtures/preset-switches/preset-410-enumeration.bin');
    const predicted: Array<[number, number, string]> = [
      [1, 0x01, 'Bank'], [2, 0x06, 'Layout'], [3, 0x09, 'Per-Preset'], [4, 0x0a, 'View'],
      [5, 0x0b, 'Setlist'], [6, 0x0c, 'Song'], [7, 0x0d, 'Song Section']
    ];
    for (const [index, code, name] of predicted) {
      assertEqual(page.switches[index - 1]!.actionCode, code, `PP#${index} reads 0x0${code.toString(16)} = ${name} — PREDICTED before this capture`);
      assertEqual(page.switches[index - 1]!.action, `${name} (category — the mode is in the record)`, `and ${name} is a NAME now, not a prediction`);
    }
    // The FUNCTION INDEX (marker+52): per category, so two categories can share a value; PP#14/15/17/18/19 are
    // Chan Select rows (index 1) and every one of them predicts the FX-slot meaning of record+0.
    assertEqual(page.switches[13]!.functionIndex, 1, 'PP#14 function index 1 = Chan Select');
    assertEqual(page.switches[13]!.functionName, 'Chan Select', 'named from the list the owner read off FM3-Edit');
    assertEqual(page.switches[13]!.targetIsFxSlot, true, 'so an FX-slot name applies to a Chan Select row…');
    assertEqual(page.switches[13]!.targetIndex, 2, '…and its record+0 is 2');
    assertEqual(page.switches[13]!.targetLabel, 'Chorus 1', 'which the anchor table names "Chorus 1" — the measurement that re-enabled the name');
    assertEqual(page.switches[14]!.targetIndex, 51, 'PP#15 (Chan Select → Reverb 1) records 51');
    assertEqual(page.switches[16]!.targetIndex, 7, 'PP#17 (Chan Select → Delay 1) records 7');
    assertEqual(page.switches[18]!.targetIndex, 28, 'PP#19 (Chan Select → GEQ 2) records 28 — a NEW anchor, consistent with the measured GEQ 1 = 27');
    assertEqual(page.switches[18]!.targetLabel, 'GEQ 2', 'and the table now carries it');
    assertEqual(page.switches[0]!.targetIsFxSlot, false, 'a BANK row may not be named by the FX-slot table — its byte is a bank number');
    assertEqual(page.switches[0]!.targetIndex, 1, 'even though the byte itself is observed');
    assertEqual(page.switches[16]!.functionName, 'Chan Select', 'PP#18 was set to Chan Select (FM3-Edit offers no "Parameter" function — that label was a doc guess)');
  }

  // 19. The HOLD half (marker+436 + 2·(index−1)) — read from the same capture: three HOLDs set, three codes out.
  {
    const page = await pageOf('../fixtures/preset-switches/preset-410-enumeration.bin');
    assertEqual(page.switches[15]!.holdActionCode, 0x08, 'PP#16 HOLD = 0x08 Looper');
    assertEqual(page.switches[15]!.holdAction, 'Looper (category — the mode is in the record)', 'named from the same code space as the TAP code');
    assertEqual(page.switches[16]!.holdActionCode, 0x05, 'PP#17 HOLD = 0x05 Utility (Utility: Tuner)');
    assertEqual(page.switches[17]!.holdActionCode, 0x07, 'PP#18 HOLD = 0x07 Control Switch');
    assertEqual(page.switches[14]!.holdActionCode, 0, 'a row with no HOLD reads 0…');
    assertEqual(page.switches[14]!.holdMeasured, false, '…and is flagged as never exercised: that zero is Unassigned by convention, not an observation');
    assertEqual(page.switches[15]!.holdMeasured, true, 'while the three the owner set are marked as exercised');
    assertEqual(page.evidence.holdMeasuredIndices.join(','), '16,17,18', 'and the exercised set travels with the page, separately from the located-offset lists');
  }

  // 20. The HOLD WRITE: read-back confirmed, and an ignoring device must NOT read as ok.
  {
    const enumeration = new Uint8Array(readFileSync(fileURLToPath(new URL('../fixtures/preset-switches/preset-410-enumeration.bin', import.meta.url))));
    const mock = makeEditBufferMock(framesFrom(enumeration));
    const res = await makeDriver(mock).setPerPresetSwitch!(20, { holdActionCode: 0x08 });
    assert(res.ok, `a HOLD-only write must confirm by read-back (got ${JSON.stringify(res)})`);
    assertEqual(res.readback!.holdActionCode, 0x08, 'read-back HOLD code');
    assertEqual(res.readback!.actionCode, 0x02, 'and the TAP side is untouched (PP#20 is Preset: Increment)');
    assertEqual(res.readback!.holdMeasured, false, 'with the zero-stood-alone flag intact for a row nobody exercised');
  }
  {
    const enumeration = new Uint8Array(readFileSync(fileURLToPath(new URL('../fixtures/preset-switches/preset-410-enumeration.bin', import.meta.url))));
    const frames = framesFrom(enumeration);
    const mock = new MockTransport('serial', 'mock-ignore-hold');
    mock.isOpen = true;
    mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(MODEL)] : req[5] === 0x03 ? frames : []);
    const res = await makeDriver(mock).setPerPresetSwitch!(20, { holdActionCode: 0x08 });
    assertEqual(res.ok, false, 'a device that ignores the HOLD write must not report ok:true');
    assertEqual(res.reason, 'readback-mismatch', 'the verdict is the read-back, as for every other field');
  }
  {
    const { app } = await buildTestApp(MODEL, stubDriver({
      setPerPresetSwitch: async (i: number, p: unknown) => ({ ok: true, index: i, requested: p, readback: null })
    }) as never);
    const holdOnly = await app.inject({ method: 'PUT', url: '/preset/switches/5', payload: { holdActionCode: 8 } });
    assertEqual(holdOnly.statusCode, 200, 'a HOLD-only patch → 200');
    const tooWide = await app.inject({ method: 'PUT', url: '/preset/switches/5', payload: { holdActionCode: 65536 } });
    assertEqual(tooWide.statusCode, 400, 'a HOLD code wider than 16 bits → 400');
    assert(/holdActionCode must be an integer/.test((tooWide.json() as { error: string }).error), 'with the field named');
    const negative = await app.inject({ method: 'PUT', url: '/preset/switches/5', payload: { holdActionCode: -1 } });
    assertEqual(negative.statusCode, 400, 'and a negative one → 400');
    const empty = await app.inject({ method: 'PUT', url: '/preset/switches/5', payload: {} });
    assertEqual(empty.statusCode, 400, 'an empty patch is still 400 — the HOLD did not become a free pass');
    await app.close();
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
