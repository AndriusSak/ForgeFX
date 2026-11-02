// probe-global-metronome.ts — READ-ONLY, OFFLINE (no device, no writes): replay a CAPTURED eid-1 GLOBAL
// body through the REAL driver's blockParams(1) and print what the server would serve for the metronome
// pids. Nothing is sent to a unit; the transport is a mock.
//
//   npx tsx scripts/probe-global-metronome.ts [capture.json] [--json out.json]
//
// The default capture is the committed fixture (test/fixtures/global-body/fm3-eid1-2026-10-30.json,
// 14 880 records off the unit), so this runs with no arguments and no device.
//
// `--json` writes the WHOLE served BlockParams payload, which is what the Axis UI check feeds to
// GET /global/params so the Controllers → Metronome section can be exercised without a unit.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROFILES } from '../src/devices.js';
import { createGen3Driver } from '../src/drivers/gen3.js';
import { cadenceFor } from '../src/drivers/telemetryProfiles.js';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { MockTransport } from '../test/helpers/mock.js';

const MODEL = 0x11; // FM3
const GLOBAL_EID = 1;

const compactHex = (f: readonly number[]): string => f.map((b) => b.toString(16).padStart(2, '0')).join('');
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

async function main(): Promise<number> {
  const argPath = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
  const path =
    argPath ??
    fileURLToPath(new URL('../test/fixtures/global-body/fm3-eid1-2026-10-30.json', import.meta.url));
  const cap = JSON.parse(readFileSync(path, 'utf8')) as { itemCount: number; values: number[] };
  const profile = PROFILES[MODEL]!;
  const codec = createModernFractalCodec(profile.model);
  const bulk = blockBulkFrames(GLOBAL_EID, cap.values);
  const mock = new MockTransport('serial', 'mock-global-metronome');
  mock.isOpen = true;
  mock.reply = (req) => (compactHex(req) === compactHex(codec.buildBlockBulkReadPoll(GLOBAL_EID)) ? bulk : []);
  const driver = createGen3Driver(profile, {
    transport: async () => mock,
    emit: () => {},
    getCadence: () => cadenceFor(profile.model, 'balanced')
  });
  const p = await driver.blockParams(GLOBAL_EID);
  const jsonAt = process.argv.indexOf('--json');
  if (jsonAt >= 0 && process.argv[jsonAt + 1]) {
    writeFileSync(process.argv[jsonAt + 1]!, JSON.stringify(p));
    console.log(`wrote ${process.argv[jsonAt + 1]} (${JSON.stringify(p).length} bytes)`);
  }
  console.log(`block=${p.block} slug=${p.slug} named=${p.named.length} enums=${p.enums.length}`);
  const want = new Set([119, 120, 121, 14878, 14879]);
  for (const n of p.named) if (want.has(n.id)) console.log('NAMED', JSON.stringify(n));
  for (const e of p.enums) if (want.has(e.id)) console.log('ENUM ', JSON.stringify(e));
  const served = new Set([...p.named.map((n) => n.id), ...p.enums.map((e) => e.id)]);
  for (const pid of want) if (!served.has(pid)) console.log(`MISSING pid ${pid}`);
  // layout: does the GLOBAL layout reference any of them?
  const refs = new Set<number>();
  for (const pg of p.layout?.pages ?? []) for (const row of pg.rows ?? []) for (const c of row.controls ?? []) if (c.paramId != null) refs.add(c.paramId);
  console.log('layout pages:', (p.layout?.pages ?? []).map((pg) => pg.name).join(' | '));
  for (const pid of want) console.log(`layout references ${pid}: ${refs.has(pid)}`);
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
