// Layout-param coverage guard (real FM3 catalog): every paramId the FM3's OWN editor layouts bind as
// a control the driver is expected to serve MUST reach the client — either as a served knob (`named`)
// or a served enum — in the family that owns it. Otherwise Axis's deviceLayoutBoard resolves the id to
// 'gap' and DRAWS NOTHING: the device page renders blank space where the hardware shows a real control.
//
// WHY: the serve filters (drivers/gen3.ts blockParams) rejected a param whenever the catalog row and
// the def's `unit` disagreed with the filter, even though the device's own layout is the authority on
// how a param is presented:
//   • GLOBAL_FS_BRIGHTNESS / GLOBAL_FS_LCD_CONTRAST (7115/7116): the FM3's FC 'Config' page draws them
//     as 'knob', the range row is a real float 0..100, but the def's unit is 'unverified' → the
//     KNOB_UNITS allowlist dropped them (Setup/Config Brightness + Contrast went blank).
//   • GLOBAL_FC_DEFAULT_LAYOUT_PFC1-3 (3602-3604): the FM3's FC 'Devices' page draws them as
//     'dropdown', the def says unit 'enum', but the catalog mined a float 1..9 row → rejected by BOTH
//     filters (the FC#1-3 startup-layout selectors went blank).
// The fix (devices.ts layoutWidgetByFamily + gen3.ts filters) honours the device's own widget evidence:
// a layout 'knob' is continuous, a 'dropdown' is a selector.
//
// INVARIANT enforced here, over the REAL static FM3 profile and mocked transport (no hardware):
//   for every control widget 'knob'|'dropdown' in ANY FM3 layout variant, in its OWNING family
//   (crossBlock.family when the control is a cross-block ref, else the layout's family):
//     • if the family has a device-true fn=0x1F range row that can serve the control
//       (an enum row, or a float row with displayMin<displayMax) → it MUST be served (named OR enums);
//     • otherwise (no row, or a degenerate 0..0 row — nothing the serve layer could show without
//       inventing a range) → it MUST be listed in DEGENERATE_ALLOWLIST with a stated reason.
//   Families with no blockParams address at all (no effectId) are not "served layouts" and are skipped.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES, SLUG_FAMILY, type DeviceProfile } from '../../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { FM3_LAYOUTS } from 'forgefx-midi/gen3/fm3';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

const MODEL = 0x11; // FM3

/** Layout widgets that bind a servable param. 'label'/'readout'/'button'/'meter'/'graph'/'spacer'
 *  carry no param the serve layer owns (labels/readouts are display-only; buttons/meters are affordances). */
const PARAM_WIDGETS = new Set(['knob', 'dropdown']);

/** Virtual-effect effectIds → family (mirrors devices.ts VIRTUAL_EID_FAMILY) — these have no roster
 *  slug, so they are absent from the effectRoster join below. */
const VIRTUAL_EID_FAMILY: Record<number, string> = { 1: 'GLOBAL', 2: 'CONTROLLERS', 3: 'MOD', 190: 'MIDIBLOCK', 199: 'FC' };

export const LAYOUT_PARAM_COVERAGE_CASE_COUNT = 3;

