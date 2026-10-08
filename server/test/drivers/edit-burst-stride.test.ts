// W2.1 — the device-edit poll must DIFF by the body's ACTUAL EXTENT, not by the catalogue stride.
//
// The fn=0x1F body is pid-indexed (ADR 0006): a param's own record sits at index `base + pid`, and the
// eid-1 GLOBAL body is 14,880 records. The catalogue, however, declares GLOBAL `stride 186` — a number
// that does NOT describe this body's length. decodeEditBurst used to slice the baseline to
// `values.slice(base, base + stride)` and skip `if (id >= stride)`, so EVERY GLOBAL pid >= 186 was
// silently dropped from the diff. 91 of the 186 GLOBAL range pids are >= 186 (Brightness 7115,
// Contrast 7116 among them), so a front-panel change to those never reached the UI — it kept showing a
// stale value. The fix keys the skip on the body's real extent (`cur[id] === undefined`): a pid the body
// carries IS diffed; a pid the body genuinely does not carry (a torn/short tail) is still SKIPPED, never
// zero-filled. This suite pins both halves, plus the dense (channel-blocked) family as a regression guard.
//
// Mocked transport + the REAL static FM3 profile: no hardware.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES } from '../../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
const GLOBAL_EID = 1; // virtual GLOBAL effect — the body the catalogue stride does NOT describe
const AMP_EID = effectRoster().find((e) => e.slug === 'amp')!.page; // DISTORT — a dense, channel-blocked family

const GLOBAL_STRIDE = PROFILES[MODEL]!.rangeSections['GLOBAL']!.stride; // 186 (declared; NOT the body length)
const AMP_STRIDE = PROFILES[MODEL]!.rangeSections['DISTORT']!.stride; // 144
/** The GLOBAL fn=0x1F body length MEASURED on the device (2026-10-07): 14,880 records. */
const DEVICE_BODY_LEN = 14880;
const GLOBAL_HIGH_PID = 7115; // >= GLOBAL_STRIDE (186) — Mini Display/Ring Brightness; silenced by the old skip
const GLOBAL_MAX_PID = 14879; // the last GLOBAL range pid == the last record of the 14,880-body (inclusive bound)
const AMP_MOVED_PID = 16; // DISTORT Bright Cap — a dense pid (pid == ordinal)

export const EDIT_BURST_STRIDE_CASE_COUNT = 5;

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

/** A driver whose bulk-read poll answers `frames()` for GLOBAL/AMP; everything else is silent. */
function makeDriver(frames: () => number[][]) {
  const profile = PROFILES[MODEL]!;
  const codec = createModernFractalCodec(profile.model);
  const mock = new MockTransport('serial', 'mock-edit-burst-stride');
  mock.isOpen = true;
  mock.reply = (req) => {
    for (const eid of [GLOBAL_EID, AMP_EID]) {
      if (compactHex(req) === compactHex(codec.buildBlockBulkReadPoll(eid))) return frames();
    }
    return []; // status/silence
  };
  return createGen3Driver(profile, {
    transport: async () => mock,
    emit: () => {},
    getCadence: () => cadenceFor(profile.model, 'balanced'),
  });
}

