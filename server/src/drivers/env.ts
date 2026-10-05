/**
 * Node environment variables where a Node runtime exists.
 *
 * Axis's Browser Direct mode and the mobile build run this package in a browser: they dynamic-import
 * `forgefx-server/runtime`, whose registry constructs drivers on `detect()`. A browser has no `process`
 * global and Axis ships no shim, so an unguarded `process.env.X` read inside a driver constructor throws
 * `ReferenceError: process is not defined` — inside detect()'s try, which swallows it and reports
 * `{connected:false}`, so the device silently never appears.
 *
 * `typeof process !== 'undefined'` is safe in every runtime (unlike a bare `process.env`), which is the
 * same guard registryCore.ts uses for its `/diag` path. Note check-browser-safe.ts does NOT catch this
 * class: it fails on Node *imports*, not on runtime globals.
 *
 * Env vars read through this are all opt-OUT or debug switches, so an empty object keeps the shipped
 * defaults (e.g. the FM3 device-edit poll stays ON).
 */
export const ENV: Record<string, string | undefined> =
  typeof process !== 'undefined' && process.env ? process.env : {};
