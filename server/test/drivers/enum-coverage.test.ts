// Enum dropdown COVERAGE (real gen-3 catalogs).
//
// #enumOptions built one option per ordinal `min..max` but stopped early at a hard 128 — so every
// enum whose device-true list is longer than 128 silently lost its tail: the FM3 amp block's
// "Tonestack Type" (DISTORT/36, 138 ordinals 0..137, a `dropdown` in the device's own layout) could
// never show or select ordinals 128..137. The cap was also arbitrary rather than device-true: the
// range's own displayMin/displayMax already bound the list.
//
// Mocked transport + the REAL static profiles: no hardware.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES, SLUG_FAMILY, type DeviceProfile } from '../../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { FM3_LAYOUTS } from 'forgefx-midi/gen3/fm3';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
const AMP_EID = effectRoster().find((e) => e.slug === 'amp')!.page; // DISTORT family, instance 1
const PHASER_EID = effectRoster().find((e) => e.slug === 'phaser')!.page; // PHASER family
const TONESTACK_TYPE_PID = 36;
const PHASER_ORDER_PID = 1; // scaled enum: scale 2, displayMin/Max 0..10, enumCount 6

export const ENUM_COVERAGE_CASE_COUNT = 4;

const compactHex = (f: readonly number[]) => f.map((b) => b.toString(16).padStart(2, '0')).join('');
const enc14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];

function sysex(model: number, fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, model, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}

/** `model` MUST match the driver's own byte: the invariant below loops over the FM3/FM9/III profiles,
 *  and a reply carrying another model's byte is (correctly) rejected by the codec. */
function blockBulkFrames(model: number, effectId: number, values: readonly number[]): number[][] {
  const body: number[] = [0x00, 0x02];
  for (const v of values) body.push(...packValue16(v));
  return [
    sysex(model, 0x74, [...enc14(effectId), ...enc14(values.length), 0x07]),
    sysex(model, 0x75, body),
    sysex(model, 0x76, [])
  ];
}

/** Serve blockParams over a mocked transport and return the enum params it hands the UI. */
async function servedEnums(profile: DeviceProfile, eid: number): Promise<Map<number, { id: number; options: { value: number; label: string }[] }>> {
  const codec = createModernFractalCodec(profile.model);
  const slug = effectRoster().find((e) => e.page === eid)?.slug ?? '';
  const stride = profile.rangeSections[SLUG_FAMILY[slug] ?? '']?.stride ?? 1;
  const values = new Array(Math.max(stride, 1) * 4).fill(0);
  const bulk = blockBulkFrames(profile.model, eid, values);
  const mock = new MockTransport('serial', `mock-enum-${eid}`);
  mock.isOpen = true;
  mock.reply = (req) => (compactHex(req) === compactHex(codec.buildBlockBulkReadPoll(eid)) ? bulk : []);
  const driver = createGen3Driver(profile, {
    transport: async () => mock,
    emit: () => {},
    getCadence: () => cadenceFor(profile.model, 'balanced')
  });
  const r = await driver.blockParams(eid);
  const out = new Map<number, { id: number; options: { value: number; label: string }[] }>();
  for (const e of r.enums) out.set(e.id, e);
  return out;
}

export async function runEnumCoverageTests(): Promise<void> {
  const profile = PROFILES[MODEL]!;

  // 1. The amp block's Tonestack Type list is complete: 138 ordinals 0..137, none dropped.
  const amp = await servedEnums(profile, AMP_EID);
  const tonestack = amp.get(TONESTACK_TYPE_PID);
  assert(!!tonestack, 'amp block serves Tonestack Type (DISTORT/36) as an enum');
  const expected = profile.ranges.DISTORT![TONESTACK_TYPE_PID]!;
  assertEqual(tonestack!.options.length, expected.displayMax - expected.displayMin + 1,
    `Tonestack Type options cover the whole device range (${expected.displayMin}..${expected.displayMax})`);
  assertEqual(tonestack!.options[tonestack!.options.length - 1]!.value, expected.displayMax,
    'the last Tonestack Type option is the device-true maximum ordinal');

  // 2. Why it matters: the device's own editor layout renders it as a dropdown.
  const layoutDropdowns = new Set<number>();
  for (const variant of (FM3_LAYOUTS as { DISTORT?: { variants?: { pages?: { rows?: { controls?: { paramId?: number | null; widget?: string }[] }[] }[] }[] } }).DISTORT?.variants ?? []) {
    for (const page of variant.pages ?? []) {
      for (const row of page.rows ?? []) {
        for (const c of row.controls ?? []) {
          if (c.widget === 'dropdown' && c.paramId != null && c.paramId < 0xff00) layoutDropdowns.add(c.paramId);
        }
      }
    }
  }
  assert(layoutDropdowns.has(TONESTACK_TYPE_PID), "the FM3 amp layout declares Tonestack Type as a 'dropdown' widget");

  // 3. A SCALED enum is bounded by its ordinal count, not by its display range: the phaser's "Order"
  //    has scale 2 (display 0..10) but only 6 ordinals, so the list must be 6 long (values 0..5) — not
  //    the 11 the display range suggests, which offered 6..10 as phantom, unlabelled ordinals.
  const phaser = await servedEnums(profile, PHASER_EID);
  const order = phaser.get(PHASER_ORDER_PID);
  assert(!!order, 'phaser block serves Order (PHASER/1) as an enum');
  const orderRange = profile.ranges.PHASER![PHASER_ORDER_PID]!;
  assertEqual(orderRange.scale, 2, 'PHASER/1 is a scaled enum (display range 2× the ordinals)');
  assertEqual(order!.options.length, orderRange.enumCount, 'Order offers exactly enumCount options');
  assertEqual(order!.options.map((o) => o.value).join(','), '0,1,2,3,4,5', 'Order option values are the ordinals');

  // 4. INVARIANT: every enum the driver serves is complete — no list may be shorter than its
  //    device-true ordinal count (catches any future hard cap, on every gen-3 device).
  const offenders: string[] = [];
  for (const model of [0x10, 0x11, 0x12]) {
    const p = PROFILES[model];
    if (!p) continue;
    for (const [family, ranges] of Object.entries(p.ranges)) {
      const eid = effectRoster().find((e) => SLUG_FAMILY[e.slug] === family)?.page;
      if (eid == null) continue;
      const served = await servedEnums(p, eid);
      for (const [idStr, range] of Object.entries(ranges)) {
        if (!range || range.kind !== 'enum') continue;
        const servedEnum = served.get(Number(idStr));
        if (!servedEnum) continue; // not served as an enum (the type selector, bypass, degenerate range)
        // Ordinals, not display units: enumCount when the row carries it, else the display span.
        const want = range.enumCount ?? (range.displayMax - range.displayMin + 1);
        if (servedEnum.options.length !== want) {
          offenders.push(`0x${model.toString(16)} ${family}/${idStr}: ${servedEnum.options.length} options, want ${want}`);
        }
      }
    }
  }
  assertEqual(offenders.length, 0, `no enum list is truncated (offenders: ${offenders.slice(0, 8).join('; ') || 'none'})`);
}