// A layout knob/dropdown the serve layer provably CANNOT (or intentionally does NOT) serve. Each is
// documented with its unmount reason; the guard fails if any OTHER layout param is unserved, and fails
// if an entry here becomes servable (stale).
const UNMOUNT_ALLOWLIST: Record<string, string> = {
  // — excluded as the block's type/variant selector (drivers/gen3.ts `typeId`): the client receives it
  //   as the block `type`, so it is deliberately absent from `named`/`enums`. INPUT_TYPE (7) and
  //   MIXER_MODE (14) are the real variant selectors; the rest are picked by the driver's `<FAM>_TYPE`
  //   /`/TYPE$/` fallback heuristic on families with no explicit type param.
  'CONTROLLERS/0': 'excluded as the block type/variant selector (CONTROLLERS_LFO1TYPE, driver typeId)',
  'GLOBAL/104': 'excluded as the block type/variant selector (GLOBAL_CC_BYPASS_TYPE, driver typeId)',
  'INPUT/7': 'excluded as the block type/variant selector (INPUT_TYPE, the gate-type variant)',
  'MIXER/14': 'excluded as the block type/variant selector (MIXER_MODE, the mono/stereo variant)',
  'MULTITAP/0': 'excluded as the block type/variant selector (MULTITAP_BASETYPE, driver typeId)',
  'PLEX/82': 'excluded as the block type/variant selector (PLEX_FILTERTYPE, driver typeId)',
  // — no device-true range row / degenerate row: nothing the serve layer could show without inventing a range.
  'GLOBAL/14871': 'no fn=0x1F range row in the FM3 catalog (metronome/linked global); nothing to serve',
  'GLOBAL/96': 'no fn=0x1F range row in the FM3 catalog',
  'MIDIBLOCK/0': 'MIDIBLOCK has no fn=0x1F range row; MIDI-block config is served by the MIDI endpoints',
  'MIDIBLOCK/64': 'MIDIBLOCK has no fn=0x1F range row; MIDI-block config is served by the MIDI endpoints',
  'FC/2237': 'no FC range table in the FM3 catalog; FC state is served by the FC endpoints, not blockParams',
  'FC/5640': 'no FC range table in the FM3 catalog; FC state is served by the FC endpoints, not blockParams',
  'FC/2238': 'no FC range table in the FM3 catalog; FC state is served by the FC endpoints, not blockParams',
  'FC/5641': 'no FC range table in the FM3 catalog; FC state is served by the FC endpoints, not blockParams',
  'FC/2239': 'no FC range table in the FM3 catalog; FC state is served by the FC endpoints, not blockParams',
  'FC/5642': 'no FC range table in the FM3 catalog; FC state is served by the FC endpoints, not blockParams',
  'CABINET/52': 'degenerate catalog row (float 0..0) — a zero-width range, nothing servable',
  'COMP/24': 'degenerate catalog row (float 0..0) — a zero-width range, nothing servable',
  'MOD/1': 'degenerate catalog row (float 0..0) — a zero-width range, nothing servable',
  'MOD/2': 'degenerate catalog row (float 0..0) — a zero-width range, nothing servable',
  'MULTICOMP/31': 'degenerate catalog row (float 0..0) — a zero-width range, nothing servable',
  'MULTICOMP/32': 'degenerate catalog row (float 0..0) — a zero-width range, nothing servable',
  'PITCH/107': 'degenerate catalog row (float 0..0) — a zero-width range, nothing servable',
};

const compactHex = (f: readonly number[]) => f.map((b) => b.toString(16).padStart(2, '0')).join('');
const enc14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];

function sysex(fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}

function blockBulkFrames(effectId: number, values: readonly number[]): number[][] {
  const body: number[] = [0x00, 0x02];
  for (const v of values) body.push(...packValue16(v));
  return [
    sysex(0x74, [...enc14(effectId), ...enc14(values.length), 0x07]),
    sysex(0x75, body),
    sysex(0x76, [])
  ];
}

/** Serve blockParams for one eid over a mocked transport → the set of paramIds the client receives. */
async function servedIds(profile: DeviceProfile, eid: number): Promise<Set<number>> {
  const codec = createModernFractalCodec(profile.model);
  const fam = profile.familyForEffectId(eid) ?? '';
  const stride = profile.rangeSections[fam]?.stride ?? 1;
  const bulk = blockBulkFrames(eid, new Array(Math.max(stride, 1) * 4).fill(0));
  const mock = new MockTransport('serial', `mock-layoutcov-${eid}`);
  mock.isOpen = true;
  mock.reply = (req) => (compactHex(req) === compactHex(codec.buildBlockBulkReadPoll(eid)) ? bulk : []);
  const driver = createGen3Driver(profile, {
    transport: async () => mock,
    emit: () => {},
    getCadence: () => cadenceFor(profile.model, 'balanced')
  });
  const r = await driver.blockParams(eid);
  return new Set<number>([...r.named.map((n) => n.id), ...r.enums.map((e) => e.id)]);
}

