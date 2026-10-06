// The Cab block's page follows the cab MODE, not the PREAMP type.
//
// WHY: the FM3 CABINET layout has two variants keyed on value 0/1 — variant 0 is the Legacy-IR page,
// variant 1 is the DynaCab page (it carries the `dynaCabControl` mic graph the Axis Cab tab draws).
// The variant is chosen from the family's "type" selector, which gen3.ts resolves via #paramId:
// `${family}_MODEL` → `${family}_TYPE` → `${family}_MODE` → an enum whose name ends in TYPE.
//
// CABINET has no MODEL/TYPE param, so the loose /TYPE$/ fallback matched CABINET_PRETYPE (pid 43) —
// the cab's *Preamp Type*. The served page then flipped with the unrelated preamp model (the DynaCab
// page appeared only when the preamp type happened to be index 1), and the Preamp Type dropdown was
// swallowed into the "type" slot instead of being served as an enum.
//
// Mocked transport + the REAL static FM3 profile: no hardware.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES, type DeviceProfile } from '../../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
const CAB_EID = effectRoster().find((e) => e.slug === 'cab')!.page;

export const CAB_LAYOUT_VARIANT_CASE_COUNT = 3;

const compactHex = (f: readonly number[]) => f.map((b) => b.toString(16).padStart(2, '0')).join('');
const enc14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];

function sysex(fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}

/** fn=0x74/0x75/0x76 block-bulk-read reply carrying `values` (same shape as knob-coverage). */
function blockBulkFrames(eid: number, values: readonly number[]): number[][] {
  const body: number[] = [0x00, 0x02];
  for (const v of values) body.push(...packValue16(v));
  return [sysex(0x74, [...enc14(eid), ...enc14(values.length), 0x07]), sysex(0x75, body), sysex(0x76, [])];
}

/** Drive blockParams() for the cab block with CABINET_MODE / CABINET_PRETYPE set to `mode` / `preamp`. */
async function cabParams(mode: number, preamp: number) {
  const profile: DeviceProfile = PROFILES[MODEL]!;
  const stride = profile.rangeSections['CABINET']?.stride ?? 1;
  const values = new Array(Math.max(stride, 1) * 4).fill(0);
  values[31] = mode; // CABINET_MODE
  values[43] = preamp; // CABINET_PRETYPE
  const bulk = blockBulkFrames(CAB_EID, values);
  const codec = createModernFractalCodec(profile.model);
  const mock = new MockTransport('serial', `mock-cab-m${mode}p${preamp}`);
  mock.isOpen = true;
  mock.reply = (req) => (compactHex(req) === compactHex(codec.buildBlockBulkReadPoll(CAB_EID)) ? bulk : []);
  const driver = createGen3Driver(profile, {
    transport: async () => mock,
    emit: () => {},
    getCadence: () => cadenceFor(profile.model, 'balanced'),
  });
  return driver.blockParams(CAB_EID);
}

/** rawWidgets of every control in the served layout. */
function rawWidgets(r: { layout?: { pages?: { rows?: { controls?: { rawWidget?: string; paramId?: number | null }[] }[] }[] } }) {
  const out: { rawWidget?: string; paramId?: number | null }[] = [];
  for (const p of r.layout?.pages ?? []) for (const row of p.rows ?? []) for (const c of row.controls ?? []) out.push(c);
  return out;
}

export async function runCabLayoutVariantTests(): Promise<void> {
  // 1. Mode 0 = the Legacy-IR page; mode 1 = the DynaCab page with the mic graph control.
  const legacy = await cabParams(0, 0);
  assertEqual(
    rawWidgets(legacy).filter((c) => c.rawWidget === 'dynaCabControl').length,
    0,
    'CABINET_MODE 0 serves the Legacy page (no dynaCabControl)',
  );
  const dyna = await cabParams(1, 0);
  const graphs = rawWidgets(dyna).filter((c) => c.rawWidget === 'dynaCabControl');
  assertEqual(graphs.length, 2, 'CABINET_MODE 1 serves the DynaCab page (cab 1 + cab 2 mic graphs)');
  assertEqual(graphs[0]?.paramId, 93, 'the first mic graph binds CABINET_DYNACAB_R1 so the Axis graph can read it');

  // 2. The PREAMP type must not influence the page (it is a separate section, not the layout selector).
  const preampOnly = await cabParams(0, 1);
  assertEqual(
    rawWidgets(preampOnly).filter((c) => c.rawWidget === 'dynaCabControl').length,
    0,
    'CABINET_PRETYPE 1 does NOT switch the page to DynaCab (the mode does)',
  );

  // 3. …and the Preamp Type is served as a normal enum now that "type" no longer claims it.
  assert(
    preampOnly.enums.some((e) => e.id === 43),
    'CABINET_PRETYPE (pid 43) is served as an enum, not swallowed as the type selector',
  );
}
