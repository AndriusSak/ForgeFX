// P13 — REVERSES the GLOBAL half of P9/P11. The fn=0x1F body IS positional and pid-indexed: MEASURED
// on the real FM3 2026-10-07, the eid-1 GLOBAL body is 14,880 records and body[7115] tracked the front
// panel (100% → 65534, 70% → 45874 = 0.70 x 65534). So a GLOBAL param's own record IS addressable and
// a front-panel move on GLOBAL IS decodable.
//
// P9 nulled every GLOBAL value and P11 made decodeEditBurst refuse the whole family, so a swept/open
// GLOBAL block emitted NO param event — and its controls stayed inert. That refusal was built on the
// refuted "pids up to 65522 prove the body is not positional" story; it is removed here.
//
// What the reversal KEEPS is per-pid honesty: the diff loop skips `id >= stride` and a record the body
// does not carry (`cur[id] === undefined`), so an unreadable PID emits no event — never a fabricated 0.
// (A genuinely short/torn body therefore still yields no bogus move.)
//
// The other two positional-decode fixes in this file are UNCHANGED and still asserted:
//   • cabState() must not swallow a failed/torn read and serve a ZEROED cab state (mode 0 / bank 0 /
//     IR 0) with HTTP 200 — a fabricated state (P1.3's class, closed for the torn block read);
//   • meters() must not `?? 0` a client-requested id past the body — a meter pinned to its minimum.
//
// Mocked transport + the REAL static FM3 profile: no hardware.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES } from '../../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';
import { createUnifiedHandlers, type StatusSink } from '../../src/runtime/handlers.js';
import type { DeviceRegistry } from '../../src/drivers/registryCore.js';
import type { DeviceEvent, DriverCtx } from '../../src/drivers/types.js';

const MODEL = 0x11; // FM3
const GLOBAL_EID = 1; // virtual GLOBAL effect (the non-positional family)
const AMP_EID = effectRoster().find((e) => e.slug === 'amp')!.page; // DISTORT (dense)
const CAB_EID = effectRoster().find((e) => e.slug === 'cab')!.page; // CABINET (dense)
const GLOBAL_STRIDE = PROFILES[MODEL]!.rangeSections['GLOBAL']!.stride; // 186
const AMP_STRIDE = PROFILES[MODEL]!.rangeSections['DISTORT']!.stride; // 144
const CAB_STRIDE = PROFILES[MODEL]!.rangeSections['CABINET']!.stride; // 106
const GLOBAL_SUBSTRIDE_PID = 1; // GLOBAL_REVERBMIX — a real range row BELOW the stride (ordinal, not address)
const AMP_MOVED_PID = 16; // DISTORT Bright Cap — a dense pid (pid == ordinal)

export const EDIT_BURST_UNRESOLVED_CASE_COUNT = 8;

const compactHex = (f: readonly number[]) => f.map((b) => b.toString(16).padStart(2, '0')).join('');
const enc14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];
function sysex(fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}
const head = (effectId: number, itemCount: number) => sysex(0x74, [...enc14(effectId), ...enc14(itemCount), 0x07]);
function body(values: readonly number[]): number[] {
  const b: number[] = [0x00, 0x02];
  for (const v of values) b.push(...packValue16(v));
  return sysex(0x75, b);
}
const end = () => sysex(0x76, []);
/** A complete burst: head advertising `values.length`, one full body, end. */
function burst(effectId: number, values: readonly number[]): number[][] {
  return [head(effectId, values.length), body(values), end()];
}
/** A TORN burst: the head advertises `advertised`, the body carries fewer. */
function tornBurst(effectId: number, advertised: number, values: readonly number[]): number[][] {
  return [head(effectId, advertised), body(values), end()];
}

/** A driver whose bulk-read poll answers `frames()`; everything else is silent. */
function makeDriver(frames: () => number[][], onEmit: (e: DeviceEvent) => void = () => {}) {
  const profile = PROFILES[MODEL]!;
  const codec = createModernFractalCodec(profile.model);
  const mock = new MockTransport('serial', 'mock-edit-burst');
  mock.isOpen = true;
  mock.reply = (req) => {
    for (const eid of [GLOBAL_EID, AMP_EID, CAB_EID]) {
      if (compactHex(req) === compactHex(codec.buildBlockBulkReadPoll(eid))) return frames();
    }
    return []; // status/meters/silence
  };
  const ctx: DriverCtx = { transport: async () => mock, emit: onEmit, getCadence: () => cadenceFor(profile.model, 'balanced') };
  return { driver: createGen3Driver(profile, ctx), mock };
}

/** Assert `fn()` rejects — a bare catch would also accept a typo in the harness. */
async function rejectsWith(fn: () => Promise<unknown>, expect: RegExp, msg: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const m = (e as Error).message ?? String(e);
    assert(expect.test(m), `${msg} — wrong error (expected ${expect}, got: ${m})`);
    return;
  }
  throw new Error(msg);
}

