// P11 — the device-edit-poll hole, and its two siblings.
//
// P9 made blockParams refuse to index a family whose catalog pids are NOT record ordinals (GLOBAL:
// stride 186 with 91 pids up to 65522 — device WIRE ADDRESSES, not positions): it serves `value: null`
// + an `unresolved` reason instead of a fabricated 0. But `#bulkUnresolvedReason` was consulted at only
// ONE place (blockParams). The FM3 device-edit POLL ran unguarded:
//
//   openVirtual(GLOBAL) → blockParams(1) primed #editSnapshot with the positional slice and set
//   #watchedEid = 1; the poll then ran readDeviceEditState → #readEditBlock(1) → decodeEditBurst, which
//   for every GLOBAL pid < stride whose record changed emitted `{ paramId, norm: cur[id]/65534 }`.
//   `cur[id]` for a sub-stride GLOBAL pid is whatever UNRELATED record shares its ordinal — Axis applies
//   that norm verbatim (`p.norm = e.norm`) and its `knobUnknown` needs BOTH norm and value null, so a
//   front-panel edit flipped an inert "unknown" tile into a LIVE, WRITABLE knob showing a reading the
//   device never reported (and the write guard, which tests `p.norm == null`, then passed).
//
// The server must never emit that fabricated norm. The honest reflection of a move we cannot read is NO
// event: decodeEditBurst now refuses any unresolved family, and neither blockParams nor the sweep's
// quiet prime will seed #editSnapshot from one.
//
// The same positional-decode class appears twice more, both fixed here:
//   • cabState() swallowed ANY failed/torn read in a `catch {}` and served a ZEROED cab state (mode 0 /
//     bank 0 / IR 0) with HTTP 200 — a fabricated state, the class P1.3 closed for the torn block read;
//   • meters() had no torn-read guard and `?? 0` for a client-requested id past the body — a meter
//     pinned to its minimum, presented as a real reading.
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
  // ── 1. THE HOLE: a device-edit burst for the unresolved GLOBAL family emits NO param event. ──
  // The recorded defect: a front-panel move surfaced as a fabricated norm for a pid resolved through
  // an unrelated record's ordinal. A non-zero fixture makes a fabrication visible (0 vs the fixture).
  {
    const baseA = new Array(GLOBAL_STRIDE * 4).fill(0);
    baseA[GLOBAL_SUBSTRIDE_PID] = 100; // the baseline record at that ordinal
    let current = burst(GLOBAL_EID, baseA);
    const { driver } = makeDriver(() => current);
    await driver.blockParams(GLOBAL_EID); // opens GLOBAL: arms the watch + (old code) primes the baseline
    const changed = baseA.slice();
    changed[GLOBAL_SUBSTRIDE_PID] = 30000; // the "move" — old code emitted norm 30000/65534 here
    current = burst(GLOBAL_EID, changed);
    const res = driver.decodeEditBurst(current);
    assertEqual(res.events.length, 0,
      'case 1: a GLOBAL edit burst emits NO param event (its sub-stride pid would resolve to an unrelated record)');
    assert(!res.events.some((e) => e.paramId === GLOBAL_SUBSTRIDE_PID && e.norm > 0),
      'case 1: no fabricated norm is emitted for a sub-stride GLOBAL pid');
    assertEqual(res.reload, false, 'case 1: an unresolved family does not ask for a reload either (nothing changed we can read)');
  }

  // ── 2. The same through the POLL path: after opening GLOBAL, readDeviceEditState emits no fabricated ──
  // param event (this is exactly what Axis consumed and applied as `p.norm = e.norm`).
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
    assert(!events.some((e) => e.type === 'param' && e.effectId === GLOBAL_EID),
      'case 2: the device-edit poll emits no param event for the unresolved GLOBAL family');
  }

  // ── 3. The sweep prime must not seed a positional baseline for an unresolved family. ──
  // A status dump places GLOBAL, so the round-robin sweep targets it. The quiet prime must be a no-op:
  // a seeded baseline would let the NEXT sweep diff unrelated records into a fabricated param event.
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
    await driver.readDeviceEditState(); // sweep visit 1: quiet-prime (must be refused for GLOBAL)
    const changed = baseA.slice();
    changed[GLOBAL_SUBSTRIDE_PID] = 30000;
    current = burst(GLOBAL_EID, changed);
    await driver.readDeviceEditState(); // sweep visit 2: a seeded baseline would now emit a fabricated param
    assert(!events.some((e) => e.type === 'param' && e.effectId === GLOBAL_EID),
      'case 3: a swept unresolved family never emits a fabricated param event');
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
