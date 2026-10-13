// `GET /presets/:n/grid` must answer the ADDRESSED SLOT, not the live edit buffer.
//
// WHY: both surfaces registered the route as `(_req, reply) => gridH(reply)`, i.e. the path parameter was
// dropped and every call answered the EDIT BUFFER's grid. The Axis preset browser fills its per-preset
// preview with exactly this call (PresetBrowser.svelte → forgefx.presetGrid(n)), so every entry in the
// browser showed the chain of whatever preset happened to be loaded. Measured 2026-10-13:
// /presets/415/grid returned name "80s Rock" with 9 cells while /presets/415/summary correctly answered
// `<EMPTY>` — the slot really was empty. The prep suite asserted only that the route EXISTS
// (a bare row in the parity matrix), so nothing could catch the wrong grid.
//
// Route-level over `app.inject` + the browser router with a FAKE driver whose live and per-slot grids are
// distinguishable, plus driver-level cases on the REAL gen-3 driver + MockTransport for the dump target
// (no hardware, no decodable body needed: the frames the driver SENDS name the slot).
import { buildTestApp } from '../helpers/api.js';
import { createRouter } from '../../src/runtime/router.js';
import * as store from '../../src/store.js';
import type { DeviceDriver, DriverCapabilities, PresetGridDTO } from '../../src/drivers/types.js';
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES } from '../../src/devices.js';
import { createModernFractalCodec } from 'forgefx-midi/gen3/axe-fx-iii';
import { MockTransport, assert, assertEqual, hex } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
const EDIT_BUFFER = 0x3fff;

export const PRESET_GRID_BY_NUMBER_CASE_COUNT = 8;

const gridDto = (name: string, effectId: number): PresetGridDTO => ({
  model: 'fm3', name, crcValid: true, rows: 4, cols: 12, scenes: [name],
  cells: [{ row: 0, col: 0, effectId, name: `${name} cell`, isShunt: false, routeFlag: 0, fromRows: [] }],
  source: 'dump',
});

const CAPS: DriverCapabilities = {
  slotModel: 'grid', grid: { rows: 4, cols: 12 }, gridEdit: true, scenes: 8, channels: true,
  presetDump: true, blockParamDecode: true, telemetry: { tuner: false, outputMeters: false, cpu: false },
  fcModel: true, fcLiveRead: false, modBind: true, cabIrs: true, supportsSave: false, selfDescribe: false,
  cacheImport: false, fullCapture: false,
};

/** Fake FM3 whose LIVE grid and per-slot grid are distinguishable by name + cell. */
function fakeDriver(withSlotGrid: boolean): DeviceDriver {
  return {
    modelId: MODEL,
    key: 'fm3',
    name: 'FM3',
    capabilities: CAPS,
    grid: async () => gridDto('LIVE', 58),
    ...(withSlotGrid ? { gridForSlot: async (n: number) => gridDto(`SLOT-${n}`, 60 + n) } : {}),
    placedBlocks: async () => [],
  } as unknown as DeviceDriver;
}

