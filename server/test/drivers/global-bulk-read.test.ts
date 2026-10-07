// P9 — a family whose catalog pids are NOT positions in the fn=0x1F body must never serve a fabricated
// value. The FM3 GLOBAL family (virtual eid 1) declares `stride 186` yet its catalog carries pids up to
// 65522 (91 of them >= 186). blockParams indexed `bulk.values[base + pid]` and coerced the miss with
// `?? 0`, so:
//   • GLOBAL_FS_BRIGHTNESS (7115, >= stride) read as a fabricated 0.0000 on a unit with its LED rings
//     visibly ON, and a later restore wrote that 0 over the real value (recorded incident); and
//   • a sub-stride pid resolved to whatever record shared its ORDINAL — a silently WRONG value, not 0.
// The catalog ships no pid→record-ordinal map for GLOBAL (ranges.generated.ts keys its GLOBAL table by
// paramId, not position), so the honest fix is to REFUSE to guess: those values are served as
// `value: null` with an `unresolved` reason, never a number. Dense families (pid == ordinal) are
// unchanged. Mocked transport + the REAL static FM3 profile: no hardware.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES } from '../../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';
import type { NamedParam, EnumParam } from '../../src/drivers/types.js';
import { createUnifiedHandlers, type StatusSink } from '../../src/runtime/handlers.js';
import type { DeviceRegistry } from '../../src/drivers/registryCore.js';

const MODEL = 0x11; // FM3
const GLOBAL_EID = 1; // virtual GLOBAL effect
const AMP_EID = effectRoster().find((e) => e.slug === 'amp')!.page; // DISTORT family
const AMP_STRIDE = PROFILES[MODEL]!.rangeSections['DISTORT']!.stride; // 144

export const GLOBAL_BULK_READ_CASE_COUNT = 7;

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

/** Build a driver over a mocked transport answering the bulk poll with `frames`. */
function driverFor(eid: number, frames: number[][]) {
  const profile = PROFILES[MODEL]!;
  const codec = createModernFractalCodec(profile.model);
  const mock = new MockTransport('serial', `mock-globalbulk-${eid}`);
  mock.isOpen = true;
  mock.reply = (req) => (compactHex(req) === compactHex(codec.buildBlockBulkReadPoll(eid)) ? frames : []);
  return createGen3Driver(profile, {
    transport: async () => mock,
    emit: () => {},
    getCadence: () => cadenceFor(profile.model, 'balanced'),
  });
}
/** Drive blockParams for `eid` over a mocked transport answering the bulk poll with `frames`. */
const serve = (eid: number, frames: number[][]) => driverFor(eid, frames).blockParams(eid);
const find = (ps: (NamedParam | EnumParam)[], id: number) => ps.find((p) => p.id === id);

class Sink implements StatusSink {
  status: number | undefined;
  code(statusCode: number): unknown { this.status = statusCode; return this; }
}

