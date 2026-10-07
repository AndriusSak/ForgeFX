// Knob-coverage guard (real FM3 catalog): every continuous control the device itself can display must
// reach the client as a knob.
//
// WHY: gen-3 blockParams gates its `named` (knob) list on a hardcoded KNOB_UNITS allowlist. That
// allowlist is meant to drop only the NON-display unit markers ('unverified', 'count', 'enum' — see
// the comment on KNOB_UNITS). A real display unit missing from the allowlist silently deletes the
// control from every client: the param is never served, so the UI cannot render it.
//
// Regression: the FM3 amp block's "Bright Cap" (DISTORT/16, 10..10000 pF, the pinned fw>=8.00 amp
// layout's own 'knob' on the Ideal page) carried unit 'pf' — which UNIT_LABEL renders as 'pF' — but
// 'pf' was absent from KNOB_UNITS, so Bright Cap was unreachable in the editor.
//
// Mocked transport + the REAL static FM3 profile: no hardware, no synthetic profile.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES, SLUG_FAMILY, type DeviceProfile } from '../../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { FM3_LAYOUTS } from 'forgefx-midi/gen3/fm3';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
const AMP_EID = effectRoster().find((e) => e.slug === 'amp')!.page; // DISTORT family, instance 1

/** Unit markers that are NOT display units — the only units blockParams may drop a float param for.
 *  Mirrors the KNOB_UNITS comment: 'unverified' (no display calibration), 'count' (a count, not a
 *  knob), 'enum' (a selector). Every other unit on a float range is a musician-facing knob. */
const NON_KNOB_UNITS = new Set(['unverified', 'count', 'enum']);

export const KNOB_COVERAGE_CASE_COUNT = 4;

const compactHex = (f: readonly number[]) => f.map((b) => b.toString(16).padStart(2, '0')).join('');
const enc14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];

function sysex(model: number, fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, model, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}

/** fn=0x74/0x75/0x76 block-bulk-read reply carrying `values` (same shape as definition-completeness).
 *  `model` MUST match the driver's own byte: the invariant below runs the loop over the FM3/FM9/III
 *  profiles, and a reply carrying another model's byte is (correctly) rejected by the codec. */
function blockBulkFrames(model: number, effectId: number, values: readonly number[]): number[][] {
  const body: number[] = [0x00, 0x02];
  for (const v of values) body.push(...packValue16(v));
  return [
    sysex(model, 0x74, [...enc14(effectId), ...enc14(values.length), 0x07]),
    sysex(model, 0x75, body),
    sysex(model, 0x76, [])
  ];
}

/** Drive blockParams() for one effect id over a mocked transport, returning the served knob ids. */
async function servedKnobs(profile: DeviceProfile, eid: number): Promise<Map<number, { id: number; unit?: string; min?: number; max?: number }>> {
  const codec = createModernFractalCodec(profile.model);
  const stride = profile.rangeSections[SLUG_FAMILY[familyForEid(eid)] ?? '']?.stride ?? 1;
  const values = new Array(Math.max(stride, 1) * 4).fill(0);
  const bulk = blockBulkFrames(profile.model, eid, values);
  const mock = new MockTransport('serial', `mock-knob-${eid}`);
  mock.isOpen = true;
  mock.reply = (req) => (compactHex(req) === compactHex(codec.buildBlockBulkReadPoll(eid)) ? bulk : []);
  const driver = createGen3Driver(profile, {
    transport: async () => mock,
    emit: () => {},
    getCadence: () => cadenceFor(profile.model, 'balanced')
  });
  const r = await driver.blockParams(eid);
  const out = new Map<number, { id: number; unit?: string; min?: number; max?: number }>();
  for (const n of r.named) out.set(n.id, n);
  return out;
}

/** The catalog family a roster eid belongs to (same join the driver uses). */
function familyForEid(eid: number): string {
  const slug = effectRoster().find((e) => e.page === eid)?.slug;
  return (slug && SLUG_FAMILY[slug]) || '';
}