/** family → eid, for every family the driver can address via blockParams. */
function addressableFamilies(): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of effectRoster()) {
    const fam = SLUG_FAMILY[e.slug];
    if (fam && !out.has(fam)) out.set(fam, e.page);
  }
  for (const [eid, fam] of Object.entries(VIRTUAL_EID_FAMILY)) out.set(fam, Number(eid));
  return out;
}

/** The FM3 layouts' knob/dropdown bindings, filed under the param's OWNING family. */
function layoutBindings(): Map<string, Set<number>> {
  const need = new Map<string, Set<number>>();
  const layouts = FM3_LAYOUTS as unknown as Record<string, { family: string; variants?: { pages?: { rows?: { controls?: { widget?: string; paramId?: number | null; crossBlock?: { family?: string | null } }[] }[] }[] }[] }>;
  for (const block of Object.values(layouts)) {
    for (const variant of block.variants ?? []) {
      for (const page of variant.pages ?? []) {
        for (const row of page.rows ?? []) {
          for (const c of row.controls ?? []) {
            if (c.paramId == null || c.paramId >= 0xff00) continue; // pseudo-param: never served
            if (!c.widget || !PARAM_WIDGETS.has(c.widget)) continue;
            const fam = c.crossBlock?.family ?? block.family;
            if (!fam) continue;
            if (!need.has(fam)) need.set(fam, new Set());
            need.get(fam)!.add(c.paramId);
          }
        }
      }
    }
  }
  return need;
}

/** Can the serve layer show this param on its own terms? (enum row, or a non-degenerate float row) */
function servable(fam: string, id: number): boolean {
  const r = PROFILES[MODEL]!.ranges[fam]?.[id];
  if (!r) return false;
  if (r.kind === 'enum') return true;
  return r.displayMin !== r.displayMax;
}

export async function runLayoutParamCoverageTests(): Promise<void> {
  const profile = PROFILES[MODEL]!;
  const famToEid = addressableFamilies();
  const bindings = layoutBindings();

  // 1. THE DEFECT, pinned (so a filter regression fails loudly and precisely): the FM3's FC page
  //    GLOBAL params are served in their owning family. Brightness/Contrast are knobs; the PFC1-3
  //    default-layout selectors are enums. (Served-set membership only — no invented values asserted.)
  const global = await servedIds(profile, famToEid.get('GLOBAL')!);
  for (const id of [7115, 7116]) assert(global.has(id), `FM3 GLOBAL ${id} (FC page Brightness/Contrast) is served`);
  for (const id of [3602, 3603, 3604]) assert(global.has(id), `FM3 GLOBAL FC_DEFAULT_LAYOUT_PFC${id - 3601} (${id}) is served`);

  // 2. INVARIANT: every FM3 layout knob/dropdown is served in its owning family, or is on the
  //    documented allowlist. Families with no blockParams address are not served layouts → skipped.
  const offenders: string[] = [];
  const allowlistHit = new Set<string>();
  for (const [fam, ids] of bindings) {
    const eid = famToEid.get(fam);
    if (eid == null) continue; // unaddressable meta family (PRESET/RTA/TUNER/VOCODER/CROSSOVER/IRPLAYER)
    const served = await servedIds(profile, eid);
    for (const id of ids) {
      if (served.has(id)) continue;
      const key = `${fam}/${id}`;
      if (key in UNMOUNT_ALLOWLIST) { allowlistHit.add(key); continue; }
      offenders.push(`${key}${servable(fam, id) ? ' (HAS a servable range row!)' : ''}`);
    }
  }
  assertEqual(offenders.length, 0,
    `every FM3 layout knob/dropdown is served in its owning family (offenders: ${offenders.join(', ') || 'none'})`);

  // 3. The allowlist must not rot: every entry still names an unserved param (else it is stale and
  //    hides a real gap), and its reason is stated.
  const stale: string[] = [];
  for (const key of Object.keys(UNMOUNT_ALLOWLIST)) {
    if (!UNMOUNT_ALLOWLIST[key]!.trim()) stale.push(`${key} (empty reason)`);
    if (!allowlistHit.has(key)) stale.push(`${key} (now served — remove it)`);
  }
  assertEqual(stale.length, 0, `the layout-param allowlist is current and documented (stale: ${stale.join(', ') || 'none'})`);
}
