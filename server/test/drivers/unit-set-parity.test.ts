// Unit-allowlist PARITY guard: the driver's knob gate and the Axe-Fx III float-vs-enum classifier
// must answer one question with ONE set, and 'pf' must be in it.
//
// WHY: gen3.ts gated its `named` (knob) list on a KNOB_UNITS allowlist (13 units, incl 'pf', after the
// Bright-Cap regression — see knob-coverage.test.ts) while devices.ts classified an Axe-Fx III param
// float-vs-enum with a SEPARATE 12-unit set that had NO 'pf'. Two copies of one answer let them drift:
// a III param in pF would be branded kind:'enum' (a phantom per-option dropdown) instead of a float
// knob. There is now a single exported KNOB_UNITS (devices.ts), imported by the driver.
//
// Mocked transport + the REAL static III profile: no hardware.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES, SLUG_FAMILY, KNOB_UNITS, type DeviceProfile } from '../../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16, PARAMS_BY_FAMILY as AXE3_PARAMS, AXE3_RANGES as AXE3_DEVICE_RANGES } from 'forgefx-midi/gen3/axe-fx-iii';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

const MODEL_III = 0x10;
const AMP_EID = effectRoster().find((e) => e.slug === 'amp')!.page;
/** Axe-Fx III amp block Bright Cap: unit 'pf', device-true 10..10000 pF. */
const III_BRIGHTCAP_PID = 10;

export const UNIT_SET_PARITY_CASE_COUNT = 5;

const compactHex = (f: readonly number[]) => f.map((b) => b.toString(16).padStart(2, '0')).join('');
const enc14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];

function sysex(model: number, fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, model, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}

function blockBulkFrames(model: number, effectId: number, values: readonly number[]): number[][] {
  const body: number[] = [0x00, 0x02];
  for (const v of values) body.push(...packValue16(v));
  return [
    sysex(model, 0x74, [...enc14(effectId), ...enc14(values.length), 0x07]),
    sysex(model, 0x75, body),
    sysex(model, 0x76, [])
  ];
}

/** Drive blockParams() for one effect id over a mocked transport, returning the served param map. */
async function serveBlock(profile: DeviceProfile, eid: number) {
  const codec = createModernFractalCodec(profile.model);
  const slug = effectRoster().find((e) => e.page === eid)?.slug ?? '';
  const stride = profile.rangeSections[SLUG_FAMILY[slug] ?? '']?.stride ?? 1;
  const values = new Array(Math.max(stride, 1) * 4).fill(0);
  const bulk = blockBulkFrames(profile.model, eid, values);
  const mock = new MockTransport('serial', `mock-unitset-${eid}`);
  mock.isOpen = true;
  mock.reply = (req) => (compactHex(req) === compactHex(codec.buildBlockBulkReadPoll(eid)) ? bulk : []);
  const driver = createGen3Driver(profile, {
    transport: async () => mock,
    emit: () => {},
    getCadence: () => cadenceFor(profile.model, 'balanced')
  });
  return driver.blockParams(eid);
}

/** The III params whose kind is decided INLINE (their mined device range is absent, or is a
 *  placeholder all-zero float row the builder skips) — the only rows the float-vs-enum classifier
 *  actually feeds. The informative mined rows override the classifier. */
function inlineDecidedIII(): { family: string; paramId: number; unit: string }[] {
  const params = AXE3_PARAMS as unknown as Record<string, { paramId: number; unit?: string; displayMin?: number; displayMax?: number }[]>;
  const device = AXE3_DEVICE_RANGES as unknown as Record<string, Record<string, { kind: string; displayMin: number; displayMax: number }>>;
  const out: { family: string; paramId: number; unit: string }[] = [];
  for (const [family, list] of Object.entries(params)) {
    for (const p of list) {
      if (p.displayMin == null || p.displayMax == null) continue;
      const r = device[family]?.[String(p.paramId)];
      const overridden = r != null && !(r.kind === 'float' && r.displayMin === r.displayMax);
      if (overridden) continue;
      out.push({ family, paramId: p.paramId, unit: p.unit ?? '' });
    }
  }
  return out;
}

/** Source-guard for the FIX itself (the unification): gen3.ts must CONSUME devices.ts's exported
 *  KNOB_UNITS, not declare a second allowlist. Exported so a red-green probe can drive it with a
 *  perturbed source string without touching src/. Throws (fails) on a re-introduced local copy. */
