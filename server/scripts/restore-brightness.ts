// restore-brightness.ts — put GLOBAL_FS_BRIGHTNESS back, using the path PROVEN to work.
//
//   npx tsx scripts/restore-brightness.ts             # plan only
//   npx tsx scripts/restore-brightness.ts --go        # restore to 70% (display units)
//   npx tsx scripts/restore-brightness.ts --go --pct 60
//
// WHY THIS EXISTS. The continuous write path is the one under change (P14: norm -> display units), so it
// cannot be trusted to restore a value while that change is in question. The DISCRETE path is independent:
// measured 2026-10-08, `setParam(eid 1, pid 7115, 70)` (continuous=false) set the panel to 70% and the body
// to raw 45874. This script uses only that path, so it works no matter which way the continuous path is
// behaving. It verifies through the fn-0x1F bulk body (an independent read), never through the GET.
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';

const EID = 1;
const PID = 7115;
const RAW_MAX = 65534;

async function body(s: Awaited<ReturnType<typeof openProbeSession>> extends { ok: true; session: infer T } ? T : never): Promise<number | undefined> {
  const frames = await s.transport.request(s.codec.buildBlockBulkReadPoll(EID), {
    timeoutMs: 2500,
    quietMs: 120,
    match: (fs) => fs.some((f) => f[5] === 0x76)
  });
  return s.codec.assembleGen3BlockBulkRead(frames).values[PID];
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const go = argv.includes('--go');
  const i = argv.indexOf('--pct');
  const pct = i >= 0 ? Number(argv[i + 1]) : 70;
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    console.error('--pct must be 0..100');
    return 2;
  }
  const opened = await openProbeSession(0x11);
  if (!opened.ok) {
    console.error(`no device: ${opened.failure.cls} — ${opened.failure.detail}`);
    return 3;
  }
  const s = opened.session;
  try {
    const before = await body(s);
    console.log(`current: raw ${before} (${before === undefined ? '?' : ((before / RAW_MAX) * 100).toFixed(1)}%)`);
    console.log(`plan   : write ${pct} display units via the DISCRETE path (continuous=false) -> expect raw ~${Math.round((pct / 100) * RAW_MAX)}`);
    if (!go) {
      console.log('plan only — nothing written');
      return 4;
    }
    await s.driver.setParam?.(EID, PID, pct, false);
    await new Promise((r) => setTimeout(r, 500));
    const after = await body(s);
    const ok = after !== undefined && Math.abs(after - Math.round((pct / 100) * RAW_MAX)) <= Math.max(200, RAW_MAX * 0.02);
    console.log(`after  : raw ${after} (${after === undefined ? '?' : ((after / RAW_MAX) * 100).toFixed(1)}%)  ${ok ? 'RESTORED' : 'NOT restored — set it by hand'}`);
    return ok ? 0 : 2;
  } finally {
    try { await s.close(); } catch { /* best effort */ }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((rc) => process.exit(rc)).catch((e) => { console.error(`restore failed: ${(e as Error)?.message ?? String(e)}`); process.exit(1); });
}
