// User-cab IR upload (§2.5) — the driver path, over a fake transport that records what went out.
//
// What this suite is FOR: pinning the two properties that make the upload honest.
//   1. The default path REPLAYS the container's bytes verbatim. The sample payload is not decoded
//      and the 0x7C value is never recomputed, so any "helpful" transformation here would be an
//      invention — the assertion is byte equality with the input, not "a plausible frame sequence".
//   2. Anything the codec does not fully understand is REFUSED before a single byte is sent: a
//      wrong-model container, a preset envelope (the exact confusion that already happened once), a
//      bad checksum. A refusal that still pushed frames at the unit would be the failure mode.
// The wire geometry itself is golden-tested in forgefx-midi (test/gen3/fm3/cab-ir-syx.test.ts) against
// the measured FM3-Edit export; this suite only checks the driver honours it.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES } from '../../src/devices.js';
import type { Transport, RequestOpts, ConnKind } from '../../src/transport/types.js';
import { assert } from '../helpers/mock.js';
import { fractalChecksum } from 'forgefx-midi/shared';
import { parseCabIrSyx } from 'forgefx-midi/devices/gen3';
import { pack5Septet32 } from 'forgefx-midi/gen3/axe-fx-iii';

const MODEL = 0x11; // FM3

export const CAB_IR_UPLOAD_CASE_COUNT = 9;

function frame(model: number, fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, model, fn, ...payload];
  return [...body, fractalChecksum(body), 0xf7];
}

/** A container with the MEASURED geometry (8 data frames × 256 chunks; 8 name chunks + 2040 samples). */
function synthIr(name = 'LT TV Mix 7', model = MODEL): number[] {
  const chars = [...name.padEnd(32, ' ')].map((c) => c.charCodeAt(0) & 0x7f);
  chars[31] |= 0x80; // the specimen's flag bit on the last name slot
  const chunks: number[] = [];
  for (let c = 0; c < 8; c++) {
    const w = ((chars[c * 4]!) | (chars[c * 4 + 1]! << 8) | (chars[c * 4 + 2]! << 16) | (chars[c * 4 + 3]! << 24)) >>> 0;
    chunks.push(...pack5Septet32(w));
  }
  for (let i = 0; i < 2040; i++) chunks.push(...pack5Septet32((i * 2654435761) >>> 0));
  const out = [...frame(model, 0x7a, [0x7f, 0x7f, 0x00, 0x10])];
  for (let f = 0; f < 8; f++) out.push(...frame(model, 0x7b, [0x00, 0x02, ...chunks.slice(f * 256 * 5, (f + 1) * 256 * 5)]));
  out.push(...frame(model, 0x7c, [0x4d, 0x12, 0x08, 0x5d, 0x03]));
  return out;
}

/** Records every outgoing blob; `paced` says whether sendPaced (not sendQueued) was used. */
class RecorderTransport implements Transport {
  readonly label = 'serial-recorder';
  readonly kind: ConnKind = 'serial';
  readonly slow = false;
  isOpen = true;
  readonly blobs: number[][] = [];
  paced = false;
  async open(): Promise<void> {}
  async close(): Promise<void> {
    this.isOpen = false;
  }
  send(bytes: readonly number[]): void {
    this.blobs.push([...bytes]);
  }
  async sendQueued(bytes: readonly number[]): Promise<void> {
    this.blobs.push([...bytes]);
  }
  async sendPaced(bytes: readonly number[]): Promise<void> {
    this.paced = true;
    this.blobs.push([...bytes]);
  }
  async request(_bytes: readonly number[], _opts?: RequestOpts): Promise<number[][]> {
    return [];
  }
  onFrame(): () => void {
    return () => {};
  }
}

function makeDriver(t: Transport) {
  return createGen3Driver(PROFILES[MODEL]!, {
    transport: async () => t,
    emit: () => {},
    getCadence: () => cadenceFor(MODEL, 'balanced'),
  });
}

const f0Count = (bytes: readonly number[]) => bytes.filter((b) => b === 0xf0).length;

