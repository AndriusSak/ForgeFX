// 0x64 rejection ATTRIBUTION on the gen-3 write path.
//
// docs/write-protocol.md: "The device sends nothing on accept. On rejection it returns a 0x64
// MULTIPURPOSE_RESPONSE whose 2-byte body is [echoedFn, resultCode]. Fm3Device.SendWrite sends a frame
// and watches a short window for a 0x64 rejection OF THE FUNCTION IT SENT; no rejection ⇒ accepted."
//
// #write used to fail on ANY 0x64 seen in its 120 ms window — so a stray/late rejection for another
// operation (a refused bulk read, a queued write, a previous op's error) was misattributed to this write
// and reported as a rejected user action. The echoed function byte is the documented discriminator.
//
// Mocked transport + the REAL static FM3 profile: no hardware.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES } from '../../src/devices.js';
import { MockTransport, assert } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
const FN_PARAMETER_SETGET = 0x01; // the fn every #write-based op (scene/preset name, type) is built on

export const WRITE_REJECTION_CASE_COUNT = 3;

function sysex(fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}

/** Run one scene-name write with the mock answering every request with a 0x64 echoing `echoedFn`. */
async function writeWithRejection(echoedFn: number | null): Promise<{ ok: boolean }> {
  const mock = new MockTransport('serial', 'mock-0x64');
  mock.isOpen = true;
  mock.reply = () => {
    if (echoedFn === null) return []; // accept: the device stays silent
    return [sysex(0x64, [echoedFn, 0x0b])]; // MULTIPURPOSE_RESPONSE: [echoedFn, resultCode]
  };
  const driver = createGen3Driver(PROFILES[MODEL]!, {
    transport: async () => mock,
    emit: () => {},
    getCadence: () => cadenceFor(MODEL, 'balanced')
  });
  return driver.setSceneName!(0, 'Test Scene');
}

export async function runWriteRejectionTests(): Promise<void> {
  // 1. A rejection for ANOTHER function must not be attributed to this write.
  const foreign = await writeWithRejection(0x1f); // a refused bulk read, not our fn 0x01 write
  assert(foreign.ok, 'a 0x64 echoing a different function (0x1f) is not our rejection — write stays ok');

  // 2. A rejection echoing THIS write's function is a genuine reject.
  const ours = await writeWithRejection(FN_PARAMETER_SETGET);
  assert(!ours.ok, 'a 0x64 echoing our own function (0x01) is a rejection — ok:false');

  // 3. Silence on accept stays accepted.
  const accepted = await writeWithRejection(null);
  assert(accepted.ok, 'no 0x64 reply at all ⇒ accepted');
}
