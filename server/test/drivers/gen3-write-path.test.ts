// Gen-3 (FM3) WRITE-PATH guards for workstream W1 — mocked transport + the REAL static FM3 profile,
// NO hardware.
//
// W1.1 setBypass / setChannel must watch for a 0x64 rejection of the function they sent, instead of
//      always answering {ok:true} (docs/write-protocol.md: "the accept/reject model — the device sends
//      nothing on accept; on rejection it returns a 0x64 whose body is [echoedFn, resultCode]").
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES, SLUG_FAMILY } from '../../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import type { DeviceEvent } from '../../src/drivers/types.js';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
const AMP_EID = effectRoster().find((e) => e.slug === 'amp')!.page; // DISTORT family, instance 1

export const GEN3_WRITE_PATH_CASE_COUNT = 11;

const enc14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];

function sysex(fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}

/** fn=0x74/0x75/0x76 block-bulk-read reply carrying `values` (same shape as knob-coverage). */
function blockBulkFrames(effectId: number, values: readonly number[]): number[][] {
  const body: number[] = [0x00, 0x02];
  for (const v of values) body.push(...packValue16(v));
  return [
    sysex(0x74, [...enc14(effectId), ...enc14(values.length), 0x07]),
    sysex(0x75, body),
    sysex(0x76, [])
  ];
}

/** fn=0x13 status dump: one (eid, dd) triple per placed block (dd bit0=bypass, bits1-3=channel). */
function statusFrame(effectId: number, channel: number, bypassed = false): number[] {
  const dd = (channel << 1) | (bypassed ? 1 : 0);
  return sysex(0x13, [...enc14(effectId), dd]);
}

function familyForEid(eid: number): string {
  const slug = effectRoster().find((e) => e.page === eid)?.slug;
  return (slug && (SLUG_FAMILY as Record<string, string>)[slug]) || '';
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

  // ── W1.2: discrete writes must not carry an ordinal in `norm` ───────────────────────────────────
  // `norm` is the 0..1 normalized value; a discrete write's `value` is the enum/model ordinal, so it
  // must NOT be broadcast as a norm (Axis applies `p.norm = e.norm` verbatim → a norm of 16 everywhere).
  {
    const { driver, events } = makeGen3();
    await driver.setParam(AMP_EID, 16, 16, false); // discrete ordinal 16
    const paramEvents = events.filter((e) => e.type === 'param');
    assert(paramEvents.length === 0, 'a discrete setParam emits NO param (norm) event');
  }
  {
    const { driver, events } = makeGen3();
    await driver.setParam(AMP_EID, 1, 0.5, true); // continuous knob position
    const paramEvents = events.filter((e) => e.type === 'param');
    assertEqual(paramEvents.length, 1, 'a continuous setParam still broadcasts one param event');
    assert(paramEvents[0]!.norm >= 0 && paramEvents[0]!.norm <= 1, 'continuous param event norm ∈ [0,1]');
  }

  // ── W1.3: setChannel moves the edit-watch channel ───────────────────────────────────────────────
  // Open the block on channel A (primes the diff baseline), switch to B, then feed a burst whose
  // channel-B slice moved. The diff must look at channel B — before the fix #watchedChannel stayed A
  // so the moved B param was never seen.
  {
    const { driver, mock } = makeGen3();
    const family = familyForEid(AMP_EID);
    const stride = PROFILES[MODEL]!.rangeSections[family]?.stride ?? 1;
    const primed = new Array(stride * 4).fill(0); // all channels zero → baseline = zero A slice
    mock.reply = (req) => {
      if (req[5] === 0x13) return [statusFrame(AMP_EID, 0)];
      if (req[5] === 0x1f) return blockBulkFrames(AMP_EID, primed); // fn-0x1F poll → 0x74/0x75/0x76 reply
      return [];
    };
    await driver.blockParams(AMP_EID); // primes #editSnapshot[eid] with the channel-A slice (zeros)
    await driver.setChannel(AMP_EID, 'B'); // must set #watchedChannel = 1

    // A param that exists in the family with a range, inside the channel slice.
    const defs = PROFILES[MODEL]!.params[family] ?? [];
    const moved = defs.find((p) => p.paramId < stride && PROFILES[MODEL]!.ranges[family]?.[p.paramId]);
    assert(!!moved, 'found a ranged param inside the channel slice to move');

    const burst = new Array(stride * 4).fill(0);
    burst[stride + moved!.paramId] = 5000; // move it on channel B only
    const res = driver.decodeEditBurst!(blockBulkFrames(AMP_EID, burst));
    assert(
      res.events.some((e) => e.paramId === moved!.paramId),
      `decodeEditBurst diffs the channel the user switched to (paramId ${moved!.paramId})`
    );
  }

  // ── W1.4: setType suppresses the self-echo (local-edit window) ──────────────────────────────────
  // A local setType must pause the edit poll for ~2 s, exactly like setParam. Otherwise the very next
  // poll re-reads the type we just wrote and emits it back as a spurious param event.
  {
    const { driver, mock, events } = makeGen3();
    const family = familyForEid(AMP_EID);
    const stride = PROFILES[MODEL]!.rangeSections[family]?.stride ?? 1;
    let bulkVals = new Array(stride * 4).fill(0); // primed zeros
    mock.reply = (req) => {
      if (req[5] === 0x13) return [statusFrame(AMP_EID, 0)];
      if (req[5] === 0x1f) return blockBulkFrames(AMP_EID, bulkVals);
      return []; // the fn-0x01 type write: accepted (silence)
    };
    await driver.blockParams(AMP_EID);
    await driver.setType(AMP_EID, 5);
    bulkVals = new Array(stride * 4).fill(65534); // the device now reflects the type we wrote
    const before = events.length;
    await driver.readDeviceEditState!();
    const emitted = events.slice(before).filter((e) => e.type === 'param');
    assertEqual(emitted.length, 0, 'setType pauses the edit poll — no self-echo param event');
  }

  // ── W1.5: placeCell bounds against the FM3's own grid shape ─────────────────────────────────────
  // The codec's buildSetGridCell backstop is the III's 14 columns; an FM3 col of 13/14 must be
  // refused server-side rather than encoded past the 4x12 grid.
  {
    const { driver } = makeGen3();
    let threw = false;
    try {
      await driver.placeCell(1, 13, AMP_EID);
    } catch {
      threw = true;
    }
    assert(threw, 'placeCell: col 13 is outside the FM3 4x12 grid → refused');
  }
  {
    const { driver } = makeGen3();
    const r = await driver.placeCell(1, 12, AMP_EID); // the last valid FM3 column
    assert(r.ok, 'placeCell: col 12 (FM3 boundary) still accepted');
  }
}