export async function runCabIrUploadTests(): Promise<void> {
  // 1 — the default path is a VERBATIM replay
  {
    const t = new RecorderTransport();
    const d = makeDriver(t);
    const ir = synthIr();
    const r = await d.uploadCabIr(Uint8Array.from(ir), { allowUnverified: true });
    assert(t.blobs.length === 1, 'exactly one paced blob goes out (not one send per frame)');
    assert(t.paced, 'the upload uses sendPaced (a flooded CDC write is dropped)');
    assert(t.blobs[0]!.join(',') === ir.join(','), 'the bytes on the wire are byte-identical to the container');
    assert(f0Count(t.blobs[0]!) === 10, `expected 10 frames on the wire, got ${f0Count(t.blobs[0]!)}`);
    assert(r.frames === 10 && r.bytes === ir.length, 'the result reports the stream it sent');
    assert(r.sampleSlots === 2040, `expected 2040 sample slots, got ${r.sampleSlots}`);
    assert(r.renamed === false, 'a verbatim replay is not reported as a rename');
    assert(r.name === 'LT TV Mix 7', `name from the container, got ${JSON.stringify(r.name)}`);
  }

  // 2 — a rename rewrites the name slots and nothing else
  {
    const t = new RecorderTransport();
    const d = makeDriver(t);
    const ir = synthIr();
    const r = await d.uploadCabIr(Uint8Array.from(ir), { name: 'RENAMED IR', allowUnverified: true });
    const sent = t.blobs[0]!;
    const parsed = parseCabIrSyx(sent);
    assert(parsed.name === 'RENAMED IR', `wire name should be the rename, got ${JSON.stringify(parsed.name)}`);
    assert(r.renamed === true && r.name === 'RENAMED IR', 'the result reports the rename');
    assert(sent.length === ir.length, 'a rename does not change the stream length');
    // the 0x7C value is carried verbatim (its coverage is unverified — never recomputed)
    assert(parsed.endPayload.join(',') === [0x4d, 0x12, 0x08, 0x5d, 0x03].join(','), 'the end payload stays verbatim');
    // every frame but the first data frame is untouched
    const before = parseCabIrSyx(ir);
    const changed = parsed.frames.map((f, i) => (f.join(',') === before.frames[i]!.join(',') ? null : i)).filter((x) => x !== null);
    assert(changed.join(',') === '1', `only data frame 1 may change, changed: ${changed.join(',')}`);
  }

  // 3 — a wrong-model container is refused, and NOTHING is sent
  {
    const t = new RecorderTransport();
    const d = makeDriver(t);
    let msg = '';
    try {
      await d.uploadCabIr(Uint8Array.from(synthIr('FM9 IR', 0x12)), { allowUnverified: true });
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(/model byte 0x12/.test(msg), `expected a wrong-model refusal, got: ${msg || '(no throw)'}`);
    assert(t.blobs.length === 0, 'a refused container sends NOTHING');
  }

  // 4 — a preset envelope is refused (the confusion that already happened once)
  {
    const t = new RecorderTransport();
    const d = makeDriver(t);
    const presetish = [...frame(MODEL, 0x77, [0x00, 0x00, 0x00, 0x00, 0x01]), ...frame(MODEL, 0x79, [0x00, 0x00, 0x00])];
    let msg = '';
    try {
      await d.uploadCabIr(Uint8Array.from(presetish), { allowUnverified: true });
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(/starts with 0x7a/.test(msg), `expected a wrong-envelope refusal, got: ${msg || '(no throw)'}`);
    assert(t.blobs.length === 0, 'a refused container sends NOTHING');
  }

  // 5 — a corrupted checksum is refused, and NOTHING is sent
  {
    const t = new RecorderTransport();
    const d = makeDriver(t);
    const ir = synthIr();
    ir[ir.indexOf(0xf7, 0) - 1] = 0x00;
    let msg = '';
    try {
      await d.uploadCabIr(Uint8Array.from(ir), { allowUnverified: true });
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(/invalid checksum/.test(msg), `expected a checksum refusal, got: ${msg || '(no throw)'}`);
    assert(t.blobs.length === 0, 'a refused container sends NOTHING');
  }

  // 6 — the retarget EXPERIMENT patches the start frame and says so in the result
  {
    const t = new RecorderTransport();
    const d = makeDriver(t);
    const r = await d.uploadCabIr(Uint8Array.from(synthIr()), { target: 1, targetOrder: 'msb', allowUnverified: true });
    const parsed = parseCabIrSyx(t.blobs[0]!);
    assert(parsed.startPayload.join(',') === [0x00, 0x01, 0x00, 0x10].join(','), `msb target encoding, got ${parsed.startPayload.join(',')}`);
    assert(r.retargeted?.target === 1 && r.retargeted?.order === 'msb', 'the result discloses the retarget');
    const t2 = new RecorderTransport();
    await makeDriver(t2).uploadCabIr(Uint8Array.from(synthIr()), { target: 1, targetOrder: 'lsb', allowUnverified: true });
    assert(parseCabIrSyx(t2.blobs[0]!).startPayload.join(',') === [0x01, 0x00, 0x00, 0x10].join(','), 'lsb target encoding');
  }

  // 7 — an out-of-range target is refused before any byte goes out
  {
    const t = new RecorderTransport();
    const d = makeDriver(t);
    let msg = '';
    try {
      await d.uploadCabIr(Uint8Array.from(synthIr()), { target: 0x4000, allowUnverified: true });
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(/14-bit range/.test(msg), `expected a range refusal, got: ${msg || '(no throw)'}`);
    assert(t.blobs.length === 0, 'a refused target sends NOTHING');
  }

  // 8 — an over-long rename is refused before any byte goes out
  {
    const t = new RecorderTransport();
    const d = makeDriver(t);
    let msg = '';
    try {
      await d.uploadCabIr(Uint8Array.from(synthIr()), { name: 'X'.repeat(33), allowUnverified: true });
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(/33 characters/.test(msg), `expected a length refusal, got: ${msg || '(no throw)'}`);
    assert(t.blobs.length === 0, 'a refused rename sends NOTHING');
  }

  // 9 — FAIL CLOSED: without the explicit opt-in, nothing is sent at all.
  // This is the load test's result turned into a guard. Replaying a real FM3-Edit export on fw 13 drew a
  // 0x64 refusal on EVERY frame (fn=0x7A → result 0x16, fn=0x7B → result 0x10 bad message length), so
  // the container is not accepted as-is. The default must therefore refuse — a caller that does not know
  // that would otherwise push refused frames at a unit and read `{ok:true}` as success.
  {
    const t = new RecorderTransport();
    const d = makeDriver(t);
    let msg = '';
    try {
      await d.uploadCabIr(Uint8Array.from(synthIr()));
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(/measured-REFUSED/.test(msg), `expected the fail-closed refusal, got: ${msg || '(no throw)'}`);
    assert(/0x10 bad message length/.test(msg), 'the refusal must carry the MEASURED reason, not a vague one');
    assert(/capture of FM3-Edit/.test(msg), 'the refusal must name what closing it requires');
    assert(t.blobs.length === 0, 'the fail-closed path sends NOTHING');
  }
}