class Sink implements StatusSink {
  status: number | undefined;
  code(statusCode: number): unknown { this.status = statusCode; return this; }
}

export async function runEditBurstUnresolvedTests(): Promise<void> {
  // ── 1. A device-edit burst for GLOBAL NOW emits the real move. The body is pid-indexed, so a change
  // to GLOBAL_REVERBMIX (pid 1 < stride) is decoded from pid 1's own record: norm = 30000/65534.
  // (P11 emitted nothing here — the family-wide refusal this branch removes.)
  {
    const baseA = new Array(GLOBAL_STRIDE * 4).fill(0);
    baseA[GLOBAL_SUBSTRIDE_PID] = 100; // the baseline record at pid 1
    let current = burst(GLOBAL_EID, baseA);
    const { driver } = makeDriver(() => current);
    await driver.blockParams(GLOBAL_EID); // opens GLOBAL: arms the watch + primes the baseline
    const changed = baseA.slice();
    changed[GLOBAL_SUBSTRIDE_PID] = 30000; // the move
    current = burst(GLOBAL_EID, changed);
    const res = driver.decodeEditBurst(current);
    const moved = res.events.find((e) => e.paramId === GLOBAL_SUBSTRIDE_PID);
    assert(!!moved, 'case 1: a GLOBAL edit burst emits the real param event (its pid IS its record)');
    assert(Math.abs(moved!.norm - 30000 / 65534) < 1e-6,
      `case 1: the emitted norm is the moved record over 65534 (got ${moved!.norm})`);
    assert(moved!.norm > 0, 'case 1: the emitted norm is the real move, not a fabricated 0');
    assertEqual(res.reload, false, 'case 1: the primed baseline lets blockParams diff without a reload');
  }

  // ── 2. The same through the POLL path: after opening GLOBAL, readDeviceEditState emits the real param
  // event (this is exactly what Axis consumes and applies as `p.norm = e.norm`).
  {
    const baseA = new Array(GLOBAL_STRIDE * 4).fill(0);
    let current = burst(GLOBAL_EID, baseA);
    const events: DeviceEvent[] = [];
    const { driver } = makeDriver(() => current, (e) => events.push(e));
    await driver.blockParams(GLOBAL_EID);
    const changed = baseA.slice();
    changed[GLOBAL_SUBSTRIDE_PID] = 30000;
    current = burst(GLOBAL_EID, changed);
    await driver.readDeviceEditState();
    const moved = events.find((e) => e.type === 'param' && e.effectId === GLOBAL_EID && e.paramId === GLOBAL_SUBSTRIDE_PID);
    assert(!!moved, 'case 2: the device-edit poll emits the real GLOBAL param event');
    assert((moved as { norm: number }).norm > 0, 'case 2: the emitted norm is the real move, not a fabricated 0');
  }

  // ── 3. The sweep prime DOES seed the positional baseline for GLOBAL, and the NEXT sweep diffs the real
  // move out of it. (P11's quiet prime refused GLOBAL, so no event ever surfaced from a sweep.)
  {
    const profile = PROFILES[MODEL]!;
    const codec = createModernFractalCodec(profile.model);
    const baseA = new Array(GLOBAL_STRIDE * 4).fill(0);
    let current = burst(GLOBAL_EID, baseA);
    const events: DeviceEvent[] = [];
    const mock = new MockTransport('serial', 'mock-sweep-global');
    mock.isOpen = true;
    const statusFrame = sysex(0x13, [...enc14(GLOBAL_EID), 0x00]); // GLOBAL placed, channel A
    mock.reply = (req) => {
      if (req[5] === 0x13) return [statusFrame];
      if (compactHex(req) === compactHex(codec.buildBlockBulkReadPoll(GLOBAL_EID))) return current;
      return [];
    };
    const driver = createGen3Driver(profile, { transport: async () => mock, emit: (e) => events.push(e), getCadence: () => cadenceFor(profile.model, 'balanced') });
    await driver.readDeviceEditState(); // sweep visit 1: quiet-prime the GLOBAL baseline
    const changed = baseA.slice();
    changed[GLOBAL_SUBSTRIDE_PID] = 30000;
    current = burst(GLOBAL_EID, changed);
    await driver.readDeviceEditState(); // sweep visit 2: the seeded baseline yields the real move
    assert(events.some((e) => e.type === 'param' && e.effectId === GLOBAL_EID && e.paramId === GLOBAL_SUBSTRIDE_PID),
      'case 3: a swept GLOBAL family emits the real param event after its baseline is primed');
  }

  // ── 4. DENSE-FAMILY REGRESSION: the burst diff still works where pid == ordinal. ──
  {
    const baseA = new Array(AMP_STRIDE * 4).fill(0);
    let current = burst(AMP_EID, baseA);
    const { driver } = makeDriver(() => current);
    await driver.blockParams(AMP_EID); // primes the dense baseline
    const changed = baseA.slice();
    changed[AMP_MOVED_PID] = 30000;
    current = burst(AMP_EID, changed);
    const res = driver.decodeEditBurst(current);
    assert(res.events.some((e) => e.paramId === AMP_MOVED_PID),
      'case 4: a dense family still emits its edit-burst event (no regression)');
  }

  // ── 5. cabState on a FAILED read must not serve a zeroed state. ──
  {
    const profile = PROFILES[MODEL]!;
    const mock = new MockTransport('serial', 'mock-cab-silent');
    mock.isOpen = true;
    mock.reply = () => []; // device silent → the read failed
    const driver = createGen3Driver(profile, { transport: async () => mock, emit: () => {}, getCadence: () => cadenceFor(profile.model, 'balanced') });
    let threw = false;
    let served: unknown;
    try { served = await driver.cabState(CAB_EID); } catch { threw = true; }
    assert(threw, `case 5: a failed cab read must reject, not serve a zeroed state (got ${JSON.stringify(served)})`);
    // and the route handler propagates it (cabStateH has no catch → non-200), never a 200 zeroed body.
    const reg = { driver: async () => driver } as unknown as DeviceRegistry;
    const sink = new Sink();
    let handlerThrew = false;
    try { await createUnifiedHandlers(reg).cabStateH(sink, CAB_EID); } catch { handlerThrew = true; }
    assert(handlerThrew, 'case 5: the route handler propagates the failed read (never a 200 zeroed cab state)');
    assertEqual(sink.status, undefined, 'case 5: no 200 cab snapshot was built');
  }

  // ── 6. cabState on a TORN read must not zero-fill the missing records. ──
  {
    const torn = tornBurst(CAB_EID, CAB_STRIDE * 4, new Array(4).fill(65534));
    const { driver } = makeDriver(() => torn);
    await rejectsWith(() => driver.cabState(CAB_EID), /torn cab bulk read/,
      'case 6: a torn cab read rejects rather than serving mode 0 / bank 0 / IR 0');
  }

  // ── 7. cabState positive control: a COMPLETE burst still serves the real state (no over-rejection). ──
  {
    const full = burst(CAB_EID, new Array(CAB_STRIDE * 4).fill(0));
    const { driver } = makeDriver(() => full);
    const s = (await driver.cabState(CAB_EID)) as { mode: { value: number }; slots: unknown[]; modeOptions: unknown[] };
    assert(typeof s.mode?.value === 'number', 'case 7: a complete cab read still serves its state');
    assertEqual(s.slots.length, 2, 'case 7: the cab still reports its two slots');
  }

  // ── 8. meters must not zero-fill. (a) a TORN burst yields no reading; (b) a pid past the body yields
  //        no fabricated 0 for a COMPLETE body. ──
  {
    const stubGrid = async () => ({
      model: 'fm3', name: 'x', crcValid: true, rows: 4, cols: 12, scenes: [], source: 'dump' as const,
      cells: [{ effectId: AMP_EID, isShunt: false }],
    });
    const withGrid = (frames: () => number[][]) => {
      const { driver } = makeDriver(frames);
      (driver as unknown as { grid: () => Promise<unknown> }).grid = stubGrid;
      return driver;
    };

    // (a) torn: the head advertises a full body, only a partial page arrives.
    const tornDriver = withGrid(() => tornBurst(AMP_EID, AMP_STRIDE * 4, new Array(4).fill(0)));
    const torn = await tornDriver.meters({});
    const tornBlock = torn.find((b) => b.effectId === AMP_EID)!;
    assertEqual(Object.keys(tornBlock.vals).length, 0, 'case 8: a torn meter read yields NO readings, not a zero fill');
    assertEqual(tornBlock.typeName, '', 'case 8: a torn meter read no longer fabricates a type name from `?? 0`');

    // (b) complete body, but a client-requested id past the body: no fabricated 0 for it.
    const beyond = 9999; // > AMP_STRIDE
    const fullDriver = withGrid(() => burst(AMP_EID, new Array(AMP_STRIDE * 4).fill(65534)));
    const full = await fullDriver.meters({ amp: [beyond] });
    const fullBlock = full.find((b) => b.effectId === AMP_EID)!;
    assertEqual(fullBlock.vals[beyond], undefined, 'case 8: a client-requested id past the body is UNKNOWN, never a zeroed meter');
    assert(Object.keys(fullBlock.vals).some((k) => Number(k) !== beyond), 'case 8: the real knobs in the body are still served (no over-rejection)');
  }
}
