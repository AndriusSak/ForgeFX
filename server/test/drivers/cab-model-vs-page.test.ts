// The cab's PUBLISHED MODEL must follow the page the block is on, not the page flag.
//
// WHY: `#paramId('CABINET','type')` resolves to CABINET_MODE (pid 31), the Legacy/DynaCab PAGE flag
// (0 = Legacy IR page, 1 = DynaCab page). Publishing that value through the 45-entry cab-model roster
// made EVERY cab report `{value:1, name:'1x8 PRINCETONE'}` whatever it actually held — measured on the
// owner's unit 2026-10-13: the served name never moved while CABINET_TYPE1 went 0 -> 27 -> 31 -> 38 -> 42
// across four cab channels, while the unit's own screen showed the model it had been given. The model
// lives on the page the mode selects: CABINET_DYNACAB_TYPE1 (pid 85) on the DynaCab page,
// CABINET_TYPE1 (pid 4) on the Legacy page. `POST /preset/blocks/:eid/type` wrote the MODE param too, so
// "retype a cab" was a SILENT NO-OP that answered {ok:true} (the device ignored the out-of-range ordinal).
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
const CAB_MODE_PID = 31;
const CAB_LEGACY_TYPE1_PID = 4;
const CAB_DYNACAB_TYPE1_PID = 85;

// The roster positions the owner's build wrote, with the names the device's own display confirmed.
const DYNACAB_MODEL = 27;   // 2x12 DOUBLE VERB
const LEGACY_MODEL = 31;    // 4x12 1960TV

export const CAB_MODEL_VS_PAGE_CASE_COUNT = 10;

const compactHex = (f: readonly number[]) => f.map((b) => b.toString(16).padStart(2, '0')).join('');
const enc14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];

function sysex(fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}

/** fn=0x74/0x75/0x76 block-bulk-read reply (the fn=0x1F body the driver slices). */
function blockBulkFrames(eid: number, values: readonly number[]): number[][] {
  const body: number[] = [0x00, 0x02];
  for (const v of values) body.push(...packValue16(v));
  return [sysex(0x74, [...enc14(eid), ...enc14(values.length), 0x07]), sysex(0x75, body), sysex(0x76, [])];
}

interface CabOpts {
  /** CABINET_MODE: 0 = Legacy IR page, 1 = DynaCab page. */
  mode: number;
  /** CABINET_TYPE1 (pid 4) — the LEGACY page's model/IR slot. */
  legacy?: number;
  /** CABINET_DYNACAB_TYPE1 (pid 85) — the DYNACAB page's model. */
  dyna?: number;
  /** Answer the fn=0x13 status dump (required by any path that reads the active channel first). */
  statusDump?: boolean;
  /** Deliver only the bulk head → a torn read, which must refuse rather than guess. */
  torn?: boolean;
}

function cabDriver(o: CabOpts) {
  const profile: DeviceProfile = PROFILES[MODEL]!;
  const stride = profile.rangeSections['CABINET']?.stride ?? 1;
  const values = new Array(Math.max(stride, 1) * 4).fill(0);
  values[CAB_MODE_PID] = o.mode;
  values[CAB_LEGACY_TYPE1_PID] = o.legacy ?? 0;
  values[CAB_DYNACAB_TYPE1_PID] = o.dyna ?? 0;
  const bulk = blockBulkFrames(CAB_EID, values);
  const codec = createModernFractalCodec(profile.model);
  const mock = new MockTransport('serial', `mock-cab-m${o.mode}`);
  mock.isOpen = true;
  mock.reply = (req) => {
    const h = compactHex(req);
    if (h === compactHex(codec.buildBlockBulkReadPoll(CAB_EID))) return o.torn ? bulk.slice(0, 1) : bulk;
    if (o.statusDump && h === compactHex(codec.buildStatusDump())) return [sysex(0x13, [...enc14(CAB_EID), 0])];
    return [];
  };
  const driver = createGen3Driver(profile, {
    transport: async () => mock,
    emit: () => {},
    getCadence: () => cadenceFor(profile.model, 'balanced'),
  });
  return { driver, mock, codec };
}

