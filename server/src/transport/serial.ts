// FM3 (gen-3 Fractal) serial transport. The device exposes a USB CDC serial
// endpoint (interface if03) that carries raw SysEx frames — the same path the
// retired C# ForgeFX used. fractal-midi builds/parses the SysEx; this layer just
// does framed serial I/O with request/response correlation.
import { SerialPort } from 'serialport';
import { existsSync, readdirSync, appendFileSync } from 'node:fs';
import type { Transport, RequestOpts } from './types.js';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const BY_ID_DIR = '/dev/serial/by-id';

export interface TransportOpts {
  /** explicit device path; otherwise auto-detected */
  path?: string;
  baudRate?: number;
}

/** Resolve the device path. An explicit FORGEFX_SERIAL wins (e.g. /dev/fm3 in Docker); otherwise
 * prefer the stable by-id Fractal if03 node (survives ttyACM renumbering), then fall back to ttyACM0. */
export function autoDetectPath(): string | null {
  const env = process.env.FORGEFX_SERIAL;
  if (env && existsSync(env)) return env;
  try {
    if (existsSync(BY_ID_DIR)) {
      const hit = readdirSync(BY_ID_DIR).find((n) => /Fractal/i.test(n) && /if03/i.test(n));
      if (hit) return `${BY_ID_DIR}/${hit}`;
    }
  } catch {
    /* fall through */
  }
  return existsSync('/dev/ttyACM0') ? '/dev/ttyACM0' : null;
}

// Fractal Audio USB vendor id (hex string as serialport reports it) — identical on every OS.
const FRACTAL_VID = '2466';
// Known product ids (hex) → model, for the ports diagnostic. Detection keys on the VID, not these,
// so an unlisted model still detects (and the fn 0x00 handshake names it precisely after connecting).
const FRACTAL_PIDS: Record<string, string> = { '8003': 'Axe-Fx II', '8010': 'Axe-Fx III', '8011': 'FM3', '8012': 'FM9' };
export interface FractalPortInfo {
  path: string;
  model?: string;
  manufacturer?: string;
  vendorId?: string;
  productId?: string;
  pnpId?: string;
  friendlyName?: string;
}
const looksFractal = (p: FractalPortInfo): boolean =>
  (p.vendorId ?? '').toLowerCase() === FRACTAL_VID ||
  /fractal/i.test(p.manufacturer ?? '') ||
  /fractal/i.test(p.pnpId ?? '') ||
  /fractal/i.test(p.friendlyName ?? '');
// gen-3 units expose several CDC interfaces; interface 3 (if03 on Linux/macOS, MI_03 on Windows)
// carries the MIDI/SysEx stream — the others are audio/control and won't answer SysEx.
const isMidiIface = (p: FractalPortInfo): boolean =>
  /if0?3\b/i.test(p.pnpId ?? '') || /MI_0?3/i.test(p.pnpId ?? '') || /if0?3\b/i.test(p.path);

export type SerialPortInfo = FractalPortInfo & { fractal: boolean };

/** Every other usbmodem callout on disk — open() retries these when the resolved node refuses. */
function altDarwinCallouts(path: string): string[] {
  if (process.platform !== 'darwin') return [];
  try {
    return readdirSync('/dev')
      .filter((n) => n.startsWith('cu.usbmodem'))
      .map((n) => `/dev/${n}`)
      .filter((p) => p !== path);
  } catch {
    return [];
  }
}

/** darwin: `SerialPort.list()` reports the DIALIN node (`/dev/tty.*` — bindings-cpp's darwin_list.cpp
 *  reads kIODialinDeviceKey), but the CALLOUT twin (`/dev/cu.*`) is the node to open: tty.* waits for
 *  DCD and can hang a CDC link. The two numbers do not always pair for a composite device — observed
 *  on an FM3 as dialin `tty.usbmodem104` vs callout `cu.usbmodem1104` — so when the exact twin is
 *  missing fall back to the single usbmodem callout on disk. With more than one, leave the path alone
 *  rather than guess at someone else's device. */
