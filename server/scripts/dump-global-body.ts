// dump-global-body.ts — READ-ONLY: write the whole eid-1 (GLOBAL) fn-0x1F body to a JSON file so it can be
// analysed offline (the Perform-page search). Sends only the bulk READ poll; writes nothing to the unit.
//
//   npx tsx scripts/dump-global-body.ts [--out /tmp/global-body.json] [--port /dev/ttyACM0]
import { writeFileSync } from 'node:fs';
import { openProbeSession } from './probe-device.js';

const GLOBAL_EID = 1;

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
}

async function main(): Promise<number> {
  const out = arg('--out', '/tmp/global-body.json');
  const port = arg('--port', '');
  const opened = await openProbeSession(0x11, port || undefined);
  if (!opened.ok) {
    console.error(`no device: ${opened.failure.cls} — ${opened.failure.detail}`);
    return 3;
  }
  const s = opened.session;
  try {
    const frames = await s.transport.request(s.codec.buildBlockBulkReadPoll(GLOBAL_EID), {
      timeoutMs: 2500,
      quietMs: 120,
      match: (fs) => fs.some((f) => f[5] === 0x76)
    });
    const bulk = s.codec.assembleGen3BlockBulkRead(frames);
    writeFileSync(out, JSON.stringify({ itemCount: bulk.itemCount, values: Array.from(bulk.values) }));
    console.log(`wrote ${out}: ${bulk.values.length} records (advertised ${bulk.itemCount})`);
    return 0;
  } finally {
    await s.close?.();
  }
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
