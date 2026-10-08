// P13 — REVERSES P9. The fn=0x1F body IS positional and pid-indexed, so a GLOBAL param's own record
// IS addressable by its catalog paramId. P9 mis-read the catalog's SPARSE GLOBAL pids (173 pids, 91 of
// them >= the declared stride 186, up to 65522) as evidence the body was not positional, and refused
// the WHOLE family (every value null + reason) — which made every GLOBAL control inert.
//
// MEASURED on the real FM3 2026-10-07 with scripts/dump-global.ts (read-only):
//   • the eid-1 GLOBAL body is 14,880 records (head itemCount 14880, assembled 14880, ratio 1.000),
//     so `base + pid` for a GLOBAL control is IN range — the "runs past the block" story is refuted;
//   • the front panel is the oracle for the indexing: Mini Display/Ring Brightness at 100% read
//     body[7115] = 65534, and after the user set it to 70% it read body[7115] = 45874
//     (exactly 0.70 x 65534); Mini Display Contrast at 50% read body[7116] = 32767 (exactly half of
//     65534); Ring Intensity Bright at 100% read body[110] = 65534. Three independent panel values
//     match by proportion, so pid == record ordinal, and the raw field is 16-bit with 65534 = 100%.
//
// What remains correct and is kept here: out-of-range is PER PID, not per family. A pid whose record
// the body genuinely does not carry (a short/torn tail) reads `null` + a reason, never a fabricated 0.
// Dense families (pid == ordinal) are unchanged. Mocked transport + the REAL static FM3 profile.
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
const GLOBAL_STRIDE = PROFILES[MODEL]!.rangeSections['GLOBAL']!.stride; // 186 (declared; NOT the body length)

/** The GLOBAL fn=0x1F body length MEASURED on the device (2026-10-07): 14,880 records. */
const DEVICE_BODY_LEN = 14880;
/** Panel-oracle records (raw 16-bit, 65534 = 100%): the values the device returned for three controls. */
const ORACLE = { bright7115: 45874, contrast7116: 32767, ring110: 65534 };

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

