// Gen-3 PER-PRESET SWITCH definitions (§3.8) — the read route and the PP#1-bounded write.
//
// The fixture is the owner's real preset 410 dump (the same one the perform-page suite uses). Its switch
// block is PRESENT but UNCONFIGURED, which is itself the useful measurement here: it pins the marker's
// position in a real decompressed body and confirms the doc's one hard number — PP#1's target byte at
// absolute 11568 — as marker+148. Everything past PP#1 is INFERRED and the codec says so per row.
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
export const PER_PRESET_SWITCH_DRIVER_CASE_COUNT = 11;

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
    assertEqual(page.geometry, 'measured-pp1-only', 'the decode states how much of itself it can vouch for');
  }

  // 2. Row confidence is per row: PP#1 measured, every other row openly inferred.
  {
    const page = (await makeDriver(makeEditBufferMock(frames)).perPresetSwitches!())!;
    assertEqual(page.switches[0]!.index, 1, 'rows are 1-based');
    assertEqual(page.switches[0]!.confidence, 'measured', 'PP#1');
    assertEqual(page.switches[1]!.confidence, 'inferred', 'PP#2 is inferred — its offset was never observed');
    assertEqual(page.switches[0]!.action, 'unassigned', 'the unconfigured switch reads as unassigned');
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

  // 5. Any index but PP#1 is refused BEFORE the write — its offset has never been observed.
  {
    const mock = makeEditBufferMock(frames);
    const res = await makeDriver(mock).setPerPresetSwitch!(2, { targetIndex: 51 });
    assertEqual(res.ok, false, 'PP#2 is refused');
    assertEqual(res.reason, 'unsupported-index', 'with the reason named');
    assertEqual(mock.sent.length, 1, 'and NOTHING was written (only the initial dump request)');
  }

  // 6. Route validation: index ≠ 1 and an empty patch answer 400, and both surfaces agree.
  {
    const { app, registry } = await buildTestApp(MODEL, stubDriver({ setPerPresetSwitch: async (i: number) => ({ ok: true, index: i, requested: {}, readback: null }) }) as never);
    const other = await app.inject({ method: 'PUT', url: '/preset/switches/2', payload: { targetIndex: 51 } });
    assertEqual(other.statusCode, 400, 'PUT /preset/switches/2 → 400');
    const empty = await app.inject({ method: 'PUT', url: '/preset/switches/1', payload: {} });
    assertEqual(empty.statusCode, 400, 'an empty patch → 400');
    const zero = await app.inject({ method: 'PUT', url: '/preset/switches/0', payload: { targetIndex: 1 } });
    assertEqual(zero.statusCode, 400, 'index 0 → 400');
    const router = createRouter({ registry, store: store.defaultStore });
    const rtr = await router.handle('PUT', '/preset/switches/2', JSON.stringify({ targetIndex: 51 }));
    assertEqual(rtr.status, 400, 'and the runtime router agrees (parity)');
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

  // 9. The SECOND real capture — the same preset with PP#1 and PP#2 configured. This is the case that made
  //    `evidence` a per-field claim: the two-fixture differential moved marker+4 AND marker+6 (the action
  //    codes) but only ONE target byte offset has ever moved.
  {
    const page = await makeDriver(makeEditBufferMock(populatedFrames)).perPresetSwitches!();
    assert(page, 'the populated capture has a block');
    assertEqual(page.at, 11420, 'the marker is at the SAME body offset as the empty capture');
    assertEqual(page.at + 148, 11568, 'and marker+148 is still PP#1\'s target byte');
    assertEqual(page.populated, true, 'this one is populated');
    const pp1 = page.switches[0]!;
    assertEqual(pp1.actionCode, 0x04, 'PP#1 carries the Bypass action code');
    assertEqual(pp1.targetIndex, 20, 'targeting index 20');
    assertEqual(pp1.targetLabel, 'Filter 4', 'which the independently measured anchor names "Filter 4"');
    const pp2 = page.switches[1]!;
    assertEqual(pp2.actionCode, 0x03, 'PP#2 carries the scene-select code (the owner\'s second switch)');
    assertEqual(pp2.confidence, 'inferred', 'yet PP#2 still reports its geometry as inferred');
    assertEqual(page.evidence.actionCodesMeasured, 2, 'two action codes are measured');
    assertEqual(page.evidence.targetBytesMeasured, 1, 'one target byte is measured');
  }

  // 11. The THIRD capture (PP#1 → Delay 2): a new anchor, and the flat-target-array reading refuted. PP#2's
  //     action changed too, so if the target bytes were one-per-switch in a flat array, PP#2's target byte
  //     (marker+149) would have had to move. It did not.
  {
    const delay2 = new Uint8Array(readFileSync(fileURLToPath(new URL('../fixtures/preset-switches/preset-410-delay2.bin', import.meta.url))));
    const page = await makeDriver(makeEditBufferMock(framesFrom(delay2))).perPresetSwitches!();
    assert(page, 'the Delay-2 capture has a block');
    assertEqual(page.switches[0]!.targetIndex, 8, 'PP#1 now targets index 8');
    assertEqual(page.switches[0]!.targetLabel, 'Delay 2', 'which the wire anchor names "Delay 2"');
    assertEqual(page.switches[1]!.actionCode, 0x04, 'PP#2 action code changed to Effect: Bypass');
    assertEqual(page.switches[1]!.targetIndex, 0, 'yet the byte at marker+149 STAYED 0 — contiguous target array REFUTED');
    assertEqual(page.evidence.targetBytesMeasured, 1, 'so the decoder still claims only ONE measured target byte');
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