export async function runPresetGridByNumberTests(): Promise<void> {
  const { app, registry } = await buildTestApp(MODEL, fakeDriver(true));
  const router = createRouter({ registry, store: store.defaultStore });

  // ── 1. The addressed slot's grid, NOT the live one. ──
  {
    const res = await app.inject({ method: 'GET', url: '/presets/7/grid' });
    assertEqual(res.statusCode, 200, '/presets/7/grid answers 200');
    const body = res.json() as PresetGridDTO;
    assertEqual(body.name, 'SLOT-7', 'the path parameter selects the slot (the live grid is not substituted)');
    assertEqual(body.cells[0]?.effectId, 67, 'the cells are the slot dump’s, not the edit buffer’s');
  }

  // ── 2. /preset/grid still reads the LIVE edit buffer. ──
  {
    const res = await app.inject({ method: 'GET', url: '/preset/grid' });
    assertEqual(res.statusCode, 200, '/preset/grid answers 200');
    assertEqual((res.json() as PresetGridDTO).name, 'LIVE', '/preset/grid is still the live edit buffer');
  }

  // ── 3. Both surfaces agree (the browser router must not drift). ──
  {
    const routed = await router.handle('GET', '/presets/9/grid', null);
    assertEqual(routed.status, 200, 'the router answers /presets/9/grid with 200');
    const slotBody = JSON.parse(routed.body as string) as PresetGridDTO;
    assertEqual(slotBody.name, 'SLOT-9', 'the router also honours the slot number');
    const liveRouted = await router.handle('GET', '/preset/grid', null);
    const liveBody = JSON.parse(liveRouted.body as string) as PresetGridDTO;
    assertEqual(liveBody.name, 'LIVE', 'the router keeps the live grid on /preset/grid');
  }

  // ── 4. A bad slot number is a 400 — never a silent fallback to the live grid. ──
  {
    const res = await app.inject({ method: 'GET', url: '/presets/abc/grid' });
    assertEqual(res.statusCode, 400, 'a non-numeric slot is a 400');
    assert(
      JSON.stringify(res.json()).includes('preset number'),
      'the 400 names the offending field rather than answering a grid',
    );
  }

  // ── 5. A driver without a slot grid (AM4 / gen-1 / gen-2 / VP4): the live grid IS the addressed slot's
  //      grid only when that slot is the LOADED one; every other slot is a named 501, never the loaded
  //      preset's grid (the substitution this route had).
  {
    const noSlot = fakeDriver(false);
    (noSlot as { presetRef?: unknown }).presetRef = async () => ({ number: 12, name: 'P12' });
    const { app: appNoSlot } = await buildTestApp(MODEL, noSlot);
    const loaded = await appNoSlot.inject({ method: 'GET', url: '/presets/12/grid' });
    assertEqual(loaded.statusCode, 200, 'the LOADED slot answers 200 without a slot-dump capability');
    assertEqual((loaded.json() as PresetGridDTO).name, 'LIVE', 'that answer is the live grid — which IS slot 12');
    const other = await appNoSlot.inject({ method: 'GET', url: '/presets/9/grid' });
    assertEqual(other.statusCode, 501, 'a DIFFERENT slot is 501 (unsupported), never the loaded preset');
  }

  // ── 6. Driver: gridForSlot(n) dumps SLOT n on the wire. ──
  {
    const profile = PROFILES[MODEL]!;
    const codec = createModernFractalCodec(profile.model);
    const mock = new MockTransport('serial', 'mock-grid-slot');
    mock.isOpen = true;
    mock.reply = () => [];
    const driver = createGen3Driver(profile, {
      transport: async () => mock,
      emit: () => {},
      getCadence: () => cadenceFor(profile.model, 'balanced'),
    });
    await driver.gridForSlot(7).then(() => undefined, () => undefined);
    const sent = mock.sent.map(hex);
    assert(sent.includes(hex(codec.buildRequestPresetDump(7))), 'gridForSlot(7) asks the device for preset 7');
    assert(
      !sent.includes(hex(codec.buildRequestPresetDump(EDIT_BUFFER))),
      'gridForSlot NEVER falls back to the edit-buffer sentinel (0x3fff)',
    );
  }

  // ── 7. Driver: an undecodable slot dump REJECTS — it must not answer the live grid instead. ──
  {
    const profile = PROFILES[MODEL]!;
    const mock = new MockTransport('serial', 'mock-grid-slot-empty');
    mock.isOpen = true;
    mock.reply = () => [];
    const driver = createGen3Driver(profile, {
      transport: async () => mock,
      emit: () => {},
      getCadence: () => cadenceFor(profile.model, 'balanced'),
    });
    let answered: PresetGridDTO | null = null;
    const err = await driver.gridForSlot(7).then((g) => { answered = g; return null; }, (e: Error) => e);
    assert(err !== null, 'an empty slot dump rejects rather than decoding to a grid');
    assertEqual(answered, null, 'no grid is served from a dump that never arrived');
  }
}
