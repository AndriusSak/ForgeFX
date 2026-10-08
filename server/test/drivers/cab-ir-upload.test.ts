// User-cab IR upload (§2.5) — the driver path, over a fake transport that records what went out AND
// plays the device's acknowledgements back, because the upload now listens for them.
//
// The properties that matter, and why:
//   1. The frames are the editor's own stream: verbatim data frames, with ONLY the 0x7A destination
//      field written. (Measured: the export's `7F 7F` sentinel is refused by the unit; a real
//      destination is accepted.)
//   2. `ok` is ACK-BACKED, not "handed to the transport". Silence must NOT read as acceptance.
//   3. Anything not run on hardware is refused before a byte goes out: no destination, a scratchpad
//      destination (measured-refused by the unit), a rename without the explicit opt-in, a wrong-model
//      container, a preset envelope, a bad checksum.
// The wire geometry itself is golden-tested in forgefx-midi (test/gen3/fm3/cab-ir-syx.test.ts) against
// the measured FM3-Edit export; this suite only checks the driver honours it and reports honestly.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES } from '../../src/devices.js';
import type { Transport, RequestOpts, ConnKind } from '../../src/transport/types.js';
import { assert } from '../helpers/mock.js';
import { fractalChecksum } from 'forgefx-midi/shared';
import { parseCabIrSyx, cabIrUserSlot, cabIrScratchpad, computeCabIrClosePayload } from 'forgefx-midi/devices/gen3';
import { pack5Septet32 } from 'forgefx-midi/gen3/axe-fx-iii';

const MODEL = 0x11; // FM3

export const CAB_IR_UPLOAD_CASE_COUNT = 14;

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
  // A real container is SELF-CONSISTENT: its close frame carries the checksum its content requires.
  // A hardcoded close would model a container the unit DISCARDS (close-ack 0x13) and would make every
  // "only the start frame changed" assertion wrong for a reason that has nothing to do with the edit.
  out.push(...frame(model, 0x7c, computeCabIrClosePayload(out)));
  return out;
}

/**
 * Records every outgoing blob and, like the real unit, answers each frame of an IR transfer with the
 * measured ack shape (`F0 00 01 74 11 64 <fn> 00 <fn&0x0f> F7`). `silent` suppresses the acks so a test
 * can prove silence is not reported as acceptance.
 */
class AckTransport implements Transport {
  readonly label = 'serial-ack';
  readonly kind: ConnKind = 'serial';
  readonly slow = false;
  isOpen = true;
  readonly blobs: number[][] = [];
  paced = false;
  silent = false;
  /** The code the unit answers the CLOSE frame with. 0x00 = accepted, 0x13 = DISCARDED (measured). */
  closeCode = 0x00;
  #handlers = new Set<(f: number[]) => void>();

