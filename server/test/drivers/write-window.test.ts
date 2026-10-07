// The gen-3 discrete-write confirmation WINDOW (gen3.ts #write).
//
// A 0x64 rejection (docs/write-protocol.md: "The device sends nothing on accept. On rejection it
// returns a 0x64 ... watches a short window for a 0x64 rejection") that lands AFTER the old 120 ms
// window but BEFORE the 250 ms window forgefx-midi's writer uses (writer.ts sendAndWatchForError —
// the better-evidenced number) was reported as {ok:true}: a false "accepted" that the Axis client
// trusts since P1.1, so a device-refused save/value still showed as successful.
//
// Mock replies are SYNCHRONOUS, and MockTransport.request() returns reply() verbatim — it ignores
// timeoutMs/quietMs — so the window is invisible to the existing write-rejection suite and the case
// is unreachable there. This suite drives the driver over a fake transport that REPLAYS the real
// serial transport's resolution semantics (src/transport/serial.ts #once: resolve on match, on
// quietMs silence after the last frame, or on the timeoutMs hard cap) so the window the driver
// chooses actually governs the verdict.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES } from '../../src/devices.js';
import type { Transport, RequestOpts, ConnKind } from '../../src/transport/types.js';
import { assert } from '../helpers/mock.js';

const MODEL = 0x11; // FM3

export const WRITE_WINDOW_CASE_COUNT = 5;

function sysex(fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}

/**
 * Fake transport replaying serial.ts #once exactly: the promise resolves on (a) `match`, (b) `quietMs`
 * of silence after the last inbound frame, or (c) the `timeoutMs` hard cap — never sooner. `schedule`
 * holds inbound frames to emit at a delay (ms) relative to the request, so a test can land a 0x64
 * LATE in the window. This is what MockTransport cannot express (it answers synchronously).
 */
class WindowTransport implements Transport {
  readonly label = 'serial-window';
  readonly kind: ConnKind = 'serial';
  readonly slow = false;
  isOpen = true;
  readonly sent: number[][] = [];
  /** Inbound frames to emit during the current request, at a delay relative to the send. */
  schedule: { atMs: number; frame: number[] }[] = [];
  #handlers = new Set<(f: number[]) => void>();

  async open(): Promise<void> {}
  async close(): Promise<void> {
    this.isOpen = false;
  }
  send(bytes: readonly number[]): void {
    this.sent.push([...bytes]);
    for (const h of this.#handlers) h([...bytes]);
  }
  async sendQueued(bytes: readonly number[]): Promise<void> {
    this.sent.push([...bytes]);
  }
  async sendPaced(bytes: readonly number[]): Promise<void> {
    this.sent.push([...bytes]);
  }
  request(bytes: readonly number[], opts: RequestOpts = {}): Promise<number[][]> {
    this.sent.push([...bytes]);
    const { timeoutMs = 1500, quietMs = 90, match } = opts;
    return new Promise<number[][]>((resolve) => {
      const frames: number[][] = [];
      let quiet: ReturnType<typeof setTimeout> | null = null;
      const done = () => {
        if (quiet) clearTimeout(quiet);
        clearTimeout(hard);
        this.#handlers.delete(handler);
        resolve(frames);
      };
      const handler = (f: number[]) => {
        frames.push(f);
        if (match?.(frames)) return done();
        if (quiet) clearTimeout(quiet);
        quiet = setTimeout(done, quietMs);
      };
      const hard = setTimeout(done, timeoutMs);
      this.#handlers.add(handler);
      for (const s of this.schedule) {
        setTimeout(() => {
          if (this.#handlers.has(handler)) handler([...s.frame]);
        }, s.atMs);
      }
    });
  }
  onFrame(handler: (frame: number[]) => void): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }
}

function driverOver(t: WindowTransport) {
  return createGen3Driver(PROFILES[MODEL]!, {
    transport: async () => t,
    emit: () => {},
    getCadence: () => cadenceFor(MODEL, 'balanced')
  });
}

export async function runWriteWindowTests(): Promise<void> {
  // 1. THE BUG. A genuine 0x64 (echoing our fn 0x01) lands at 180 ms — after the OLD 120 ms window
  //    would have closed, before the aligned 250 ms one. Must report {ok:false}, not accepted.
  {
    const t = new WindowTransport();
    t.schedule = [{ atMs: 180, frame: sysex(0x64, [0x01, 0x0b]) }]; // fn 0x01 (setSceneName) rejected
    const r = await driverOver(t).setSceneName!(0, 'Test Scene');
    assert(!r.ok, 'a 0x64 at 180 ms (after the old 120 ms window) must be rejected, not reported accepted');
  }

  // 2. A rejection just past the old window (130 ms) is likewise caught.
  {
    const t = new WindowTransport();
    t.schedule = [{ atMs: 130, frame: sysex(0x64, [0x01, 0x0b]) }];
    const r = await driverOver(t).setSceneName!(0, 'Test Scene');
    assert(!r.ok, 'a 0x64 at 130 ms is a rejection — ok:false');
  }

  // 3. NO false negative from the longer wait: silence ⇒ accepted.
  {
    const t = new WindowTransport();
    const r = await driverOver(t).setSceneName!(0, 'Test Scene');
    assert(r.ok, 'no 0x64 at all ⇒ accepted (the longer window does not invent a rejection)');
  }

  // 4. A late FOREIGN-function 0x64 (0x1f) still does not reject our write — the wider window widens
  //    the watch, not the attribution.
  {
    const t = new WindowTransport();
    t.schedule = [{ atMs: 180, frame: sysex(0x64, [0x1f, 0x0b]) }];
    const r = await driverOver(t).setSceneName!(0, 'Test Scene');
    assert(r.ok, 'a 0x64 echoing a different function (0x1f) is not ours — stays ok, even arriving late');
  }

  // 5. Attribution limit PINNED. The 0x64 body is only [echoedFn, resultCode] — no sub-action on the
  //    wire (write-protocol.md + parseMultipurposeResponse) — so a rejection for a DIFFERENT fn=0x01 op
  //    (setParam / setType / store / a grid op …) is indistinguishable from ours within the window.
  //    Resolved conservatively as ours ⇒ {ok:false}, which errs toward "rejected" rather than a false
  //    "accepted". Recorded so the residual is visible if the rejection wire shape ever gains a
  //    sub-action to disambiguate by.
  {
    const t = new WindowTransport();
    t.schedule = [{ atMs: 90, frame: sysex(0x64, [0x01, 0x05]) }];
    const r = await driverOver(t).setSceneName!(0, 'Test Scene');
    assert(!r.ok, 'a same-function (0x01) 0x64 is conservatively attributed to our write — ok:false');
  }
}