/** rawWidgets of every control in the served layout. */
function rawWidgets(r: { layout?: { pages?: { rows?: { controls?: { rawWidget?: string }[] }[] }[] } }) {
  const out: string[] = [];
  for (const p of r.layout?.pages ?? []) for (const row of p.rows ?? []) for (const c of row.controls ?? []) out.push(c.rawWidget ?? '');
  return out;
}

export async function runCabModelVsPageTests(): Promise<void> {
  // 1. DynaCab page: the published model is the DynaCab model, NOT the mode value (1 -> '1x8 PRINCETONE').
  const dyna = await cabDriver({ mode: 1, legacy: LEGACY_MODEL, dyna: DYNACAB_MODEL }).driver.blockParams(CAB_EID);
  assertEqual(dyna.type?.value, DYNACAB_MODEL, `mode 1 publishes the DYNACAB model (pid 85), not the mode`);
  assertEqual(dyna.type?.name, '2x12 DOUBLE VERB', 'mode 1 publishes the DynaCab model NAME (the unit read this back)');

  // 2. Legacy page: the published model is CABINET_TYPE1.
  const legacy = await cabDriver({ mode: 0, legacy: LEGACY_MODEL, dyna: DYNACAB_MODEL }).driver.blockParams(CAB_EID);
  assertEqual(legacy.type?.value, LEGACY_MODEL, 'mode 0 publishes the LEGACY model (pid 4)');
  assertEqual(legacy.type?.name, '4x12 1960TV', 'mode 0 publishes the legacy model NAME');

  // 3. The served model comes from the LIVE page only — the inert page's value must not leak through.
  const leak = await cabDriver({ mode: 1, legacy: LEGACY_MODEL, dyna: 0 }).driver.blockParams(CAB_EID);
  assert(
    leak.type?.name === '1x8 5F1 TWEED' && leak.type?.value === 0,
    `on the DynaCab page a populated LEGACY slot must NOT be published as the model (got ${JSON.stringify(leak.type)})`,
  );

  // 4. The page variant still follows the MODE — the fix must not break the layout selector.
  const dynaWidgets = rawWidgets(dyna).filter((w) => w === 'dynaCabControl').length;
  const legacyWidgets = rawWidgets(legacy).filter((w) => w === 'dynaCabControl').length;
  assert(
    dynaWidgets === 2 && legacyWidgets === 0,
    `the page still follows CABINET_MODE (DynaCab ${dynaWidgets} mic graphs, Legacy ${legacyWidgets})`,
  );

  // 8. A 16-BIT-SCALED page flag (65534 = the ordinal max) means the same page. Comparing the RAW record
  //    against 1 picked the Legacy model and the Legacy page for a DynaCab cab.
  const scaled = await cabDriver({ mode: 65534, legacy: LEGACY_MODEL, dyna: DYNACAB_MODEL }).driver.blockParams(CAB_EID);
  assertEqual(scaled.type?.value, DYNACAB_MODEL, 'a scaled CABINET_MODE (65534) still resolves to the DynaCab page');
  assertEqual(scaled.type?.name, '2x12 DOUBLE VERB', 'the scaled mode publishes the DynaCab model name');
  assertEqual(rawWidgets(scaled).filter((w) => w === 'dynaCabControl').length, 2, 'the scaled mode resolves the DynaCab page');

  // 5. setType on the DynaCab page writes the DynaCab MODEL, and never the mode param.
  //    The block is READ FIRST (as a client opening the Cab block does), which is also what makes the
  //    `?dryRun` preview honest: the page is then known from the last-read body, with NO read frame inside
  //    the write path (the dry-run scope replaces the transport for reads too).
  const t1 = cabDriver({ mode: 1, statusDump: true });
  await t1.driver.blockParams(CAB_EID); // prime the last-known body — no frames during setType below
  const framesBeforeSetType = t1.mock.sent.length;
  const r1 = await t1.driver.setType(CAB_EID, DYNACAB_MODEL);
  const setTypeFrames = t1.mock.sent.slice(framesBeforeSetType);
  assert(r1.ok, 'setType on the DynaCab page reports ok');
  assert(
    t1.mock.sent.some((f) => compactHex(f) === compactHex(t1.codec.buildSetParameter(CAB_EID, CAB_DYNACAB_TYPE1_PID, DYNACAB_MODEL))),
    'setType sends the SET frame for CABINET_DYNACAB_TYPE1 (pid 85)',
  );
  assert(
    !t1.mock.sent.some((f) => compactHex(f) === compactHex(t1.codec.buildSetParameter(CAB_EID, CAB_MODE_PID, DYNACAB_MODEL))),
    'setType never sends a SET for CABINET_MODE (pid 31) — the silent no-op this replaces',
  );
  // 9. …and it sends EXACTLY that one frame when the page is already known: no read frame rides inside the
  //    write path, which is what keeps a `?dryRun` PREVIEW (a recording transport that answers no read)
  //    from showing an empty frame list while a real run sends a write.
  assertEqual(
    setTypeFrames.length,
    1,
    `setType with a known page sends exactly one frame (the write), got ${setTypeFrames.map(compactHex).join(' | ')}`,
  );

  // 6. setType on the Legacy page writes CABINET_TYPE1 (pid 4).
  const t0 = cabDriver({ mode: 0, statusDump: true });
  const r0 = await t0.driver.setType(CAB_EID, LEGACY_MODEL);
  assert(r0.ok, 'setType on the Legacy page reports ok');
  assert(
    t0.mock.sent.some((f) => compactHex(f) === compactHex(t0.codec.buildSetParameter(CAB_EID, CAB_LEGACY_TYPE1_PID, LEGACY_MODEL))),
    'setType sends the SET frame for CABINET_TYPE1 (pid 4)',
  );

  // 10. A COLD block (nothing read yet) falls back to a read — the write still lands, just with the read
  //     frames in front of it. Pinned so the fallback cannot be deleted as dead code, and so the
  //     frame-count difference between warm and cold is a stated property, not a surprise.
  const cold = cabDriver({ mode: 1, statusDump: true });
  {
    const before = cold.mock.sent.length;
    const rc = await cold.driver.setType(CAB_EID, DYNACAB_MODEL);
    const sent = cold.mock.sent.slice(before);
    assert(rc.ok, 'setType on a COLD cab block still reports ok (via the read fallback)');
    assert(sent.length > 1, `a cold setType reads the page first (sent ${sent.length} frames)`);
    assertEqual(
      compactHex(sent[sent.length - 1]!),
      compactHex(cold.codec.buildSetParameter(CAB_EID, CAB_DYNACAB_TYPE1_PID, DYNACAB_MODEL)),
      'the cold path still ends in the model write, after the read',
    );
  }

  // 7. A torn page read refuses the write outright (no frames) — a wrong page is not a guess to make.
  const torn = cabDriver({ mode: 1, statusDump: true, torn: true });
  const rTorn = await torn.driver.setType(CAB_EID, DYNACAB_MODEL);
  assert(!rTorn.ok, 'setType on a torn block read returns ok:false');
  assert(
    !torn.mock.sent.some((f) => {
      const h = compactHex(f);
      return h === compactHex(torn.codec.buildSetParameter(CAB_EID, CAB_DYNACAB_TYPE1_PID, DYNACAB_MODEL))
        || h === compactHex(torn.codec.buildSetParameter(CAB_EID, CAB_LEGACY_TYPE1_PID, DYNACAB_MODEL));
    }),
    'setType on a torn block read sends NO model write',
  );
}