  async open(): Promise<void> {}
  async close(): Promise<void> {
    this.isOpen = false;
  }
  #emit(f: number[]): void {
    for (const h of this.#handlers) h([...f]);
  }
  /** Split a multi-frame blob and ack each frame the way the unit does. */
  #ack(blob: readonly number[]): void {
    if (this.silent) return;
    const bytes = [...blob];
    let i = 0;
    while (i < bytes.length) {
      const end = bytes.indexOf(0xf7, i);
      if (end < 0) break;
      const fn = bytes[i + 5]!;
      const code = fn === 0x7c ? this.closeCode : 0x00;
      this.#emit(frame(MODEL, 0x64, [fn, code, fn & 0x0f]));
      i = end + 1;
    }
  }
  send(bytes: readonly number[]): void {
    this.blobs.push([...bytes]);
    this.#ack(bytes);
  }
  async sendQueued(bytes: readonly number[]): Promise<void> {
    this.blobs.push([...bytes]);
    this.#ack(bytes);
  }
  async sendPaced(bytes: readonly number[]): Promise<void> {
    this.paced = true;
    this.blobs.push([...bytes]);
    this.#ack(bytes);
  }
  async request(_bytes: readonly number[], _opts?: RequestOpts): Promise<number[][]> {
    return [];
  }
  onFrame(h: (f: number[]) => void): () => void {
    this.#handlers.add(h);
    return () => this.#handlers.delete(h);
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
const DEST_USER1 = cabIrUserSlot(1);

export async function runCabIrUploadTests(): Promise<void> {
  // 1 — the editor's own stream: verbatim, with ONLY the destination field written
  {
    const t = new AckTransport();
    const d = makeDriver(t);
    const ir = synthIr();
    const r = await d.uploadCabIr(Uint8Array.from(ir), { dest: DEST_USER1 });
    assert(t.blobs.length === 1, 'exactly one paced blob goes out (not one send per frame)');
    assert(t.paced, 'the upload uses sendPaced (a flooded CDC write is dropped)');
    const sent = t.blobs[0]!;
    assert(f0Count(sent) === 10, `expected 10 frames on the wire, got ${f0Count(sent)}`);
    assert(sent.length === ir.length, 'the stream length is unchanged by writing the destination');
    const parsed = parseCabIrSyx(sent);
    assert(parsed.startPayload.join(',') === [0x00, 0x10, 0x00, 0x10].join(','), `destination field written as [index,page], got ${parsed.startPayload.join(',')}`);
    // every frame except the start frame is byte-identical to the container
    const before = parseCabIrSyx(ir);
    const changed = parsed.frames.map((f, i) => (f.join(',') === before.frames[i]!.join(',') ? null : i)).filter((x) => x !== null);
    assert(changed.join(',') === '0', `only the start frame may differ, changed: ${changed.join(',')}`);
    assert(r.dest.page === DEST_USER1.page && r.dest.index === DEST_USER1.index, 'the result names the destination');
    assert(r.frames === 10 && r.sampleSlots === 2040 && r.renamed === false, 'the result reports what was sent');
  }

  // 2 — `ok` is ACK-BACKED: the measured ack shapes must be seen and reported
  {
    const t = new AckTransport();
    const d = makeDriver(t);
    const r = await d.uploadCabIr(Uint8Array.from(synthIr()), { dest: DEST_USER1 });
    assert(r.ok === true, 'a fully acknowledged upload reports ok');
    assert(r.acks.start && r.acks.end, 'start and end acks are reported');
    assert(r.acks.data === 8 && r.acks.expectedData === 8, `all 8 data frames acknowledged, got ${r.acks.data}/${r.acks.expectedData}`);
    assert(r.acks.complete === true, 'complete is true only when every expected frame was acked');
    assert(r.acks.codes.some((c) => c.fn === 0x7a && c.code === 0x00), 'the raw [fn, code] pairs are reported');
  }

  // 3 — SILENCE is not acceptance
  {
    const t = new AckTransport();
    t.silent = true;
    const d = makeDriver(t);
    const r = await d.uploadCabIr(Uint8Array.from(synthIr()), { dest: DEST_USER1 });
    assert(t.blobs.length === 1, 'the frames were still sent');
    assert(r.ok === false, 'with no acks at all, ok MUST be false');
    assert(r.acks.complete === false && r.acks.data === 0, 'and the ack report says so');
  }

  // 4 — no destination: refused, nothing sent (the export sentinel is measured-refused by the unit)
  {
    const t = new AckTransport();
    const d = makeDriver(t);
    let msg = '';
    try {
      await d.uploadCabIr(Uint8Array.from(synthIr()));
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(/destination is required/.test(msg), `expected a destination refusal, got: ${msg || '(no throw)'}`);
    assert(t.blobs.length === 0, 'a refused upload sends NOTHING');
  }

  // 5 — scratchpad destination: refused, nothing sent (the unit refuses page 0x20)
  {
    const t = new AckTransport();
    const d = makeDriver(t);
    let msg = '';
    try {
      await d.uploadCabIr(Uint8Array.from(synthIr()), { dest: cabIrScratchpad(1) });
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(/REFUSES IR uploads to the scratchpad/.test(msg), `expected a scratchpad refusal, got: ${msg || '(no throw)'}`);
    assert(t.blobs.length === 0, 'a refused upload sends NOTHING');
  }

  // 6 — a rename is NOT gated any more: it is measured-working, and the wire carries a RECOMPUTED close
  {
    const t = new AckTransport();
    const r = await makeDriver(t).uploadCabIr(Uint8Array.from(synthIr()), { dest: DEST_USER1, name: 'RENAMED IR' });
    assert(t.blobs.length === 1, 'a rename is sent without an opt-in');
    const wire = t.blobs[0]!;
    const parsed = parseCabIrSyx(wire);
    assert(parsed.name === 'RENAMED IR', `wire name should be the rename, got ${JSON.stringify(parsed.name)}`);
    assert(r.renamed === true && r.name === 'RENAMED IR', 'the result reports the rename');
    assert(wire.length === synthIr().length, 'a rename does not change the stream length');
    // the close frame must follow the content, or the unit discards the upload (close-ack 0x13)
    assert(
      parsed.endPayload.join(',') === computeCabIrClosePayload(wire).join(','),
      'the wire close frame is the RECOMPUTED content checksum',
    );
    assert(r.ok === true && r.discarded === false, 'and the accepted arm reports accepted');
  }

  // 7b — a container left SELF-INCONSISTENT is refused before it goes out: the unit would discard it
  {
    // corrupt the close value so it no longer matches the content, keeping the frame checksum valid
    const stale = synthIr();
    const lastF0 = stale.lastIndexOf(0xf0);
    stale[lastF0 + 6] ^= 0x01;
    let sum = 0;
    for (let i = lastF0; i < stale.length - 2; i++) sum ^= stale[i]!;
    stale[stale.length - 2] = sum & 0x7f;

    const t = new AckTransport();
    const d = makeDriver(t);
    let msg = '';
    try {
      await d.uploadCabIr(Uint8Array.from(stale), { dest: DEST_USER1, recomputeClose: false });
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(/will DISCARD/.test(msg), `expected a discard refusal, got: ${msg || '(no throw)'}`);
    assert(/close-code 0x13/.test(msg), 'the refusal names the measured consequence');
    assert(t.blobs.length === 0, 'a refused container sends NOTHING');

    // ... and the opt-in sends it, so the discard can be MEASURED
    const t2 = new AckTransport();
    t2.closeCode = 0x13;
    const r = await makeDriver(t2).uploadCabIr(Uint8Array.from(stale), { dest: DEST_USER1, recomputeClose: false, allowUnverified: true });
    assert(t2.blobs.length === 1, 'the opt-in sends the inconsistent container');
    assert(r.ok === false && r.discarded === true, 'and the result reports the unit discarding it');
  }

  // 7 — a rename preserves the name slot flag bits, and only the first data frame changes
  {
    const t = new AckTransport();
    const ir = synthIr();
    await makeDriver(t).uploadCabIr(Uint8Array.from(ir), { dest: DEST_USER1, name: 'FLAGS', allowUnverified: true });
    const sent = parseCabIrSyx(t.blobs[0]!);
    const flags = sent.nameSlotFlags.map((f, i) => (f ? i : -1)).filter((i) => i >= 0);
    assert(flags.join(',') === '31', `the specimen's flag bit must survive a rename, got ${flags.join(',')}`);
    assert(
      sent.endPayload.join(',') === computeCabIrClosePayload(t.blobs[0]!).join(','),
      'the end payload follows the new content (a stale close makes the unit discard the upload)',
    );
    const before = parseCabIrSyx(ir);
    const changed = sent.frames.map((f, i) => (f.join(',') === before.frames[i]!.join(',') ? null : i)).filter((x) => x !== null);
    // the close frame (index 9) legitimately changes too — it is the checksum over the new content
    assert(changed.join(',') === '0,1,9', `only the start frame, data frame 1 and the close may change, changed: ${changed.join(',')}`);
  }

  // 8 — a wrong-model container is refused, and NOTHING is sent
  {
    const t = new AckTransport();
    const d = makeDriver(t);
    let msg = '';
    try {
      await d.uploadCabIr(Uint8Array.from(synthIr('FM9 IR', 0x12)), { dest: DEST_USER1 });
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(/model byte 0x12/.test(msg), `expected a wrong-model refusal, got: ${msg || '(no throw)'}`);
    assert(t.blobs.length === 0, 'a refused container sends NOTHING');
  }

  // 9 — a preset envelope is refused (the confusion that already happened once)
  {
    const t = new AckTransport();
    const d = makeDriver(t);
    const presetish = [...frame(MODEL, 0x77, [0x00, 0x00, 0x00, 0x00, 0x01]), ...frame(MODEL, 0x79, [0x00, 0x00, 0x00])];
    let msg = '';
    try {
      await d.uploadCabIr(Uint8Array.from(presetish), { dest: DEST_USER1 });
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(/starts with 0x7a/.test(msg), `expected a wrong-envelope refusal, got: ${msg || '(no throw)'}`);
    assert(t.blobs.length === 0, 'a refused container sends NOTHING');
  }

  // 10 — a corrupted checksum is refused, and NOTHING is sent
  {
    const t = new AckTransport();
    const d = makeDriver(t);
    const ir = synthIr();
    ir[ir.indexOf(0xf7, 0) - 1] = 0x00;
    let msg = '';
    try {
      await d.uploadCabIr(Uint8Array.from(ir), { dest: DEST_USER1 });
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(/invalid checksum/.test(msg), `expected a checksum refusal, got: ${msg || '(no throw)'}`);
    assert(t.blobs.length === 0, 'a refused container sends NOTHING');
  }

  // 12 — a 0x13 CLOSE answer means the unit DISCARDED the upload: every frame is acked, yet nothing landed
  {
    const t = new AckTransport();
    t.closeCode = 0x13;
    const r = await makeDriver(t).uploadCabIr(Uint8Array.from(synthIr()), { dest: DEST_USER1 });
    assert(t.blobs.length === 1, 'the frames still went out');
    assert(r.acks.complete === true, 'the acks themselves are complete — that is exactly the trap');
    assert(r.ok === false, 'a 0x13 close answer MUST NOT report ok, even with a complete ack set');
    assert(r.discarded === true && r.closeCode === 0x13, 'the discard is named explicitly');
    assert(/DISCARDED/.test(r.reason), `the reason must say the unit discarded it, got ${JSON.stringify(r.reason)}`);
    assert(/NOT written/.test(r.reason), 'and that the destination was not written');
  }

  // 13 — the accepted arm: a 0x00 close answer is what makes ok true, and it says so
  {
    const t = new AckTransport();
    const r = await makeDriver(t).uploadCabIr(Uint8Array.from(synthIr()), { dest: DEST_USER1 });
    assert(r.ok === true && r.discarded === false && r.closeCode === 0x00, 'the accepted arm reports accepted');
    assert(/accepted the container/.test(r.reason), `the reason must name acceptance, got ${JSON.stringify(r.reason)}`);
  }

  // 11 — a user slot destination round-trips through the same encoding the editor used
  {
    const t = new AckTransport();
    await makeDriver(t).uploadCabIr(Uint8Array.from(synthIr()), { dest: cabIrUserSlot(12) });
    const parsed = parseCabIrSyx(t.blobs[0]!);
    // the capture's second upload targeted user slot 12 as `0B 10`, i.e. index 0x0b on page 0x10
    assert(parsed.startPayload.join(',') === [0x0b, 0x10, 0x00, 0x10].join(','), `user slot 12 must encode as the capture shows, got ${parsed.startPayload.join(',')}`);
  }
}
