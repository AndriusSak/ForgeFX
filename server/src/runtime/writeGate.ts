// The documented write-safety contract (ForgeFX/docs/write-protocol.md:37-39 is the authority; the
// Axis ROADMAP.md it used to cite is banner-stale — use the parity audit), shared by
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
  // per-preset Performance Page write (§2.2) — mutates the unit's EDIT BUFFER (transient, but a write)
  ['PUT', '/preset/perform/:slot'],
  // per-preset switch write (§3.8) — same edit-buffer target
  ['PUT', '/preset/switches/:index'],
  // user-cab IR upload writes to the unit's cab storage (§2.5) — a device write, so a read-only
  // server must refuse it rather than push frames at the unit.
  ['POST', '/cab/ir/upload'],
  ['POST', '/cab/slots/clear'],
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
  ['POST', '/device/cache/build']
];

/** True when a request targets a DEVICE-write endpoint (mutates the unit). Used by the read-only gate. */
export function isDeviceWrite(method: string, pathname: string): boolean {
  return matchesAny(DEVICE_WRITES, method, pathname);
}

/** Decode ONE path segment the way a router does before matching. A malformed escape is left as it is: it
 *  cannot match a literal segment either way, so that direction does not fail open. */
export function decodePathSegment(seg: string): string {
  if (!seg.includes('%')) return seg;
  try { return decodeURIComponent(seg); } catch { return seg; }
}

/** The pathname of a request URL, query removed. */
const pathOf = (url: string): string => url.split('?')[0] || url;

/**
 * Every spelling of the SAME request that a write gate must treat identically.
 *
 * A router DECODES before it matches (find-my-way does on the Fastify surface), so `%70erform` and
 * `perform` reach the same handler — while a gate that compares only the raw URL sees a different route and
 * waves the request through. MEASURED 2026-10-09: `PUT /preset/%70erform/1` reached the handler, so a
 * read-only server performed the write and a `?dryRun=true` PREVIEW ran live. Candidates are the raw path,
 * the per-segment-decoded path, and the matched route template (the authority on what the request is).
 */
export function gatePaths(url: string, routeTemplate?: string): string[] {
  const bare = pathOf(url);
  const out = new Set<string>([bare]);
  const decoded = bare.split('/').map(decodePathSegment).join('/');
  if (decoded !== bare) out.add(decoded);
  if (routeTemplate) out.add(routeTemplate);
  return [...out];
}

/** True when ANY spelling of this request targets a device write. Fail-closed by construction: extra
 *  spellings can only ADD matches, never remove one. */
export function isDeviceWriteRequest(method: string, url: string, routeTemplate?: string): boolean {
  return gatePaths(url, routeTemplate).some((p) => isDeviceWrite(method, p));
}

/** Device writes that CANNOT be previewed with `?dryRun=true`: their frames depend on a device READ
 *  (read-modify-write), and a capturing transport answers every read with `[]`, so there is nothing to
 *  preview. Such a request is REFUSED with 400 rather than run against the real unit — a "preview" must
 *  never fall through to a live write, and a guaranteed decode failure is not a useful answer. */
const NOT_DRY_RUNNABLE: ReadonlyArray<readonly [string, string]> = [
  ['PUT', '/preset/perform/:slot'], // dump → patch → re-send: the dump is the thing that has no preview
  ['PUT', '/preset/switches/:index'], // same shape
  // The device-cache build is a background SWEEP, not a frame write: nothing about it can be shown as a
  // preview, and `mode:'full'` puts continuous-SET frames on the wire AND reloads the current preset
  // (services/deviceCache.ts). A capture would NOT make it safe either — the sweep's own sends go through
  // the registry transport, but `reloadPreset` goes through the DRIVER's connection, which a dry run does
  // not swap. So `?dryRun=true` must REFUSE (400) rather than start a run. Found 2026-10-09 while verifying
  // the gate-contract sweep; the read-only side was already correct — this route is on DEVICE_WRITES.
  ['POST', '/device/cache/build']
];

/** The body served when `?dryRun=true` is asked of a write that cannot be previewed. Identical on both
 *  surfaces so the twins stay in parity. */
export const DRY_RUN_UNSUPPORTED_BODY = {
  error: 'dry-run-unsupported',
  message: 'this write reads the device first (read-modify-write), so it cannot be previewed; send it without ?dryRun=true'
} as const;

/** True when a device write CAN be previewed with `?dryRun=true` (a pure frame build). */
export function isDryRunnable(method: string, pathname: string): boolean {
  return isDeviceWrite(method, pathname) && !matchesAny(NOT_DRY_RUNNABLE, method, pathname);
}

/** Match `method` + `pathname` against a (method, path-template) list; ':' matches one segment. */
function matchesAny(list: ReadonlyArray<readonly [string, string]>, method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  const segs = pathname.split('?')[0]!.split('/').filter(Boolean);
  return list.some(([pm, tmpl]) => {
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

/**
 * True when the request asks for a preview. **PRESENCE IS INTENT**: only an explicit `false`/`0` means no.
 *
 * The old rule took the first value and accepted only `true`/`1`, so `?dryRun=yes`, `?dryRun=TRUE`,
 * `?dryrun=true` — all of which a human types meaning "preview" — were treated as NOT a dry run and the
 * read-modify-write ran against the real unit (measured 2026-10-09). A flag whose whole purpose is "do not
 * touch the device" must fail towards NOT touching it. A repeated key is likewise read as intent, so
 * `?dryRun=false&dryRun=true` previews rather than writes.
 */
export function isDryRunRequest(url: string): boolean {
  const qi = url.indexOf('?');
  if (qi < 0) return false;
  const values = [...new URLSearchParams(url.slice(qi + 1)).entries()]
    .filter(([k]) => k.toLowerCase() === 'dryrun')
    .map(([, v]) => v.trim().toLowerCase());
  if (!values.length) return false;
  return !values.every((v) => v === 'false' || v === '0');
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