export async function runEditBurstStrideTests(): Promise<void> {
  // ── 1. THE REGRESSION: a GLOBAL pid >= the catalogue stride IS diffed and emitted. With the old
  //    `id >= stride` skip this pid (7115 >= 186) never surfaced, so the panel edit was lost. ──
  {
    const base = new Array(DEVICE_BODY_LEN).fill(0);
    base[GLOBAL_HIGH_PID] = 100; // the primed baseline record at pid 7115
    let current = burst(GLOBAL_EID, base);
    const driver = makeDriver(() => current);
    await driver.blockParams(GLOBAL_EID); // opens GLOBAL: arms the watch + primes the whole-body baseline
    const changed = base.slice();
    changed[GLOBAL_HIGH_PID] = 30000; // the front-panel move
    current = burst(GLOBAL_EID, changed);
    const res = driver.decodeEditBurst(current);
    const moved = res.events.find((e) => e.paramId === GLOBAL_HIGH_PID);
    assert(!!moved, `case 1: a GLOBAL pid >= the catalogue stride (${GLOBAL_HIGH_PID} >= ${GLOBAL_STRIDE}) must be diffed and emitted`);
    assert(Math.abs(moved!.norm - 30000 / 65534) < 1e-6,
      `case 1: the emitted norm is the moved record over 65534 (got ${moved!.norm})`);
    assertEqual(res.reload, false, 'case 1: the primed whole-body baseline diffs without a reload');
  }

  // ── 2. The body's LAST record is in range (inclusive bound): pid 14879 (the last GLOBAL range pid) is
  //    diffed too. This pins that the extent is the FULL body, not stride-shaped. ──
  {
    const base = new Array(DEVICE_BODY_LEN).fill(0);
    let current = burst(GLOBAL_EID, base);
    const driver = makeDriver(() => current);
    await driver.blockParams(GLOBAL_EID);
    const changed = base.slice();
    changed[GLOBAL_MAX_PID] = 65534; // the final record of the 14,880-body
    current = burst(GLOBAL_EID, changed);
    const res = driver.decodeEditBurst(current);
    const moved = res.events.find((e) => e.paramId === GLOBAL_MAX_PID);
    assert(!!moved, `case 2: the last in-range GLOBAL pid (${GLOBAL_MAX_PID}) is diffed — the extent is the body, not the stride`);
    assertEqual(moved!.norm, 1, 'case 2: 65534 decodes to norm 1');
  }

  // ── 3. PER-PID HONESTY KEPT: a pid whose record the body does NOT carry is SKIPPED, never zero-filled.
  //    Prime a SHORT body (744 records), so pid 7115 has no record. A carried pid still diffs; 7115 must
  //    NOT emit a fabricated event. ──
  {
    const shortLen = GLOBAL_STRIDE * 4; // 744
    const base = new Array(shortLen).fill(0);
    let current = burst(GLOBAL_EID, base);
    const driver = makeDriver(() => current);
    await driver.blockParams(GLOBAL_EID);
    const changed = base.slice();
    changed[1] = 30000; // a CARRIED pid (1 < 744) moves
    current = burst(GLOBAL_EID, changed);
    const res = driver.decodeEditBurst(current);
    assert(res.events.some((e) => e.paramId === 1), 'case 3: a pid the short body carries still diffs');
    assert(!res.events.some((e) => e.paramId === GLOBAL_HIGH_PID),
      `case 3: a pid past the short body (${GLOBAL_HIGH_PID}) must be SKIPPED, never emitted as a fabricated 0`);
  }

  // ── 4. DENSE/CHANNEL-BLOCKED family unchanged: pid == ordinal still diffs cleanly (no bleed past the
  //    channel now that the slice runs to the body end). ──
  {
    const base = new Array(AMP_STRIDE * 4).fill(0);
    let current = burst(AMP_EID, base);
    const driver = makeDriver(() => current);
    await driver.blockParams(AMP_EID);
    const changed = base.slice();
    changed[AMP_MOVED_PID] = 30000;
    current = burst(AMP_EID, changed);
    const res = driver.decodeEditBurst(current);
    assert(res.events.some((e) => e.paramId === AMP_MOVED_PID),
      'case 4: a dense (channel-blocked) family still emits its edit-burst event');
    assert(!res.events.some((e) => e.paramId === AMP_MOVED_PID + AMP_STRIDE),
      'case 4: the diff does not bleed into the next channel (the channel base is preserved)');
  }

  // ── 5. An UNCHANGED high pid emits nothing (the fix diffs, it does not merely widen): a GLOBAL body
  //    where 7115 is identical on both reads produces no event for it. ──
  {
    const base = new Array(DEVICE_BODY_LEN).fill(0);
    base[GLOBAL_HIGH_PID] = 12345;
    let current = burst(GLOBAL_EID, base);
    const driver = makeDriver(() => current);
    await driver.blockParams(GLOBAL_EID);
    const res = driver.decodeEditBurst(current); // identical body
    assert(!res.events.some((e) => e.paramId === GLOBAL_HIGH_PID),
      'case 5: an unchanged high pid is not reported as moved');
  }
}
