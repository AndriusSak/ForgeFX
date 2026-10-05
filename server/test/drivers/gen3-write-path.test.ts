// Gen-3 (FM3) WRITE-PATH guards for workstream W1 — mocked transport + the REAL static FM3 profile,
// NO hardware.
//
// W1.1 setBypass / setChannel must watch for a 0x64 rejection of the function they sent, instead of
//      always answering {ok:true} (docs/write-protocol.md: "the accept/reject model — the device sends
//      nothing on accept; on rejection it returns a 0x64 whose body is [echoedFn, resultCode]").
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES } from '../../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import type { DeviceEvent } from '../../src/drivers/types.js';
import { MockTransport, assert } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
const AMP_EID = effectRoster().find((e) => e.slug === 'amp')!.page; // DISTORT family, instance 1

export const GEN3_WRITE_PATH_CASE_COUNT = 5;

function sysex(fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}

function makeGen3(): { driver: ReturnType<typeof createGen3Driver>; mock: MockTransport; events: DeviceEvent[] } {
  const mock = new MockTransport('serial', 'mock-gen3-write');
  mock.isOpen = true;
  const events: DeviceEvent[] = [];
  const driver = createGen3Driver(PROFILES[MODEL]!, {
    transport: async () => mock,
    emit: (e) => events.push(e),
    getCadence: () => cadenceFor(MODEL, 'balanced')
  });
  return { driver, mock, events };
}

export async function runGen3WritePathTests(): Promise<void> {
  // ── W1.1: setBypass / setChannel reject reporting ───────────────────────────────────────────────
  // A 0x64 echoing the function THIS write sent is a genuine rejection → ok:false.
  {
    const { driver, mock } = makeGen3();
    mock.reply = (req) => [sysex(0x64, [req[5]!, 0x0b])]; // echoedFn = the fn we sent
    const r = await driver.setBypass(AMP_EID, true);
    assert(!r.ok, 'setBypass: a 0x64 echoing our own fn (0x0A) is a rejection — ok:false');
  }
  // Silence on accept stays accepted.
  {
    const { driver, mock } = makeGen3();
    mock.reply = () => [];
    const r = await driver.setBypass(AMP_EID, true);
    assert(r.ok, 'setBypass: no 0x64 reply ⇒ accepted');
  }
  // A stray/late rejection for ANOTHER function must not be misattributed.
  {
    const { driver, mock } = makeGen3();
    mock.reply = () => [sysex(0x64, [0x1f, 0x0b])];
    const r = await driver.setBypass(AMP_EID, true);
    assert(r.ok, 'setBypass: a 0x64 echoing a different fn (0x1f) is not ours — stays ok');
  }
  // setChannel (FM3 uses the fn-0x01 native write shape) — rejection + accept.
  {
    const { driver, mock } = makeGen3();
    mock.reply = (req) => [sysex(0x64, [req[5]!, 0x0b])];
    const r = await driver.setChannel(AMP_EID, 'B');
    assert(!r.ok, 'setChannel: a 0x64 echoing our own fn is a rejection — ok:false');
  }
  {
    const { driver, mock } = makeGen3();
    mock.reply = () => [];
    const r = await driver.setChannel(AMP_EID, 'B');
    assert(r.ok, 'setChannel: no 0x64 reply ⇒ accepted');
  }
}