/** A device-sized GLOBAL body: index i → (i % 250) + 1, with the three panel-oracle records overridden. */
function globalDeviceBody(): number[] {
  const v = Array.from({ length: DEVICE_BODY_LEN }, (_, i) => (i % 250) + 1);
  v[7115] = ORACLE.bright7115; // Mini Display / Ring Brightness @ 70%
  v[7116] = ORACLE.contrast7116; // Mini Display Contrast @ 50%
  v[110] = ORACLE.ring110; // Ring Intensity Bright @ 100%
  return v;
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
  const g = await serve(GLOBAL_EID, burst(GLOBAL_EID, globalDeviceBody()));
  const globalParams: (NamedParam | EnumParam)[] = [...g.named, ...g.enums];
  assert(globalParams.length > 0, 'case 1: the GLOBAL block still serves its layout controls (ids), so Axis renders them');

  // 1. THE REVERSED DEFECT: a GLOBAL pid resolves from its OWN record. GLOBAL_FS_BRIGHTNESS (7115) at
  //    the panel's 70% reads body[7115] = 45874 → display value 70 (range 0..100), norm 45874/65534.
  //    P9 served this as `value: null`; that refusal is what this branch removes.
  const bright = find(globalParams, 7115);
  assert(!!bright, 'case 1: GLOBAL_FS_BRIGHTNESS (7115) is served by id');
  assert(typeof bright!.value === 'number', 'case 1: GLOBAL_FS_BRIGHTNESS (7115) RESOLVES from the positional body (not null)');
  assertEqual(bright!.unresolved, undefined, 'case 1: a resolved GLOBAL value carries no unresolved reason');
  assert(Math.abs((bright as NamedParam).norm! - ORACLE.bright7115 / 65534) < 1e-3,
    `case 1: norm is the raw body[7115] over 65534 (${(bright as NamedParam).norm})`);
  assert(Math.abs((bright!.value as number) - 70) < 0.02,
    `case 1: 45874 reads as the panel's 70% (range 0..100), got ${bright!.value}`);

  // 2. THE THREE PANEL-ORACLE RECORDS MATCH BY PROPORTION. Contrast @ 50% (32767 = half of 65534) reads
  //    value 50; Ring Intensity Bright @ 100% (65534) reads the top of its 25..100 range (100). Neither
  //    is fabricated and neither is flagged unresolved — the body is pid-indexed, exactly as measured.
  const contrast = find(globalParams, 7116) as NamedParam | undefined;
  assert(!!contrast && typeof contrast.value === 'number' && contrast.unresolved === undefined,
    'case 2: GLOBAL_FS_LCD_CONTRAST (7116) resolves (not null)');
  assert(Math.abs((contrast!.value as number) - 50) < 0.02,
    `case 2: 32767 (half of 65534) reads as the panel's 50%, got ${contrast!.value}`);
  const ring = find(globalParams, 110) as NamedParam | undefined;
  assert(!!ring && typeof ring.value === 'number' && ring.norm === 1 && ring.unresolved === undefined,
    'case 2: GLOBAL_FC_RING_BRIGHT_LEVEL (110) at 100% reads norm 1 (top of its 25..100 range)');
  assert(Math.abs((ring!.value as number) - 100) < 0.02,
    `case 2: 65534 = 100% reads as 100.0, got ${ring!.value}`);

  // 3. OUT-OF-RANGE IS PER PID, NOT PER FAMILY. A body that genuinely does not carry a pid's record (a
  //    short read: the head advertises the 744 records that arrived) still serves that pid as UNKNOWN —
  //    `null` + a reason naming the missing index — never a fabricated 0. A pid the short body DOES
  //    carry stays a real number. (The old `?? 0` served 0 here; the per-pid honesty below is kept.)
  const shortLen = GLOBAL_STRIDE * 4; // 744
  const shortBody = Array.from({ length: shortLen }, (_, i) => (i % 250) + 1);
  const shortG = await serve(GLOBAL_EID, burst(GLOBAL_EID, shortBody));
  const shortParams: (NamedParam | EnumParam)[] = [...shortG.named, ...shortG.enums];
  const shortBright = find(shortParams, 7115);
  assert(!!shortBright, 'case 3: GLOBAL_FS_BRIGHTNESS is still served by id even when out of range');
  assertEqual(shortBright!.value, null, 'case 3: a GLOBAL pid the body does not carry is UNKNOWN (null), never 0');
  assert(typeof shortBright!.unresolved === 'string' && shortBright!.unresolved.length > 0,
    'case 3: the out-of-range value carries a reason');
  assert(/record at index 7115/.test(shortBright!.unresolved!) && /744 values/.test(shortBright!.unresolved!),
    `case 3: the reason names the missing index and the body length (${shortBright!.unresolved})`);
  const shortRing = find(shortParams, 110) as NamedParam | undefined;
  assert(!!shortRing && typeof shortRing.value === 'number',
    'case 3: a pid the short body DOES carry stays a real number (per-pid, not per-family, honesty)');

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

  // 7. The resolved value reaches the route: blockParamsH returns the real GLOBAL brightness through to
  //    the HTTP body (a number, never null/0). P9's route surfaced null here; this branch serves it.
  const reg = { driver: async () => driverFor(GLOBAL_EID, burst(GLOBAL_EID, globalDeviceBody())) } as unknown as DeviceRegistry;
  const sink = new Sink();
  const bodyG = (await createUnifiedHandlers(reg).blockParamsH(sink, GLOBAL_EID)) as { named: NamedParam[]; enums: EnumParam[]; type: unknown };
  const handled = [...bodyG.named, ...bodyG.enums].find((p) => p.id === 7115);
  assert(!!handled && typeof handled.value === 'number' && handled.unresolved === undefined,
    'case 7: the route surfaces GLOBAL_FS_BRIGHTNESS as the resolved number');
  assertEqual(JSON.parse(JSON.stringify(handled)).value, handled!.value,
    'case 7: the resolved value survives the JSON boundary unchanged');
}
