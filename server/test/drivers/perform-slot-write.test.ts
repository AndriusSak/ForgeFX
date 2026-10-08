// Gen-3 PER-PRESET PERFORMANCE PAGE — the WRITE side (parity audit §2.2). The codec's
// `patchPerformSlot` patches a slot's effect/param ids AND its labels in the decompressed body and the
// recompress/reframe/retarget path is the one a host-written dump already proved on the unit
// (scripts/try-preset-write.ts, 2026-10-08). This suite pins the DRIVER method (`setPerformSlot`,
// PUT /preset/perform/:slot) + the route surface.
//
// The `ok` verdict is a READ-BACK of the edit buffer, never the absence of a rejection — so the mock
// device must ADOPT what is written to it. A mock that always answers the ORIGINAL dump makes every
// write look refused; one that always echoes the patch makes every write look accepted. Neither is a
// test. `makeEditBufferMock` does the minimum honest thing: the last 0x77/0x78/0x79 chain sent becomes
// what the next dump returns.
//
// Offline/mocked, NO hardware: the fixture is the owner's six-control preset 410 (a real FM3
// 0x77/0x78×8/0x79 dump) served verbatim through MockTransport.
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
export const PERFORM_SLOT_WRITE_CASE_COUNT = 9;

/** Split a concatenated F0..F7 byte stream into SysEx frames. */
function framesFrom(bytes: Uint8Array): number[][] {
  const frames: number[][] = [];
  let cur: number[] | null = null;
  for (const b of bytes) {
    if (b === 0xf0) cur = [b];
    else if (cur) { cur.push(b); if (b === 0xf7) { frames.push(cur); cur = null; } }
  }
  return frames;
}

/** A MockTransport whose edit buffer ADOPTS what is written to it: a dump request (fn 0x03) answers
 *  with whatever the last 0x77/0x78/0x79 chain left in the buffer. That is the only shape in which a
 *  read-back verdict can be exercised at all. */
