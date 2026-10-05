// FM3 front-panel edit reflection when no block is open (backlog W2.3, option B — the round-robin sweep).
//
// The FM3 pushes nothing (capability deviceEditWatch), so the server polls. `readDeviceEditState` used to
// short-circuit `{changed:false}` whenever no block was open in Axis (`#watchedEid == null`), so a
// front-panel knob move was invisible while the user was on the grid / library / a rail screen — and on
// any block other than the one being viewed.
//
// The sweep reads ONE placed block per tick, round-robin, so the marginal cost is a single fn-0x1F read —
// the same read the open-block path already makes. The placed set comes from the fn-0x13 status dump
// (cached opportunistically from the registry's own channel watch), so enumeration adds no traffic of
// its own. A sweep's FIRST sight of a block primes the baseline silently (otherwise the first cycle would
// ask for one full preset reload per placed block).
//
// Mocked transport + the REAL static FM3 profile: no hardware.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES, SLUG_FAMILY } from '../../src/devices.js';
import { slugForEffectId } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
const AMP_EID = 58; // DISTORT family (stride 144)
const DELAY_EID = 70; // DELAY family (stride 88)
const DISTORT_TYPE_PID = 6; // DISTORT_TYPE — the model selector
const MOVED_PID = 1; // any continuous param of the amp family
const PLACED = [AMP_EID, DELAY_EID];

export const FM3_SWEEP_CASE_COUNT = 5;

const compactHex = (f: readonly number[]) => f.map((b) => b.toString(16).padStart(2, '0')).join('');
const enc14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];

function sysex(fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}

const familyOf = (eid: number): string => SLUG_FAMILY[slugForEffectId(eid) ?? ''] ?? '';
const strideOf = (eid: number): number => PROFILES[MODEL]!.rangeSections[familyOf(eid)]!.stride;

function bulkFrames(eid: number, values: readonly number[]): number[][] {
  const body: number[] = [0x00, 0x02];
  for (const v of values) body.push(...packValue16(v));
  return [sysex(0x74, [...enc14(eid), ...enc14(values.length), 0x07]), sysex(0x75, body), sysex(0x76, [])];
}

/** fn-0x13 status dump listing `placed` — the placed-block source the sweep enumerates. */
function statusFrame(placed: readonly number[]): number[] {
  const payload: number[] = [];
  for (const eid of placed) payload.push(...enc14(eid), 0x00); // dd: not bypassed, channel A
  return sysex(0x13, payload);
}

interface Harness {
  driver: ReturnType<typeof createGen3Driver>;
  asked: number[];
  events: { type: string; effectId?: number; paramId?: number }[];
  values: Map<number, number[]>;
}

function makeHarness(placed: readonly number[] = PLACED): Harness {
  const codec = createModernFractalCodec(MODEL);
  const values = new Map<number, number[]>();
  for (const eid of placed) values.set(eid, new Array(strideOf(eid) * 4).fill(0));
  const asked: number[] = [];
  const mock = new MockTransport('serial', 'mock-sweep');
  mock.isOpen = true;
  mock.reply = (req) => {
    const hex = compactHex(req);
    for (const eid of placed) {
      if (hex === compactHex(codec.buildBlockBulkReadPoll(eid))) {
        asked.push(eid);
        return bulkFrames(eid, values.get(eid)!);
      }
    }
    if (req[5] === 0x13) return [statusFrame(placed)];
    return [];
  };
  const events: { type: string; effectId?: number; paramId?: number }[] = [];
  const driver = createGen3Driver(PROFILES[MODEL]!, {
    transport: async () => mock,
    emit: (e: { type: string; effectId?: number; paramId?: number }) => events.push(e),
    getCadence: () => cadenceFor(MODEL, 'balanced')
  });
  return { driver, asked, events, values };
}

export async function runFm3SweepTests(): Promise<void> {
  // 1. THE REGRESSION: with no block open, a front-panel knob move on a placed block is detected.
  {
    const h = makeHarness();
    await h.driver.readDeviceEditState(); // primes the first placed block
    await h.driver.readDeviceEditState(); // primes the second
    h.events.length = 0;
    h.values.get(AMP_EID)![MOVED_PID] = 30000; // the user turns a knob on the amp, no block open in Axis
    for (let i = 0; i < 3; i++) await h.driver.readDeviceEditState();
    assert(
      h.events.some((e) => e.type === 'param' && e.effectId === AMP_EID && e.paramId === MOVED_PID),
      'sweep detects a front-panel param edit with no block open'
    );
  }

  // 2. A sweep's first sight of a block primes the baseline SILENTLY — no event, no reload request.
  {
    const h = makeHarness();
    const r = await h.driver.readDeviceEditState();
    assertEqual(h.asked.length, 1, 'the first call reads exactly one placed block');
    assertEqual(r.changed, false, 'priming a block must not ask for a full reload');
    assertEqual(h.events.length, 0, 'priming a block emits nothing');
  }

  // 3. Round-robin: successive ticks walk every placed block (so a full cycle covers the preset).
  {
    const h = makeHarness();
    for (let i = 0; i < 4; i++) await h.driver.readDeviceEditState();
    assertEqual(h.asked.join(','), `${AMP_EID},${DELAY_EID},${AMP_EID},${DELAY_EID}`, 'the sweep cycles the placed blocks in order');
  }

  // 4. With a block OPEN the open block is still read every tick (unchanged behaviour) AND one other
  //    placed block is swept — so an edit on a block the user is not looking at is not lost.
  {
    const h = makeHarness();
    await h.driver.blockParams(AMP_EID); // opens the amp (sets #watchedEid)
    h.asked.length = 0;
    h.events.length = 0;
    await h.driver.readDeviceEditState(); // reads the open block, then sweeps the delay
    h.values.get(DELAY_EID)![MOVED_PID] = 30000; // front-panel knob on the block that is NOT open
    await h.driver.readDeviceEditState();
    assertEqual(h.asked.slice(0, 4).join(','), `${AMP_EID},${DELAY_EID},${AMP_EID},${DELAY_EID}`, 'the open block is read every tick, plus one swept block');
    assert(
      h.events.some((e) => e.type === 'param' && e.effectId === DELAY_EID && e.paramId === MOVED_PID),
      'an edit on a non-open block is reflected while another block is open'
    );
  }

  // 5. A move of the family TYPE selector is STRUCTURAL: the caller must emit a grid reload, because the
  //    block tile's model name comes from a fresh read, not from the param diff.
  {
    const h = makeHarness([AMP_EID]);
    await h.driver.readDeviceEditState(); // prime
    h.values.get(AMP_EID)![DISTORT_TYPE_PID] = 30000; // the amp model is changed on the front panel
    const r = await h.driver.readDeviceEditState();
    assertEqual(r.changed, true, 'a type-selector move on a swept block asks for a structural reload');
  }
}
