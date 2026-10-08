// Gen-3 PER-PRESET PERFORMANCE PAGE read-back (parity audit §2.2). The codec's `parsePerformPage`
// decodes the ten (effectId, paramId) slots + their labels from a decompressed preset body; this
// suite pins that they REACH the driver through the new READ-ONLY `performPage()` method (GET
// /preset/perform) — one preset dump, decoded via the SAME body path as `presetModifiers()`.
//
// Offline/mocked, NO hardware: the fixture is the owner's six-control preset 410 (a real FM3 0x77/
// 0x78×8/0x79 edit-buffer dump) served verbatim through MockTransport.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { PROFILES } from '../../src/devices.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
export const PERFORM_PAGE_CASE_COUNT = 5;

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

function makeDriverWithDump(frames: number[][]): { driver: ReturnType<typeof createGen3Driver>; mock: MockTransport } {
  const mock = new MockTransport('serial', 'mock-perform');
  mock.isOpen = true;
  mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(MODEL)] : frames);
  const driver = createGen3Driver(PROFILES[MODEL]!, {
    transport: async () => mock,
    emit: () => {},
    getCadence: () => cadenceFor(MODEL, 'balanced')
  });
  return { driver, mock };
}

export async function runPerformPageTests(): Promise<void> {
  const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL('../fixtures/preset-perform/preset-410.bin', import.meta.url))));
  const frames = framesFrom(bytes);

  // Sanity: the fixture IS the stored-preset dump chain (0x77 head, 8× 0x78 body, 0x79 terminator).
  assertEqual(frames.length, 10, 'establishing: preset-410 is a 10-frame dump chain');
  assertEqual(frames[0]![5], 0x77, 'establishing: first frame is the dump head (fn 0x77)');
  assertEqual(frames[9]![5], 0x79, 'establishing: last frame is the dump terminator (fn 0x79)');

  // 1. performPage() decodes the page from ONE dump request and reports the six assigned controls.
  const { driver, mock } = makeDriverWithDump(frames);
  const page = await driver.performPage!();
  assert(page, 'performPage() returns a page for a preset that has one (got undefined)');
  assertEqual(page.slots.length, 10, 'the page always carries the ten editor slots');
  assertEqual(page.assigned, 6, 'preset-410 has exactly six assigned performance controls');

  // 2. Slots 1-6 are the owner's six controls: effectId/paramId + labels in slot order.
  const bySlot = new Map(page.slots.map((s) => [s.slot, s]));
  const expect: Array<[number, number, number, string, string]> = [
    [1, 58, 11, 'AMP', 'Master Volume'],
    [2, 70, 10, 'DLY1', 'Feedback'],
    [3, 66, 9, 'REV', 'Pre-Delay'],
    [4, 66, 22, 'REV', 'Bypass'],
    [5, 62, 41, 'CAB', 'Proximity Frequ'], // >32-byte label is TRUNCATED (measured caveat)
    [6, 118, 2, 'DRV1', 'Tone']
  ];
  for (const [slot, eid, pid, eLabel, pLabel] of expect) {
    const s = bySlot.get(slot)!;
    assertEqual(s.effectId, eid, `slot ${slot} effectId`);
    assertEqual(s.paramId, pid, `slot ${slot} paramId`);
    assertEqual(s.effectLabel, eLabel, `slot ${slot} effectLabel`);
    assertEqual(s.paramLabel, pLabel, `slot ${slot} paramLabel`);
  }

  // 3. Slots 7-10 are UNASSIGNED (effectId 0). The body still carries STALE label text from a former
  //    occupant ("ate" = the tail of "Rate") — so the effect label reads empty and the param label is
  //    stale. This is the honesty case the UI must render as "unassigned", never as a live name.
  for (const slot of [7, 8, 9, 10]) {
    const s = bySlot.get(slot)!;
    assertEqual(s.effectId, 0, `slot ${slot} is unassigned (effectId 0)`);
    assertEqual(s.paramId, 0, `slot ${slot} paramId is 0 when unassigned`);
    assertEqual(s.effectLabel, '', `slot ${slot} effectLabel is empty when unassigned`);
    assertEqual(s.paramLabel, 'ate', `slot ${slot} carries STALE leftover text (the UI must blank it)`);
  }

  // 4. READ-ONLY: the whole read is ONE preset-dump REQUEST (fn 0x03) — nothing is written to the unit.
  assertEqual(mock.sent.length, 1, 'performPage() issues exactly one request frame (one dump)');
  assertEqual(mock.sent[0]![5], 0x03, 'and it is the preset-dump REQUEST (fn 0x03), not a write');
}