function makeEditBufferMock(frames: number[][]): MockTransport {
  const mock = new MockTransport('serial', 'mock-perform-write');
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

/** A minimal driver stub carrying only what THIS route touches — `modelId` (the registry keys on it)
 *  and, optionally, `setPerformSlot`. `capabilities` is a PROPERTY, not a method (see makeGen3Fake in
 *  device-cache.test.ts); it is only read by other routes, so an empty object is enough here. */
function stubDriver(extra: Record<string, unknown> = {}): unknown {
  return { modelId: MODEL, key: 'fm3', name: 'FM3', capabilities: {}, ...extra };
}

/** A driver over `mock` (the same wiring the perform-page READ suite uses). */
function makeDriver(mock: MockTransport): ReturnType<typeof createGen3Driver> {
  return createGen3Driver(PROFILES[MODEL]!, {
    transport: async () => mock,
    emit: () => {},
    getCadence: () => cadenceFor(MODEL, 'balanced')
  });
}

export async function runPerformSlotWriteTests(): Promise<void> {
  const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL('../fixtures/preset-perform/preset-410.bin', import.meta.url))));
  const frames = framesFrom(bytes);
  assertEqual(frames.length, 10, 'establishing: preset-410 is a 10-frame dump chain');

  // 1. A successful round trip: ids AND labels patched, confirmed by a read-back of the edit buffer.
  {
    const mock = makeEditBufferMock(frames);
    const res = await makeDriver(mock).setPerformSlot!(1, { effectId: 62, paramId: 41, effectLabel: 'CAB', paramLabel: 'Proximity Frequ' });
    assert(res.ok, `setPerformSlot must confirm by read-back (got ${JSON.stringify(res)})`);
    assertEqual(res.readback!.effectId, 62, 'read-back effectId');
    assertEqual(res.readback!.paramId, 41, 'read-back paramId');
    assertEqual(res.readback!.effectLabel, 'CAB', 'read-back effectLabel');
    assertEqual(res.readback!.paramLabel, 'Proximity Frequ', 'read-back paramLabel');

    // The op starts with a dump REQUEST and ends with the read-back dump REQUEST; between them is the
    // rebuilt dump, sent frame by frame. Keep only those (drop the two fn 0x03 reads).
    assertEqual(mock.sent[0]![5], 0x03, 'the op starts with a preset-dump REQUEST (fn 0x03)');
    const wrote = mock.sent.slice(1).filter((f) => f[5] !== 0x03);
    assertEqual(mock.sent[mock.sent.length - 1]![5], 0x03, 'and ends with the read-back dump request');
    assert(wrote.length >= 3, `the rebuilt dump is re-sent frame by frame (got ${wrote.length})`);
    assertEqual(wrote[0]![5], 0x77, 'the re-sent stream starts with a dump header');
    assertEqual(wrote[wrote.length - 1]![5], 0x79, 'and ends with the dump terminator');
    assert(wrote.some((f) => f[5] === 0x78), 'and carries its body chunks');
    // Retargeted to the EDIT BUFFER (0x3FFF = 7F 7F at the header's numHi/numLo) — never a stored slot.
    assertEqual(wrote[0]![6], 0x7f, 'the re-sent header is retargeted to the edit buffer (numHi)');
    assertEqual(wrote[0]![7], 0x7f, 'the re-sent header is retargeted to the edit buffer (numLo)');
  }

  // 2. A label longer than the 32-byte window is TRUNCATED (15 chars), and the write still reads back
  //    confirmed — a legitimately truncated label must not be misreported as a failed write.
  {
    const mock = makeEditBufferMock(frames);
    const res = await makeDriver(mock).setPerformSlot!(2, { paramLabel: 'abcdefghijklmnopqrst' });
    assert(res.ok, `a truncated label must still confirm (got ${JSON.stringify(res)})`);
    assertEqual(res.readback!.paramLabel, 'abcdefghijklmno', 'the read-back is the truncated 15-char label');
  }

  // 3. An ids-only patch leaves the slot's OLD labels in place — the stale-name hazard the caller must
  //    avoid by patching both together (the WRITE side does not invent a name for the new target).
  {
    const mock = makeEditBufferMock(frames);
    const res = await makeDriver(mock).setPerformSlot!(1, { effectId: 62, paramId: 41 });
    assert(res.ok, `ids-only patch reads back confirmed (got ${JSON.stringify(res)})`);
    assertEqual(res.readback!.effectId, 62, 'the id changed');
    assertEqual(res.readback!.effectLabel, 'AMP', 'the OLD effect label is still there (stale, not rewritten)');
    assertEqual(res.readback!.paramLabel, 'Master Volume', 'and the OLD param label too');
  }

  // 4. A device that ignores the write reports FAILURE, not success: `ok` is the read-back verdict, so
  //    a silently-dropped dump is {ok:false, reason:'readback-mismatch'} even though nothing rejected it.
  {
    const mock = new MockTransport('serial', 'mock-ignore-write');
    mock.isOpen = true;
    mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(MODEL)] : frames); // always the ORIGINAL
    const res = await makeDriver(mock).setPerformSlot!(1, { effectId: 62, paramId: 41 });
    assertEqual(res.ok, false, 'a write the unit ignores must NOT report ok:true');
    assertEqual(res.reason, 'readback-mismatch', 'and it names the read-back mismatch');
    assert(res.readback, 'the read-back is still reported, so the caller can see what the unit holds');
    assertEqual(res.readback!.effectId, 58, 'which is the UNCHANGED slot (58 = AMP)');
  }

  // 5. A slot outside 1..10 is refused BEFORE anything is written — one dump request, no frames.
  {
    const mock = makeEditBufferMock(frames);
    const res = await makeDriver(mock).setPerformSlot!(11, { effectId: 62 });
    assertEqual(res.ok, false, 'slot 11 is refused');
    assertEqual(res.reason, 'slot-out-of-range', 'with the slot bound named');
    assertEqual(mock.sent.length, 1, 'and NOTHING was written (only the initial dump request)');
    assertEqual(mock.sent[0]![5], 0x03, 'the one frame sent is the read, not a write');
  }

  // 6. Route validation: slot out of range and an empty patch both answer 400 (fail closed).
  {
    const { app } = await buildTestApp(
      MODEL,
      stubDriver({ setPerformSlot: async () => ({ ok: true, slot: 1, requested: {}, readback: null }) }) as never
    );
    const badSlot = await app.inject({ method: 'PUT', url: '/preset/perform/11', payload: { effectId: 62 } });
    assertEqual(badSlot.statusCode, 400, 'PUT /preset/perform/11 → 400');
    const empty = await app.inject({ method: 'PUT', url: '/preset/perform/1', payload: {} });
    assertEqual(empty.statusCode, 400, 'an empty patch → 400 (at least one field is required)');
    await app.close();
  }

  // 7. `?dryRun=true` is REFUSED (400) on this write: its frames come from a device READ, so a captured
  //    preview would be a guaranteed decode failure — and a preview must never fall through to a live
  //    write. The refusal is identical on both surfaces (parity), and sends nothing.
  {
    const { app, registry, mock } = await buildTestApp(MODEL);
    const before = mock.sent.length;
    const dry = await app.inject({ method: 'PUT', url: '/preset/perform/1?dryRun=true', payload: { effectId: 62 } });
    assertEqual(dry.statusCode, 400, 'a dry run of a read-modify-write → 400');
    assertEqual((dry.json() as { error: string }).error, 'dry-run-unsupported', 'and it names the reason');
    assertEqual(mock.sent.length, before, 'the refused dry run sent NOTHING');

    const router = createRouter({ registry, store: store.defaultStore });
    const rtr = await router.handle('PUT', '/preset/perform/1?dryRun=true', JSON.stringify({ effectId: 62 }));
    assertEqual(rtr.status, dry.statusCode, 'dry-run refusal status parity (app ↔ router)');
    assertEqual(rtr.body, dry.payload, 'dry-run refusal body parity (app ↔ router)');
    await app.close();
  }

  // 8. Read-only server: the write answers 403 and sends nothing; the READ stays available.
  {
    const { app, registry, mock } = await buildTestApp(MODEL, undefined, { writes: false });
    const before = mock.sent.length;
    const w = await app.inject({ method: 'PUT', url: '/preset/perform/1', payload: { effectId: 62 } });
    assertEqual(w.statusCode, 403, 'read-only perform-slot write → 403');
    assertEqual(mock.sent.length, before, 'read-only sent nothing');

    const router = createRouter({ registry, store: store.defaultStore, writes: false });
    const rtr = await router.handle('PUT', '/preset/perform/1', JSON.stringify({ effectId: 62 }));
    assertEqual(rtr.status, 403, 'read-only 403 parity (app ↔ router)');
    await app.close();
  }

  // 9. A driver without the capability answers 501, like every other optional driver method.
  {
    const { app } = await buildTestApp(MODEL, stubDriver() as never);
    const res = await app.inject({ method: 'PUT', url: '/preset/perform/1', payload: { effectId: 62 } });
    assertEqual(res.statusCode, 501, 'a device without setPerformSlot → 501 unsupported');
    assertEqual((res.json() as { capability: string }).capability, 'setPerformSlot', 'naming the capability');
    await app.close();
  }
}
