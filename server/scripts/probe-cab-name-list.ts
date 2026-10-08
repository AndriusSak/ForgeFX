// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-cab-name-list — READ-ONLY: read the device's OWN cab-bank name lists, including USER banks.
//
// WHY (the answer to "why does Axis show no name for a user IR when FM3-Edit does"):
//   • `profile.cabIrs()` — the offline cache — is built from the FACTORY 1/2 + LEGACY records ONLY;
//     `CAB_BANK_IDS` deliberately excludes `0xfff3+`, which is where the USER and SCRATCHPAD banks
//     live (they are the donor unit's own IR library, not shippable firmware content).
//   • the live path, `Gen3Driver#liveCabIrs()`, is an unimplemented STUB returning `{}`.
//   So a user-slot IR has NO name source in Axis at all, while FM3-Edit shows one.
//
// The device's self-describe mechanism can supply it: the cab-bank records are enum records in the
// CABINET section (`0xfff0` FACTORY 1, `0xfff1` FACTORY 2, `0xfff2` LEGACY, `0xfff3+` USER /
// SCRATCHPAD), and an enum's labels are read with view `0x1f` at sub = raw value (min..max). This
// probe reads the DEFINITION, then walks the label list — with FACTORY 1 as the CONTROL, so a
// failure is attributable to the USER read rather than to the mechanism.
//
// NOTHING IS WRITTEN: definition + enum-label reads only.
//
// USAGE
//   npx tsx scripts/probe-cab-name-list.ts                     # control FACTORY 1 (first 12) + USER (first 24)
//   npx tsx scripts/probe-cab-name-list.ts --user-all          # walk the whole user bank
//   npx tsx scripts/probe-cab-name-list.ts --param 0xfff0 --max 40
//   npx tsx scripts/probe-cab-name-list.ts --block 11 --port /dev/ttyACM0
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { buildDefQuery, buildEnumQuery, decodeReply } from 'forgefx-midi/cache';

/** CABINET section address (HW_SEEDS.CABINET). */
const DEFAULT_BLOCK = 11;
/** Special cab-bank table records: 0xfff0/1 FACTORY 1/2, 0xfff2 LEGACY, 0xfff3+ USER/SCRATCHPAD. */
const PARAM_FACTORY1 = 0xfff0;
const PARAM_USER = 0xfff3;
/** The `enumCountCap` the walk uses; the user bank is 512 slots, well inside it. */
const ENUM_CAP = 1024;

interface Opts {
  port?: string;
  model: number;
  block: number;
  param: number;
  max: number;
  userAll: boolean;
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = { model: 0x11, block: DEFAULT_BLOCK, param: PARAM_USER, max: 24, userAll: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--port') o.port = argv[++i];
    else if (a === '--model') o.model = Number(argv[++i]);
    else if (a === '--block') o.block = Number(argv[++i]);
    else if (a === '--param') o.param = Number(argv[++i]);
    else if (a === '--max') o.max = Number(argv[++i]);
    else if (a === '--user-all') o.userAll = true;
  }
  return o;
}

export async function main(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);
  const opened = await openProbeSession(opts.model, opts.port);
  if (!opened.ok) {
    console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`);
    return 3;
  }
  const { session } = opened;
  const model = opts.model;

  /** Definition record → the enum's declared span (min..max), or why it can't be walked. */
  async function definition(block: number, param: number) {
    const frames = await session.transport.request(buildDefQuery(model, block, param), { timeoutMs: 900, quietMs: 60 });
    const dec = frames.length ? decodeReply(Uint8Array.from(frames[frames.length - 1]!)) : null;
    return dec && dec.view === 'definition' ? dec : null;
  }

  /** Walk an enum's labels at sub = min..min+count-1 (the walk's own convention). */
  async function labels(block: number, param: number, limit: number): Promise<{ labels: string[]; stopped: string }> {
    const def = await definition(block, param);
    if (!def) return { labels: [], stopped: 'no definition record' };
    const lo = Math.round(def.min);
    const span = Math.round(def.max - def.min + 1);
    const bound = Math.max(1, Math.min(span >= 1 ? span : ENUM_CAP, ENUM_CAP, limit));
    const out: string[] = [];
    for (let i = 0; i < bound; i++) {
      const frames = await session.transport.request(buildEnumQuery(model, block, param, lo + i), { timeoutMs: 900, quietMs: 60 });
      const dec = frames.length ? decodeReply(Uint8Array.from(frames[frames.length - 1]!)) : null;
      if (!dec || dec.view !== 'enum_label') return { labels: out, stopped: `list ended at sub ${lo + i} (${dec ? dec.view : 'no reply'})` };
      out.push(dec.label);
    }
    return { labels: out, stopped: bound < Math.min(span, ENUM_CAP) ? `stopped at the --max/${limit} limit` : 'full declared span' };
  }

  try {
    console.log(`device: ${session.label} (model 0x${model.toString(16)}) · block ${opts.block} · READ-ONLY`);

    // CONTROL FIRST: FACTORY 1 must read back as real cab names, or the mechanism is what's broken.
    console.log('\n--- CONTROL: param 0xfff0 (FACTORY 1) ---');
    const ctlDef = await definition(opts.block, opts.param === PARAM_USER ? PARAM_FACTORY1 : opts.param);
    console.log(`definition: ${ctlDef ? `kind=${ctlDef.kind} min=${ctlDef.min} max=${ctlDef.max}` : 'NONE'}`);
    const ctl = await labels(opts.block, opts.param === PARAM_USER ? PARAM_FACTORY1 : opts.param, 12);
    console.log(`labels: ${ctl.labels.length} (${ctl.stopped})`);
    for (const [i, l] of ctl.labels.entries()) console.log(`  [${String(i + 1).padStart(3)}] ${JSON.stringify(l)}`);

    console.log(`\n--- TARGET: param 0x${opts.param.toString(16)} (${opts.param === PARAM_USER ? 'USER' : 'requested'}) ---`);
    const tDef = await definition(opts.block, opts.param);
    console.log(`definition: ${tDef ? `kind=${tDef.kind} min=${tDef.min} max=${tDef.max}` : 'NONE'}`);
    const limit = opts.userAll ? ENUM_CAP : opts.max;
    const tgt = await labels(opts.block, opts.param, limit);
    console.log(`labels: ${tgt.labels.length} (${tgt.stopped})`);
    for (const [i, l] of tgt.labels.entries()) console.log(`  [${String(i + 1).padStart(3)}] ${JSON.stringify(l)}`);

    const named = tgt.labels.filter((l) => l.trim().length > 0);
    console.log(`\nsummary: control ${ctl.labels.filter((l) => l.trim()).length} named · target ${named.length} named of ${tgt.labels.length} read`);
    if (!ctl.labels.length) console.log('the CONTROL read failed — fix the mechanism before trusting anything about the user bank');
    else if (!named.length) console.log('the control works but the USER bank returned no names — the user bank is NOT readable this way');
    return 0;
  } finally {
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
