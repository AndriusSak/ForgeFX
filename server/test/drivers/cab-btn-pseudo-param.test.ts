// The cab page's per-cab M / S buttons: pseudo-param ids must be resolved SERVER-SIDE.
//
// The FM3 / FM9 / Axe-Fx III cab page lays out an M and an S button per cab slot carrying pseudo
// paramIds (65286…65289; paramName CABINET_BTN_MUTE<n> / CABINET_BTN_SOLO<n>) that the device NEVER
// serves as parameters. The state they drive IS served: enum CABINET_MUTE<n> (pids 24 / 25), options
// `-- / MUTE / SOLO`. Historically the Axis CLIENT bridged the gap by matching the served NAME after
// the `_BTN_` infix — fragile: a device rename silently deleted the control, with no error.
//
// The driver now rewrites such a control to the REAL served param it drives while serving the layout,
// so /preset/blocks/:eid/params carries live ids (24 / 25) and no client has to guess by name. The M/S
// pair collapses onto the single state param both buttons drive — the S button has no param of its own
// (SOLO is an OPTION of the MUTE enum, not a param), which the board de-dupes by key.
//
// Mocked transport + the REAL static FM3 profile: no hardware.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES, resolvePseudoParamControls, type DeviceProfile, type DeviceLayout } from '../../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import type { EditorLayoutControl } from 'forgefx-midi/gen3/fm3';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
const CAB_EID = effectRoster().find((e) => e.slug === 'cab')!.page;

export const CAB_BTN_PSEUDO_PARAM_CASE_COUNT = 6;

const compactHex = (f: readonly number[]) => f.map((b) => b.toString(16).padStart(2, '0')).join('');
const enc14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];
function sysex(fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}
function blockBulkFrames(eid: number, values: readonly number[]): number[][] {
  const body: number[] = [0x00, 0x02];
  for (const v of values) body.push(...packValue16(v));
  return [sysex(0x74, [...enc14(eid), ...enc14(values.length), 0x07]), sysex(0x75, body), sysex(0x76, [])];
}

type Ctl = { label: string; paramName: string | null; paramId: number | null; rawWidget: string };
function controlsOf(r: { layout?: DeviceLayout }): Ctl[] {
  const out: Ctl[] = [];
  for (const p of r.layout?.pages ?? []) for (const row of p.rows) for (const c of row.controls) out.push(c as Ctl);
  return out;
}

/** Drive blockParams() for the cab block with CABINET_MODE = `mode` (1 → the DynaCab page). */
async function cabParams(mode: number) {
  const profile: DeviceProfile = PROFILES[MODEL]!;
  const stride = profile.rangeSections['CABINET']?.stride ?? 1;
  const values = new Array(Math.max(stride, 1) * 4).fill(0);
  values[31] = mode; // CABINET_MODE
  const bulk = blockBulkFrames(CAB_EID, values);
  const codec = createModernFractalCodec(profile.model);
  const mock = new MockTransport('serial', `mock-cab-btn-pseudo-${mode}`);
  mock.isOpen = true;
  mock.reply = (req) => (compactHex(req) === compactHex(codec.buildBlockBulkReadPoll(CAB_EID)) ? bulk : []);
  const driver = createGen3Driver(profile, {
    transport: async () => mock,
    emit: () => {},
    getCadence: () => cadenceFor(profile.model, 'balanced'),
  });
  return driver.blockParams(CAB_EID);
}

const btnRow = (label: string, paramName: string, paramId: number): EditorLayoutControl =>
  ({ label, paramName, paramId, widget: 'button', rawWidget: 'btnSquare' });

function layoutOfControls(controls: EditorLayoutControl[]): DeviceLayout {
  return { editorName: 'x', family: 'CABINET', variantName: 'v', variantValue: '1', pages: [{ name: 'Cab', rows: [{ section: 'parameters', controls }] }] };
}

export async function runCabBtnPseudoParamTests(): Promise<void> {
  const r = await cabParams(1); // the DynaCab page — it carries the M/S buttons
  const ctls = controlsOf(r);

  // 0. premise: the served layout really does carry the pseudo-id M/S buttons, and the block serves the
  //    real state enums (24 / 25) named MUTE1 / MUTE2.
  assert(r.enums.some((e) => e.id === 24 && e.name === 'MUTE1'), 'block serves MUTE1 (pid 24)');
  assert(r.enums.some((e) => e.id === 25 && e.name === 'MUTE2'), 'block serves MUTE2 (pid 25)');
  assert(ctls.some((c) => c.paramId === 65288), 'the layout still carries the S pseudo id 65288 (SOLO has no served param of its own)');

  // 1. the cab-1 M button now carries the REAL served enum id/name — not the pseudo id.
  assert(
    ctls.some((c) => c.paramId === 24 && c.paramName === 'CABINET_MUTE1'),
    `cab 1 M → real MUTE1 (24); served M/S controls: ${ctls.filter((c) => c.rawWidget === 'btnSquare').map((c) => `${c.paramId}:${c.paramName}`).join(', ')}`,
  );
  assert(!ctls.some((c) => c.paramId === 65286), 'the cab 1 M pseudo id 65286 is gone from the served layout');
  // …and cab 2's M button → real MUTE2 (25).
  assert(ctls.some((c) => c.paramId === 25 && c.paramName === 'CABINET_MUTE2'), 'cab 2 M → real MUTE2 (25)');
  assert(!ctls.some((c) => c.paramId === 65287), 'the cab 2 M pseudo id 65287 is gone from the served layout');

  // 2. pure helper: generic mapping, and the guards.
  const layout = layoutOfControls([
    btnRow('M', 'CABINET_BTN_MUTE1', 65286),
    btnRow('S', 'CABINET_BTN_SOLO1', 65288),
    btnRow('live', 'CABINET_MUTE2', 25),
  ]);
  const out = resolvePseudoParamControls(layout, [
    { id: 24, servedName: 'MUTE1', paramName: 'CABINET_MUTE1' },
    { id: 25, servedName: 'MUTE2', paramName: 'CABINET_MUTE2' },
  ]);
  const oc = out.pages[0]!.rows[0]!.controls;
  assertEqual(oc[0]!.paramId, 24, 'pure: MUTE1 pseudo → real id 24');
  assertEqual(oc[0]!.paramName, 'CABINET_MUTE1', 'pure: the real param name is written');
  assertEqual(oc[1]!.paramId, 65288, 'pure: no served SOLO1 → the pseudo id is left untouched');
  assertEqual(oc[2]!.paramId, 25, 'pure: a control already bound to a served id is NOT rewritten');

  // 3. no `_BTN_` button anywhere → the layout object is returned unchanged (fast no-op path).
  const plain = layoutOfControls([btnRow('live', 'CABINET_MUTE2', 25)]);
  assert(resolvePseudoParamControls(plain, [{ id: 24, servedName: 'MUTE1', paramName: 'CABINET_MUTE1' }]) === plain, 'pure: a layout with no pseudo-button control is returned as-is');
}