function darwinCallout(path: string, usbmodemCallouts: readonly string[]): string {
  if (process.platform !== 'darwin' || !path.startsWith('/dev/tty.')) return path;
  const twin = `/dev/cu.${path.slice('/dev/tty.'.length)}`;
  if (existsSync(twin)) return twin;
  if (usbmodemCallouts.length === 1) return `/dev/${usbmodemCallouts[0]}`;
  return path;
}

/** Every serial port on the system (for the manual picker), with Fractal nodes flagged. */
export async function listAllPorts(): Promise<SerialPortInfo[]> {
  let usbmodemCallouts: string[] = [];
  let devNodes: string[] = [];
  if (process.platform === 'darwin') {
    try {
      devNodes = readdirSync('/dev').filter((n) => n.startsWith('cu.'));
      usbmodemCallouts = devNodes.filter((n) => n.startsWith('cu.usbmodem'));
    } catch {
      /* /dev unreadable — keep the listed paths as-is */
    }
  }
  let ports: Awaited<ReturnType<typeof SerialPort.list>> = [];
  try {
    ports = await SerialPort.list();
  } catch (e) {
    // Never swallow this: an enumeration failure is why a picker can say "No ports found" while the
    // app is connected. The /dev fallback below still produces a usable list on macOS.
    console.warn(`[forgefx] SerialPort.list failed: ${(e as Error).message}`);
  }
  const out: SerialPortInfo[] = ports.map((p) => {
    const info: FractalPortInfo = { path: darwinCallout(p.path, usbmodemCallouts), model: FRACTAL_PIDS[(p.productId ?? '').toLowerCase()], manufacturer: p.manufacturer, vendorId: p.vendorId, productId: p.productId, pnpId: p.pnpId, friendlyName: (p as { friendlyName?: string }).friendlyName };
    return { ...info, fractal: looksFractal(info) };
  });
  // macOS: IOKit enumeration can omit (or fail on) a node that is already open by this process. The
  // callout nodes on disk are still openable, so add any that enumeration missed — a path-only row the
  // user can pick beats an empty dialog on a machine that is plainly talking to the unit.
  if (process.platform === 'darwin') {
    const seen = new Set(out.map((p) => p.path));
    for (const n of devNodes) {
      if (/^cu\.(Bluetooth|debug-console)/i.test(n)) continue;
      const path = `/dev/${n}`;
      if (seen.has(path)) continue;
      // NOT flagged fractal: this is a filesystem-only guess (any usbmodem could be another device),
      // and auto-detect keys on the flag — the user picks this explicitly if they need it.
      out.push({ path, friendlyName: n.replace(/^cu\./, ''), fractal: false });
    }
  }
  return out;
}
/** Just the Fractal serial nodes (USB VID 2466), Windows COM / macOS cu.usbmodem / Linux ttyACM. */
export async function listFractalPorts(): Promise<FractalPortInfo[]> {
  return (await listAllPorts()).filter((p) => p.fractal);
}

/** Resolve the device path on any OS. Explicit FORGEFX_SERIAL wins; else the Fractal USB device,
 *  preferring its MIDI interface (if03 / MI_03); else the legacy Linux by-id / ttyACM0 fallbacks. */
export async function detectPath(): Promise<string | null> {
  const env = process.env.FORGEFX_SERIAL;
  if (env && existsSync(env)) return env;
  const all = await listAllPorts();
  let fractal = all.filter((p) => p.fractal);
  // macOS lists both /dev/tty.* and /dev/cu.* for one node — keep only the callout (cu) device
  fractal = fractal.filter((p) => !(p.path.startsWith('/dev/tty.') && fractal.some((q) => q.path === p.path.replace('/dev/tty.', '/dev/cu.'))));
  if (fractal.length) {
    let pick = fractal.find(isMidiIface);
    // macOS often omits the interface tag in pnpId — when several Fractal nodes exist, prefer the
    // one whose device name ends in interface index 3 (the MIDI CDC); else just take the first.
    if (!pick && process.platform === 'darwin' && fractal.length > 1) pick = fractal.find((p) => /3$/.test(p.path));
    pick = pick ?? fractal[0];
    if (pick) return pick.path;
  }
  try {
    if (existsSync(BY_ID_DIR)) {
      const hit = readdirSync(BY_ID_DIR).find((n) => /Fractal/i.test(n) && /if03/i.test(n));
      if (hit) return `${BY_ID_DIR}/${hit}`;
    }
  } catch {
    /* */
  }
  return existsSync('/dev/ttyACM0') ? '/dev/ttyACM0' : null;
}

