// W3.1 — the documented write-safety contract (docs/write-protocol.md:37-39 is the authority; the
// Axis ROADMAP.md these files once cited is banner-stale — use the parity audit):
//   • `?dryRun=true` on any write endpoint returns the exact frame hex WITHOUT sending.
//   • `--writes false` starts the server read-only; every device-write endpoint returns 403.
// Route-level (app.inject) over a REAL gen-3 FM3 driver on a MockTransport:
//   - the dry-run hex is compared byte-for-byte to what the SAME request sends when NOT a dry run,
//   - `mock.sent` proves a dry run put nothing on the wire,
//   - a request the driver rejects is still rejected under a dry run (validation runs; no frame),
//   - the read-only gate 403s device writes, sends nothing, and leaves reads + the local config store
//     (not a device write) working.
import { buildTestApp } from '../helpers/api.js';
import { assert, assertEqual, hex } from '../helpers/mock.js';
import { createRouter } from '../../src/runtime/router.js';
import * as store from '../../src/store.js';

export const WRITE_SAFETY_CASE_COUNT = 12;

export async function runWriteSafetyTests(): Promise<void> {
  // ── ?dryRun=true returns the exact frame hex and sends nothing ─────────────
  {
    const { app, mock } = await buildTestApp(0x11); // REAL FM3 gen-3 driver over MockTransport
    // what the same setParam actually sends (continuous frame) when it is NOT a dry run
    const beforeLive = mock.sent.length;
    const live = await app.inject({ method: 'PUT', url: '/preset/blocks/58/params/7', payload: { value: 0.5, continuous: true } });
    assertEqual(live.statusCode, 200, 'live setParam → 200');
    assertEqual(mock.sent.length, beforeLive + 1, 'live setParam sent exactly one frame');
    const liveFrame = mock.sent[mock.sent.length - 1]!;

    const sentAfterLive = mock.sent.length;
    const dry = await app.inject({ method: 'PUT', url: '/preset/blocks/58/params/7?dryRun=true', payload: { value: 0.5, continuous: true } });
    assertEqual(dry.statusCode, 200, 'dryRun setParam → 200');
    const body = dry.json() as { dryRun?: boolean; frames?: string[]; ok?: boolean };
    assertEqual(body.dryRun, true, 'dryRun response is flagged dryRun:true');
    assert(Array.isArray(body.frames) && body.frames.length === 1, `dryRun returns one frame (got ${JSON.stringify(body.frames)})`);
    assertEqual(body.frames![0], hex(liveFrame), 'dry-run hex is byte-identical to the live frame');
    assertEqual(mock.sent.length, sentAfterLive, 'dry run SENT NOTHING (mock.sent unchanged)');
    await app.close();
  }

  // ── a dry run still validates: a request the driver rejects stays rejected ──
  {
    const { app, mock } = await buildTestApp(0x11);
    const before = mock.sent.length;
    const dry = await app.inject({ method: 'POST', url: '/scene?dryRun=true', payload: { index: 9 } });
    assertEqual(dry.statusCode, 200, 'dryRun scene → 200');
    const body = dry.json() as { ok?: boolean; frames?: string[] };
    assertEqual(body.ok, false, 'dry run still validates: out-of-range scene → ok:false');
    assertEqual((body.frames ?? []).length, 0, 'a rejected dry run captured no frame');
    assertEqual(mock.sent.length, before, 'a rejected dry run sent nothing');
    await app.close();
  }

  // ── --writes false: device writes 403, nothing sent, reads/local store intact ──
  {
    const { app, mock } = await buildTestApp(0x11, undefined, { writes: false });
    const before = mock.sent.length;
    const writes: { name: string; method: string; url: string; payload: Record<string, unknown> }[] = [
      { name: 'bypass', method: 'POST', url: '/preset/blocks/58/bypass', payload: { bypassed: true } },
      { name: 'param', method: 'PUT', url: '/preset/blocks/58/params/7', payload: { value: 0.5, continuous: true } },
      { name: 'scene', method: 'POST', url: '/scene', payload: { index: 2 } },
      { name: 'grid cell', method: 'PUT', url: '/preset/grid/cell', payload: { row: 1, col: 1, blockId: 1 } },
      { name: 'preset select', method: 'POST', url: '/preset/select', payload: { number: 3 } },
      { name: 'preset store', method: 'POST', url: '/preset/store', payload: { number: 3 } }
    ];
    for (const w of writes) {
      const res = await app.inject({ method: w.method as 'POST', url: w.url, payload: w.payload });
      assertEqual(res.statusCode, 403, `read-only ${w.name} → 403`);
    }
    assertEqual(mock.sent.length, before, 'read-only mode sent nothing to the device');

    const info = await app.inject({ method: 'GET', url: '/device' });
    assertEqual(info.statusCode, 200, 'read-only still serves GET /device (reads are not gated)');

    const cfg = await app.inject({ method: 'PUT', url: '/store/config/write-safety', payload: { data: { x: 1 } } });
    assertEqual(cfg.statusCode, 200, 'read-only leaves the local config store writable (not a device write)');
    await app.close();
  }

  // ── app ↔ runtime-router parity for both gates (the twins must answer identically) ──
  {
    const { app, registry } = await buildTestApp(0x11);
    const router = createRouter({ registry, store: store.defaultStore });

    const appDry = await app.inject({ method: 'PUT', url: '/preset/blocks/58/params/7?dryRun=true', payload: { value: 0.5, continuous: true } });
    const rtrDry = await router.handle('PUT', '/preset/blocks/58/params/7?dryRun=true', JSON.stringify({ value: 0.5, continuous: true }));
    assertEqual(rtrDry.status, appDry.statusCode, 'dry-run status parity');
    assertEqual(
      (JSON.parse(rtrDry.body as string) as { frames: string[] }).frames[0],
      (appDry.json() as { frames: string[] }).frames[0],
      'dry-run frame hex parity (app ↔ router)'
    );

    const ro = createRouter({ registry, store: store.defaultStore, writes: false });
    const roRtr = await ro.handle('POST', '/preset/blocks/58/bypass', JSON.stringify({ bypassed: true }));
    assertEqual(roRtr.status, 403, 'read-only router gates a device write');
    const roApp403 = await (await buildTestApp(0x11, undefined, { writes: false })).app.inject({ method: 'POST', url: '/preset/blocks/58/bypass', payload: { bypassed: true } });
    assertEqual(roApp403.statusCode, roRtr.status, 'read-only 403 parity (app ↔ router)');
    assertEqual(roApp403.payload, roRtr.body, 'read-only 403 body parity (app ↔ router)');
    await app.close();
  }
}