export async function runKnobCoverageTests(): Promise<void> {
  const profile = PROFILES[MODEL]!;

  // 1. The FM3 amp block's Bright Cap is served, with its device-true pF range.
  const amp = await servedKnobs(profile, AMP_EID);
  const brightCap = amp.get(16);
  assert(!!brightCap, 'amp block serves Bright Cap (DISTORT/16) as a knob');
  assertEqual(brightCap!.unit, 'pF', 'Bright Cap readout carries the pF unit');
  assertEqual(brightCap!.min, 10, 'Bright Cap device-true min (10 pF)');
  assertEqual(brightCap!.max, 10000, 'Bright Cap device-true max (10000 pF)');

  // 2. Why it matters: the device's OWN editor layout renders it as a knob (pinned fw>=8.00 variant).
  const layoutKnobIds = new Set<number>();
  for (const variant of (FM3_LAYOUTS as { DISTORT?: { variants?: { pages?: { rows?: { controls?: { paramId?: number | null; widget?: string }[] }[] }[] }[] } }).DISTORT?.variants ?? []) {
    for (const page of variant.pages ?? []) {
      for (const row of page.rows ?? []) {
        for (const c of row.controls ?? []) {
          if (c.widget === 'knob' && c.paramId != null && c.paramId < 0xff00) layoutKnobIds.add(c.paramId);
        }
      }
    }
  }
  assert(layoutKnobIds.has(16), "the FM3 amp layout itself declares Bright Cap as a 'knob' widget");

  // 3. INVARIANT: no float param is dropped for its UNIT unless the unit is a non-knob marker.
  //    (Catches the next 'pf'-class omission: a real display unit missing from KNOB_UNITS.)
  //    KNOB_UNITS is shared by every gen-3 device, so the guard runs on all three profiles —
  //    Bright Cap (pf) exists on the FM3, FM9 AND Axe-Fx III, and the same omission hid it on all three.
  const offenders: string[] = [];
  for (const model of [0x10, 0x11, 0x12]) {
    const p = PROFILES[model];
    if (!p) continue;
    for (const [family, ranges] of Object.entries(p.ranges)) {
      const eid = effectRoster().find((e) => SLUG_FAMILY[e.slug] === family)?.page;
      if (eid == null) continue; // no placed-block slug for this family (GLOBAL, CONTROLLERS, …)
      const served = await servedKnobs(p, eid);
      const defs = p.params[family] ?? [];
      for (const [idStr, range] of Object.entries(ranges)) {
        if (!range || range.kind !== 'float') continue;
        if (range.displayMin === range.displayMax) continue; // unusable 0..0 knob
        const def = defs.find((d) => d.paramId === Number(idStr));
        if (!def) continue; // no device-true param row → nothing to serve
        if (/bypass/i.test(def.displayLabel ?? def.name)) continue;
        const unit = def.unit ?? '';
        if (NON_KNOB_UNITS.has(unit)) continue;
        if (!served.has(Number(idStr))) offenders.push(`0x${model.toString(16)} ${family}/${idStr} "${def.displayLabel ?? def.name}" (unit '${unit}')`);
      }
    }
  }
  assertEqual(offenders.length, 0, `no displayable unit is missing from KNOB_UNITS (offenders: ${offenders.join(', ') || 'none'})`);

  // 4. The Cab block's DynaCab mic Position reaches the client. The FM3 layout binds BOTH its
  //    'Position' knob AND its dynaCabControl mic graph (CAP->EDGE) to CABINET/93, and the Axis
  //    Cab page renders Distance 1/2 but no Position and no graph when the param is absent.
  //    Case 3 does NOT protect this: while the unit reads a non-knob marker the param is skipped,
  //    so reverting the unit would fail nothing. Pin the two ids explicitly.
  const CAB_EID = effectRoster().find((e) => e.slug === 'cab')!.page;
  const cab = await servedKnobs(profile, CAB_EID);
  for (const id of [93, 94]) {
    const pos = cab.get(id);
    assert(!!pos, `cab block serves DynaCab Position (CABINET/${id}) as a knob`);
    assertEqual(pos!.min, 0, `DynaCab Position ${id} device-true min`);
    assertEqual(pos!.max, 10, `DynaCab Position ${id} device-true max`);
  }
}