export class FractalSerial implements Transport {
  #port: SerialPort | null = null;
  #rx: number[] = [];
  #frameHandlers = new Set<(frame: number[]) => void>();
  readonly kind = 'serial' as const;
  readonly slow = false; // USB CDC serial is a fast link
  #path: string;
  get path(): string {
    return this.#path;
  }
  get label(): string {
    return this.#path;
  }
  /** Messages already logged by the port error handler (log each kind once, not per frame). */
  #reportedErrors = new Set<string>();

  constructor(opts: TransportOpts = {}) {
    const path = opts.path ?? autoDetectPath();
    if (!path) throw new Error('No FM3 serial port found (looked for by-id Fractal if03, then /dev/ttyACM0)');
    this.#path = path;
    this.#baud = opts.baudRate ?? 115200;
  }
  #baud: number;

  // ── capture tap (FORGEFX_TAP=1 → ./tap.log, or FORGEFX_TAP=/path) ──
  // Timestamps every RX/TX SysEx frame so we can diff FM3-Edit traffic (CPU + tuner discovery).
  #tapPath: string | null = process.env.FORGEFX_TAP ? (process.env.FORGEFX_TAP === '1' ? 'tap.log' : process.env.FORGEFX_TAP) : null;
  #logTap(dir: 'RX' | 'TX', bytes: readonly number[]) {
    if (!this.#tapPath) return;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
    try {
      appendFileSync(this.#tapPath, `${Date.now()} ${dir} ${hex}\n`);
    } catch {
      /* tap is best-effort */
    }
  }

  /** Open the resolved path; on darwin, if that node is gone or refused, try the other usbmodem callouts
   *  before giving up. USB re-enumeration renumbers the interface suffix (`cu.usbmodem104` ↔
   *  `cu.usbmodem1104`), so a path resolved a moment ago can already be stale — retrying costs one open
   *  and turns a silent "device offline" into a working link. */
  async open(): Promise<void> {
    if (this.#port?.isOpen) return;
    const candidates = [this.#path, ...altDarwinCallouts(this.#path)];
    let lastErr: Error | null = null;
    for (const path of candidates) {
      try {
        await this.#openOne(path);
        if (path !== this.#path) {
          console.warn(`[forgefx] serial: opened ${path} instead of ${this.#path} (the resolved node did not open)`);
          this.#path = path;
        }
        return;
      } catch (e) {
        lastErr = e as Error;
        // Never swallow: this single line is what tells a "Device offline" report whether the node is
        // missing, busy, or refused.
        console.error(`[forgefx] serial open failed ${path}: ${lastErr.message}`);
        this.#port = null; // a failed SerialPort never opened; drop it so isOpen() stays honest
      }
    }
    throw new Error(`could not open ${this.#path}${candidates.length > 1 ? ` (also tried ${candidates.slice(1).join(', ')})` : ''} — ${lastErr?.message ?? 'unknown error'}`);
  }

  #openOne(path: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const port = new SerialPort({ path, baudRate: this.#baud }, (err) => (err ? reject(err) : resolve()));
      port.on('data', (buf: Buffer) => this.#ingest(buf));
      // Runtime errors used to be dropped on the floor (`() => {}`); report the first of each kind once so
      // a dying link shows up in the debug log without spamming per frame.
      port.on('error', (err: Error) => {
        if (this.#reportedErrors.has(err.message)) return;
        this.#reportedErrors.add(err.message);
        console.error(`[forgefx] serial error ${path}: ${err.message}`);
      });
      this.#port = port;
    });
  }

  async close(): Promise<void> {
    const p = this.#port;
    this.#port = null;
    if (p?.isOpen) await new Promise<void>((r) => p.close(() => r()));
  }

  get isOpen() {
    return !!this.#port?.isOpen;
  }

  // ── framing ──
  #ingest(buf: Buffer) {
    for (const b of buf) {
      if (b === SYSEX_START) this.#rx = [b];
      else if (this.#rx.length) {
        this.#rx.push(b);
        if (b === SYSEX_END) {
          const frame = this.#rx;
          this.#rx = [];
          this.#logTap('RX', frame);
          for (const h of this.#frameHandlers) h(frame);
        }
      }
    }
  }

  /** Fire-and-forget send of one SysEx frame. */
  send(bytes: readonly number[]): void {
    if (!this.#port?.isOpen) throw new Error('port not open');
    this.#logTap('TX', bytes);
    this.#port.write(Buffer.from(bytes));
  }

  /** Send a large payload (e.g. a full preset dump → edit buffer) in small paced chunks. The FM3's CDC
   *  serial drops bytes if flooded — the editor bridge paces at ~64 B / 3 ms, so we match that. Serialized
   *  on the request chain so it never interleaves with a read. */
  sendPaced(bytes: readonly number[], chunk = 64, delayMs = 3): Promise<void> {
    const task = () =>
      new Promise<void>((resolve, reject) => {
        if (!this.#port?.isOpen) return reject(new Error('port not open'));
        this.#logTap('TX', bytes);
        const buf = Buffer.from(bytes);
        let off = 0;
        const pump = () => {
          if (off >= buf.length) { setTimeout(resolve, 20); return; } // settle before the next request
          this.#port!.write(buf.subarray(off, off + chunk));
          off += chunk;
          setTimeout(pump, delayMs);
        };
        pump();
      });
    const p = this.#chain.then(task, task);
    this.#chain = p.then(() => {}, () => {});
    return p;
  }

  // serial is a single shared stream — requests MUST run one at a time, or reply
  // frames from concurrent requests interleave and corrupt each other.
  #chain: Promise<unknown> = Promise.resolve();

  /**
   * Send a request and collect reply frames. Serialized against all other requests.
   * Resolves once a quiet gap (`quietMs`) passes after the last frame, or `match` is
   * satisfied, or `timeoutMs` elapses. Handles single-frame replies and multi-frame dumps.
   */
  request(bytes: readonly number[], opts: RequestOpts = {}): Promise<number[][]> {
    const task = () => this.#once(bytes, opts);
    const p = this.#chain.then(task, task);
    this.#chain = p.then(
      () => {},
      () => {}
    );
    return p;
  }

  /**
   * Fire-and-forget write, but SERIALIZED on the request chain so it never injects
   * bytes mid-read (which would corrupt a concurrent dump/bulk-read). Resolves after
   * a short settle so any echo is drained before the next request collects.
   */
  sendQueued(bytes: readonly number[], settleMs = 20): Promise<void> {
    const task = () =>
      new Promise<void>((resolve) => {
        this.send(bytes);
        setTimeout(resolve, settleMs);
      });
    const p = this.#chain.then(task, task);
    this.#chain = p.then(
      () => {},
      () => {}
    );
    return p;
  }

  #once(bytes: readonly number[], { timeoutMs = 1500, quietMs = 90, match }: RequestOpts = {}): Promise<number[][]> {
    this.#rx = []; // drop any stale partial frame before a fresh exchange
    return new Promise((resolve) => {
      const frames: number[][] = [];
      let quietTimer: ReturnType<typeof setTimeout> | null = null;
      const done = () => {
        if (quietTimer) clearTimeout(quietTimer);
        clearTimeout(hardTimer);
        this.#frameHandlers.delete(handler);
        resolve(frames);
      };
      const handler = (frame: number[]) => {
        frames.push(frame);
        if (match?.(frames)) return done();
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(done, quietMs);
      };
      const hardTimer = setTimeout(done, timeoutMs);
      this.#frameHandlers.add(handler);
      this.send(bytes);
    });
  }

  onFrame(handler: (frame: number[]) => void): () => void {
    this.#frameHandlers.add(handler);
    return () => this.#frameHandlers.delete(handler);
  }
}
