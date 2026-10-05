// The documented write-safety contract (ForgeFX/docs/write-protocol.md:37-39 + ROADMAP.md), shared by
// BOTH HTTP surfaces (the Node Fastify app in app.ts and the browser-facing runtime router in
// runtime/router.ts) so they stay in parity:
//
//   • `?dryRun=true` on a write endpoint returns the exact frame hex WITHOUT sending.
//   • `--writes false` starts the server read-only; every DEVICE-write endpoint then returns 403.
//
// "Device write" is an EXPLICIT allowlist of routes that mutate the unit (send frames / change the
// edit buffer or a stored slot) — deliberately NOT "any non-GET". Read-shaped POSTs (decode, convert,
// backup dump, firmware validate, tuner/meters/looper reads) and LOCAL writes (the Axis config store,
// the /local/* folder) stay available on a read-only server, because they never touch the device.
// Keeping the list explicit means a new read endpoint is never accidentally gated and a new write
// endpoint is added in exactly one place. NO node:/fastify imports — this module must bundle for the
// browser router.
import type { Transport } from '../transport/types.js';

/** Lowercase 2-digit space-separated SysEx frame — the `frames` hex the dry-run response carries. */
export function frameHex(bytes: readonly number[]): string {
  return bytes.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join(' ');
}

// method + path template. A segment starting with ':' matches exactly one path segment.
const DEVICE_WRITES: ReadonlyArray<readonly [string, string]> = [
  // unified block/param writes
  ['PUT', '/preset/blocks/:eid/params/:paramId'],
  ['POST', '/preset/blocks/:eid/bypass'],
  ['POST', '/preset/blocks/:eid/channel'],
  ['POST', '/preset/blocks/:eid/type'],
  // grid editing
  ['PUT', '/preset/grid/cell'],
  ['POST', '/preset/grid/cable'],
  ['POST', '/preset/grid/select'],
  // preset / scene / tempo / modifier writes
  ['POST', '/preset/select'],
  ['POST', '/preset/store'],
  ['POST', '/preset/name'],
  ['POST', '/preset/load'],
  ['POST', '/preset/restore'],
  ['POST', '/scene'],
  ['POST', '/scene/name'],
  ['POST', '/tempo'],
  ['POST', '/tempo/tap'],
  ['POST', '/mod/bind'],
  ['POST', '/preset/looper/control'],
  ['PUT', '/device/param'],
  // version control loads a stored dump into the edit buffer / restores a slot (device writes)
  ['POST', '/version/:id/load'],
  ['POST', '/version/:id/restore'],
  // device-cache build (mode:'full' writes a taper sweep to the unit — gate the whole op in read-only)
  ['POST', '/device/cache/build'],
  // deprecated /am4/* aliases (app surface only; the router has none → they 404 there)
  ['PUT', '/am4/blocks/:pidLow/params/:pidHigh'],
  ['PUT', '/am4/param'],
  ['POST', '/am4/bypass'],
  ['POST', '/am4/scene'],
  ['POST', '/am4/preset'],
  ['POST', '/am4/preset/store'],
  ['POST', '/am4/preset/restore']
];

/** True when a request targets a DEVICE-write endpoint (mutates the unit). Used by the read-only gate. */
export function isDeviceWrite(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  const segs = pathname.split('?')[0]!.split('/').filter(Boolean);
  return DEVICE_WRITES.some(([pm, tmpl]) => {
    if (pm !== m) return false;
    const parts = tmpl.split('/').filter(Boolean);
    if (parts.length !== segs.length) return false;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      if (!p.startsWith(':') && p !== segs[i]) return false;
    }
    return true;
  });
}

/** True when the request carries the documented `?dryRun=true` (or `?dryRun=1`) preview flag. */
export function isDryRunRequest(url: string): boolean {
  const qi = url.indexOf('?');
  if (qi < 0) return false;
  const v = new URLSearchParams(url.slice(qi + 1)).get('dryRun');
  return v === 'true' || v === '1';
}

/** The 403 body served on a read-only server — identical on both surfaces (router parity). */
export const READ_ONLY_BODY = { error: 'read-only', message: 'writes disabled (--writes false)' } as const;

/**
 * A transport that RECORDS every outgoing frame and sends nothing — the dry-run capture. Reads
 * (`request`) resolve to `[]` immediately (no device, no wait), so a preview of a `#write` is instant.
 */
export function captureTransport(frames: number[][]): Transport {
  const record = (bytes: readonly number[]) => { frames.push([...bytes]); };
  return {
    label: 'dry-run',
    kind: 'serial',
    slow: false,
    isOpen: true,
    open: async () => {},
    close: async () => {},
    send: record,
    sendQueued: async (bytes: readonly number[]) => record(bytes),
    sendPaced: async (bytes: readonly number[]) => record(bytes),
    request: async (bytes: readonly number[]) => { record(bytes); return []; },
    onFrame: () => () => {}
  };
}
