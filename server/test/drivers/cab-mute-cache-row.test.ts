// The Cab block's per-cab Mute/Solo state — with the DEVICE CACHE in the picture.
//
// The FM3 Cab layout serves an M and an S button for BOTH cab slots (CABINET_BTN_MUTE1/2), but the
// parameter they drive (CABINET_MUTE1/2, pids 24/25) comes from the profile's RANGES — and those are
// merged from the device's on-connect self-describe cache OVER the static catalogue ("device-true
// wins", see runtimeProfileFrom). A degenerate cached row (zero-width display range) carries no
// information, yet used to win the merge and DELETE the enum: the driver then served no MUTE2 at all,
// cab 2's M/S button bound to nothing, and the control vanished from the UI — the reported
// "Mute 2 does not exist anywhere in cab tab or anywhere else".
//
// Verified against the real device response: its Cab page serves MUTE1 but jumps straight to
// pid 30, while pids 40 (Zoom) and 62 (Low Cut 1) appear as ENUMS there though the shipped FM3
// catalogue has them as floats — proof the live profile's ranges really do come from the cache.
//
// A cache row may REFINE a param; it must not delete one the device's own layout still references.
import { PROFILES, runtimeProfileFrom } from '../../src/devices.js';
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
const CAB_EID = effectRoster().find((e) => e.slug === 'cab')!.page;
const compactHex = (f: readonly number[]) => f.map((b) => b.toString(16).padStart(2, '0')).join('');
const enc14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];
function sysex(fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}
function blockBulkFrames(eid: number, values: readonly number[]): number[][] {
  const body: number[] = [0x00, 0x02];
  for (const v of values) body.push(...packValue16(v));
  return [sysex(0x74, [...enc14(eid), ...enc14(values.length), 0x07]), sysex(0x75, body), sysex(0x76, [])];
}

/** Serve the Cab block through a driver built on `profile`, with a mocked device bulk read. */
async function serveCabEnums(profile: (typeof PROFILES)[number]) {
  const stride = profile.rangeSections['CABINET']?.stride ?? 1;
  const values = new Array(Math.max(stride, 1) * 4).fill(0);
  values[31] = 1; // CABINET_MODE = DYNA-CAB → the DynaCab page
  const bulk = blockBulkFrames(CAB_EID, values);
  const codec = createModernFractalCodec(profile.model);
  const mock = new MockTransport('serial', 'mock-cab-mute-cache');
  mock.isOpen = true;
  mock.reply = (req) => (compactHex(req) === compactHex(codec.buildBlockBulkReadPoll(CAB_EID)) ? bulk : []);
  const driver = createGen3Driver(profile as never, {
    transport: async () => mock,
    emit: () => {},
    getCadence: () => cadenceFor(profile.model, 'balanced')
  } as never);
  return (await driver.blockParams(CAB_EID)).enums;
}

export const CAB_MUTE_CACHE_ROW_CASE_COUNT = 3;

export async function runCabMuteCacheRowTests() {
  const staticProfile = PROFILES[MODEL]!;

  // 1. baseline: the catalogue alone serves both cab slots' state
  {
    const enums = await serveCabEnums(staticProfile);
    const m1 = enums.find((e) => e.id === 24);
    const m2 = enums.find((e) => e.id === 25);
    assert(m1, 'baseline: MUTE1 (24) must be served');
    assert(m2, 'baseline: MUTE2 (25) must be served');
    assertEqual(m2!.name, 'MUTE2', 'baseline: pid 25 is MUTE2');
    assertEqual(m2!.options.length, 3, 'baseline: MUTE2 offers -- / MUTE / SOLO');
  }

  // 2. the reported failure: the device's cache describes pid 25 as a degenerate zero-width range.
  //    That row says nothing about the param, so it must not beat the catalogue's enum — the Cab
  //    layout still ships a M/S button for cab 2.
  {
    const degraded = runtimeProfileFrom(
      { ranges: { CABINET: { 25: { kind: 'float', displayMin: 0, displayMax: 0, typecode: 0 } } } } as never,
      staticProfile
    );
    const enums = await serveCabEnums(degraded as never);
    const m2 = enums.find((e) => e.id === 25);
    assert(m2, `a degenerate cached row must not delete MUTE2 — served ids: ${enums.map((e) => e.id).join(',')}`);
    assertEqual(m2!.name, 'MUTE2', 'the surviving row is the catalogue MUTE2');
    assertEqual(m2!.options.length, 3, 'and it still offers -- / MUTE / SOLO');
  }

  // 3. but a USABLE cache row still wins — device refinement is preserved, this is not a blanket
  //    override of device truth.
  {
    const refined = runtimeProfileFrom(
      { ranges: { CABINET: { 25: { kind: 'enum', displayMin: 0, displayMax: 1, typecode: 16, enumCount: 2 } } } } as never,
      staticProfile
    );
    const enums = await serveCabEnums(refined as never);
    const m2 = enums.find((e) => e.id === 25);
    assert(m2, 'a usable cached row keeps pid 25 served');
    assertEqual(m2!.options.length, 2, 'and its narrower device-true range wins over the catalogue');
  }
}