export function assertSharedUnitSource(gen3Src: string, devicesSrc: string): void {
  assert(
    /KNOB_UNITS[\s\S]*?from '\.\.\/devices\.js'/.test(gen3Src),
    "gen3.ts must import KNOB_UNITS from '../devices.js' (the single shared set)"
  );
  assert(
    !/\b(?:const|let|var)\s+KNOB_UNITS\b/.test(gen3Src),
    'gen3.ts must NOT re-declare its own KNOB_UNITS allowlist (the two-copies drift this fix removed)'
  );
  assert(/export const KNOB_UNITS\b/.test(devicesSrc), 'devices.ts must EXPORT KNOB_UNITS as the single source of truth');
}

export async function runUnitSetParityTests(): Promise<void> {
  // 1. ONE exported source of truth: the shared set carries all 13 musician-facing units, 'pf'
  //    included. (Guards the drift: a shrink that drops 'pf' fails here.)
  const expected = ['numeric', 'knob_0_10', 'knob_0_20', 'db', 'hz', 'ms', 'seconds', 'percent', 'bipolar_percent', 'ratio', 'semitones', 'degrees', 'pf'];
  assertEqual(KNOB_UNITS.size, expected.length, 'KNOB_UNITS holds exactly the 13 display units');
  for (const u of expected) assert(KNOB_UNITS.has(u), `shared KNOB_UNITS includes '${u}'`);

  // 2. The III Bright Cap is classified a FLOAT knob, not a phantom enum dropdown: its unit 'pf' is
  //    a real display unit the classifier must honour. (Pin the intended III outcome.)
  const iii = PROFILES[MODEL_III]!;
  const def = (iii.params.DISTORT ?? []).find((d) => d.paramId === III_BRIGHTCAP_PID);
  assertEqual(def?.unit, 'pf', 'III Bright Cap (DISTORT/10) carries unit pf');
  const range = iii.ranges.DISTORT![III_BRIGHTCAP_PID]!;
  assertEqual(range.kind, 'float', 'III Bright Cap classifies as a float knob, not an enum');
  assertEqual(range.displayMax, 10000, 'III Bright Cap keeps its device-true display max (10000 pF)');
  // …and the driver actually serves it as a knob (named), never as an enum.
  const served = await serveBlock(iii, AMP_EID);
  assert(served.named.some((n) => n.id === III_BRIGHTCAP_PID), 'III amp block serves Bright Cap as a knob');
  assert(!served.enums.some((e) => e.id === III_BRIGHTCAP_PID), 'III amp block does NOT serve Bright Cap as an enum');

  // 3. Adding 'pf' to the classifier is provably behavior-preserving on the CURRENT III catalog: no
  //    inline-decided row carries unit 'pf' (every pf row — there is one — is a mined float). So the
  //    unified set changes no existing classification; the drift was latent, not a live mis-brand.
  //    GUARD the set is non-empty first — an empty inline set would make the equality below pass vacuously
  //    (and cases 2-4 all rest on this set being a real population).
  const inline = inlineDecidedIII();
  assert(inline.length > 0, 'the inline-decided III catalog is non-empty (else the pf assertion below is vacuous)');
  const pfInline = inline.filter((r) => r.unit === 'pf');
  assertEqual(pfInline.length, 0,
    `no inline-decided III param carries unit 'pf' (found: ${pfInline.map((r) => `${r.family}/${r.paramId}`).join(', ') || 'none'})`);

  // 4. The classifier is actually WIRED to the shared KNOB_UNITS: for every inline-decided row (the only
  //    rows the inline classifier feeds — the mined device rows override it), the classified `kind` must
  //    equal `KNOB_UNITS.has(unit)`. Changing KNOB_UNITS' membership of a unit that appears here makes
  //    this fail, so the classifier and the driver gate provably read ONE set. (Non-empty guarded above.)
  for (const { family, paramId, unit } of inline) {
    const kind = PROFILES[MODEL_III]!.ranges[family]?.[paramId]?.kind;
    const want = KNOB_UNITS.has(unit) ? 'float' : 'enum';
    assertEqual(kind, want, `III ${family}/${paramId} (unit '${unit}') classified '${kind}', expected '${want}' from KNOB_UNITS`);
  }

  // 5. THE FIX ITSELF — one source of truth. Cases 2-4 pin the III OUTCOME, but the mined catalog means
  //    they pass even if gen3.ts re-declared its own allowlist (the drift risk). This source-guard fails
  //    if the driver stops importing the shared KNOB_UNITS or re-introduces a local copy.
  const srcDir = new URL('../../src/', import.meta.url);
  const gen3Src = readFileSync(fileURLToPath(new URL('drivers/gen3.ts', srcDir)), 'utf8');
  const devicesSrc = readFileSync(fileURLToPath(new URL('devices.ts', srcDir)), 'utf8');
  assertSharedUnitSource(gen3Src, devicesSrc);
}
