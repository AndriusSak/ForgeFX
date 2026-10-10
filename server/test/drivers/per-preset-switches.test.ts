// Gen-3 PER-PRESET SWITCH definitions (§3.8) — the read route and the per-FIELD write bound.
//
// The fixtures are the owner's real preset 410 dumps. Capture A (`preset-perform/preset-410.bin`) has the
// switch block PRESENT but UNCONFIGURED — that pins the marker's position in a real decompressed body and
// confirms marker+148 as PP#1's target byte. Captures B–E are one edit each by the owner plus one read-only
// dump; PP#2's and PP#3's target bytes (marker+160, marker+172) were located BY PREDICTION, and both
// predictions were stated before the capture was read (`check-switch-offsets.ts` re-runs all four steps).
// Everything past PP#3 is absent from the codec's offset table and therefore reads nothing — never a guess.
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
export const PER_PRESET_SWITCH_DRIVER_CASE_COUNT = 16;

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
    assertEqual(page.switches[3]!.confidence, 'unknown', 'PP#4: no observed offset');
    assertEqual(page.switches[3]!.actionCode, null, 'so it reports NO action code');
    assertEqual(page.switches[3]!.targetIndex, null, 'and NO target');
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

  // 5. The write bound is EVIDENCE-DRIVEN per field, and it MOVED with the measurement: PP#1–PP#3 are
  //    writable (both fields), PP#4 has no observed offset at all.
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
    const res = await makeDriver(mock).setPerPresetSwitch!(4, { actionCode: 0x04 });
    assertEqual(res.ok, false, 'PP#4 has no observed offset at all');
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

    const noOffset = await app.inject({ method: 'PUT', url: '/preset/switches/4', payload: { actionCode: 4 } });
    assertEqual(noOffset.statusCode, 400, 'PP#4 has no observed offset → 400');
    const body = noOffset.json() as { error: string; writableIndices: number[] };
    assert(/PP#4 has no observed byte offset/.test(body.error), 'and the error names the index and the reason');
    assertEqual(body.writableIndices.join(','), '1,2,3', 'listing exactly the indices the codec has measured');

    const empty = await app.inject({ method: 'PUT', url: '/preset/switches/1', payload: {} });
    assertEqual(empty.statusCode, 400, 'an empty patch → 400');
    const zero = await app.inject({ method: 'PUT', url: '/preset/switches/0', payload: { targetIndex: 1 } });
    assertEqual(zero.statusCode, 400, 'index 0 → 400');

    const router = createRouter({ registry, store: store.defaultStore });
    const rtr = await router.handle('PUT', '/preset/switches/4', JSON.stringify({ actionCode: 4 }));
    assertEqual(rtr.status, 400, 'and the runtime router agrees on the refusal (parity)');
    assertEqual(rtr.body, noOffset.payload, 'with the identical body');
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
    assertEqual(page.evidence.actionCodeIndices.join(','), '1,2,3', 'three action-code offsets are observed');
    assertEqual(page.evidence.targetByteIndices.join(','), '1,2,3', 'and three target bytes');
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
    assertEqual(page.switches[3]!.confidence, 'unknown', 'PP#4 is still unobserved — the stride is NOT extrapolated to it');
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