export async function runGlobalBulkReadTests(): Promise<void> {
  // A deliberately NON-ZERO GLOBAL body: index i carries (i % 250) + 1, so ordinal 1 = 2, ordinal 16 = 17.
  // If the decoder still indexed by pid, the served readings would echo these numbers (or 0 past the end).
  const globalStride = PROFILES[MODEL]!.rangeSections['GLOBAL']!.stride; // 186
  const globalFixture = Array.from({ length: globalStride * 4 }, (_, i) => (i % 250) + 1);
  const g = await serve(GLOBAL_EID, burst(GLOBAL_EID, globalFixture));
  const globalParams: (NamedParam | EnumParam)[] = [...g.named, ...g.enums];
  assert(globalParams.length > 0, 'case 1: the GLOBAL block still serves its layout controls (ids), so Axis renders them');

  // 1. THE RECORDED DEFECT: a pid >= stride (7115 GLOBAL_FS_BRIGHTNESS) must NOT read as the fixture's
  //    fabricated 0. The honest outcome is an explicit unknown: value null + a stated reason.
  const bright = find(globalParams, 7115);
  assert(!!bright, 'case 1: GLOBAL_FS_BRIGHTNESS (7115) is served by id');
  assertEqual(bright!.value, null, 'case 1: a pid >= stride reads as UNKNOWN (null), never a fabricated 0');
  assert(typeof bright!.unresolved === 'string' && bright!.unresolved.length > 0,
    'case 1: the unresolved value carries a reason');
  assert(/stride|positional/i.test(bright!.unresolved!), 'case 1: the reason names the positional/stride cause');

  // 2. A pid BELOW the stride must not silently return the WRONG record. Ordinal 1 of the fixture is 2;
  //    the served GLOBAL_REVERBMIX (pid 1) must be null — NOT 2 (a wrong record) and NOT 0.
  const reverbMix = find(globalParams, 1);
  assert(!!reverbMix, 'case 2: GLOBAL_REVERBMIX (pid 1 < stride) is served by id');
  assertEqual(reverbMix!.value, null, 'case 2: a sub-stride GLOBAL pid is UNKNOWN, not the record at its ordinal');
  assert(reverbMix!.value !== globalFixture[1], 'case 2: the sub-stride reading is not the value at that ordinal (2)');
  assert(reverbMix!.value !== 0, 'case 2: the sub-stride reading is not a fabricated 0 either');

  // 3. Not one GLOBAL value is a number: the whole family is unresolvable via the positional bulk body.
  const numeric = globalParams.filter((p) => typeof p.value === 'number');
  assertEqual(numeric.length, 0, `case 3: no GLOBAL value is fabricated from the bulk body (offenders: ${numeric.map((p) => p.id).join(', ')})`);
  assert(g.type === null, 'case 3: the GLOBAL type is left null rather than fabricated');

  // 4. DENSE-FAMILY REGRESSION: the positional identity still holds where pid == ordinal. DISTORT/16
  //    (Bright Cap) at the wire max resolves to norm 1; the fixture value flows through unchanged.
  const dense = new Array(AMP_STRIDE * 4).fill(0);
  dense[16] = 65534;
  const amp = await serve(AMP_EID, burst(AMP_EID, dense));
  const cap = find(amp.named, 16) as NamedParam | undefined;
  assert(!!cap, 'case 4: the dense DISTORT block still serves Bright Cap as a knob');
  assertEqual(cap!.norm, 1, 'case 4: a dense family reads the real wire value (norm 1), unchanged');
  assert(typeof cap!.value === 'number', 'case 4: a dense family value stays a number');
  assertEqual(cap!.unresolved, undefined, 'case 4: a resolvable dense value is NOT flagged unresolved');

  // 5. A dense family is positional even in a full all-zero body: a genuine raw 0 is a REAL zero, still
  //    a resolved number (norm 0, no `unresolved` flag) — the fix does not mistrust genuinely-read zeros.
  const zeros = await serve(AMP_EID, burst(AMP_EID, new Array(AMP_STRIDE * 4).fill(0)));
  const capZero = find(zeros.named, 16) as NamedParam | undefined;
  assert(!!capZero && typeof capZero.value === 'number' && capZero.norm === 0 && capZero.unresolved === undefined,
    'case 5: a dense all-zero body serves its genuine reads as resolved numbers (norm 0), not flagged unresolved');

  // 6. A dense family whose body is short of the param (head advertises the short body) must NOT coerce
  //    the absent record to 0: the missing tail is UNKNOWN, the present records stay real numbers.
  const short = await serve(AMP_EID, burst(AMP_EID, new Array(4).fill(0)));
  assertEqual(find(short.named, 16)!.value, null, 'case 6: a dense family record absent from the body is UNKNOWN, not 0');
  const present = find(short.named, 1) as NamedParam | undefined;
  assert(!!present && typeof present.value === 'number' && present.unresolved === undefined,
    'case 6: the records the body DOES carry stay real numbers');

  // 7. The same honesty reaches the route: blockParamsH returns the UNKNOWN through to the HTTP body
  //    (the handler serializes it as JSON null, never 0).
  const reg = { driver: async () => driverFor(GLOBAL_EID, burst(GLOBAL_EID, globalFixture)) } as unknown as DeviceRegistry;
  const sink = new Sink();
  const bodyG = (await createUnifiedHandlers(reg).blockParamsH(sink, GLOBAL_EID)) as { named: NamedParam[]; enums: EnumParam[]; type: unknown };
  const handled = [...bodyG.named, ...bodyG.enums].find((p) => p.id === 7115);
  assert(!!handled && handled.value === null && typeof handled.unresolved === 'string',
    'case 7: the route surfaces GLOBAL_FS_BRIGHTNESS as null + reason (no 0 substitution)');
  assertEqual(JSON.parse(JSON.stringify(handled)).value, null,
    'case 7: the unresolved value serializes to JSON null across the HTTP boundary');
}
