// Browser-runtime safety of the DRIVER constructors.
//
// Axis's Browser Direct mode and the mobile build dynamic-import `forgefx-server/runtime`, whose
// registry creates drivers on detect() (registryCore.ts: `0x11: () => createGen3Driver(...)`). There is
// no `process` global in a browser and Axis ships no shim, so any unguarded `process.env` read inside a
// driver constructor throws `ReferenceError: process is not defined` — inside detect()'s try, which
// swallows it and reports `{connected:false}`. The device then simply never appears.
//
// registryCore.ts guards itself (`const proc = typeof process !== 'undefined' ? process : null`); the
// drivers must do the same. check-browser-safe.ts cannot catch this: it fails on Node *imports*, not on
// runtime globals, so the gate stays green while the browser runtime is broken.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { createAm4Driver } from '../../src/drivers/am4.js';
import { PROFILES } from '../../src/devices.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import type { DeviceDriver } from '../../src/drivers/types.js';
import { assert, assertEqual } from '../helpers/mock.js';

export const BROWSER_GLOBALS_CASE_COUNT = 4;

const noTransport = async () => { throw new Error('no transport in this test'); };

function ctx(model: number) {
  return { transport: noTransport, emit: () => {}, getCadence: () => cadenceFor(model, 'balanced') };
}

/** Run `fn` with the Node `process` global absent, as in a browser runtime. */
function withoutProcess<T>(fn: () => T): T {
  const g = globalThis as { process?: unknown };
  const saved = g.process;
  delete g.process;
  try {
    return fn();
  } finally {
    g.process = saved;
  }
}

export function runBrowserGlobalsTests(): void {
  // 1-3. Every gen-3 driver builds with no Node globals (FM3 / FM9 / Axe-Fx III).
  for (const [model, name] of [[0x11, 'FM3'], [0x12, 'FM9'], [0x10, 'Axe-Fx III']] as const) {
    const driver = withoutProcess(() => createGen3Driver(PROFILES[model]!, ctx(model) as never)) as DeviceDriver;
    assert(!!driver?.capabilities, `${name} driver constructs without a Node process global`);
    assertEqual(driver.modelId, model, `${name} driver reports its model id`);
  }

  // 4. The AM4 driver builds too, and the FM3's poll-based edit reflection is still on by default
  //    (the env var is an opt-OUT: `FORGEFX_FM3_EDITSYNC=0` disables it, absence must keep it enabled).
  withoutProcess(() => createAm4Driver(ctx(0x15) as never));
  const fm3 = withoutProcess(() => createGen3Driver(PROFILES[0x11]!, ctx(0x11) as never)) as DeviceDriver;
  assertEqual(fm3.capabilities.deviceEditWatch, true, 'FM3 device-edit watch defaults ON without any env');
  assertEqual(fm3.capabilities.deviceEditPush, false, 'FM3 does not advertise edit-push');
}
