// probe-controllers-enums — why do the Controllers screen's two dropdowns do nothing?
//
// The Axis Controllers screen (eid 2) draws CONTROLLERS_TEMPOTOUSE (pid 33) and
// CONTROLLERS_PITCH_SOURCE (pid 110) as on/off buttons. Andy reports both are dead: pressing them
// changes nothing. This probe answers, on the real unit, in order:
//
//   1. Does the eid-2 read actually SERVE those pids, and with what value/options?
//   2. Does a write to them get accepted (ok:true) or refused (ok:false)?
//   3. Does the value READ BACK change after the write?
//
// Every write is self-restoring: the original ordinal is captured first and written back at the end,
// and the restore is verified by a fresh read. If a restore cannot be verified the script says so
// loudly with the pid and the original value.
//
// USAGE  npx tsx scripts/probe-controllers-enums.ts [--port /dev/ttyACM0] [--no-writes]
import { openProbeSession } from './probe-device.js';

const EID = 2; // CONTROLLERS
const TARGETS = [
  { pid: 33, name: 'CONTROLLERS_TEMPOTOUSE' },
  { pid: 110, name: 'CONTROLLERS_PITCH_SOURCE' }
];

const argOf = (n: string): string | undefined => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main(): Promise<number> {
  const port = argOf('--port') ?? '/dev/ttyACM0';
  const writes = !process.argv.includes('--no-writes');

  const opened = await openProbeSession(0x11, port);
  if (!opened.ok) {
    console.log(`no device: ${opened.failure.cls} — ${opened.failure.detail}`);
    return 3;
  }
  const { driver, close } = opened.session;
  console.log(`device: ${opened.session.label}`);

  try {
    const read = async () => {
      const r = await driver.blockParams!(EID, { watch: false });
      return r;
    };

    const before = await read();
    console.log(`\neid ${EID} read: ${before.named.length} named, ${before.enums.length} enums, type ${before.type?.name ?? '—'}`);

    const snapshot: Array<{ pid: number; name: string; value: number | null; options: string[] }> = [];
    for (const t of TARGETS) {
      const e = before.enums.find((x) => x.id === t.pid);
      const p = before.named.find((x) => x.id === t.pid);
      if (e) {
        snapshot.push({ pid: t.pid, name: e.name, value: e.value, options: e.options.map((o) => `${o.value}=${o.label}`) });
        console.log(`  pid ${t.pid} ENUM  name=${JSON.stringify(e.name)} value=${e.value} unresolved=${e.unresolved ?? '—'}`);
        console.log(`         options: ${e.options.map((o) => `${o.value}=${o.label}`).join(' | ') || '(none)'}`);
      } else if (p) {
        console.log(`  pid ${t.pid} KNOB  name=${JSON.stringify(p.name)} value=${p.value} norm=${p.norm}`);
      } else {
        console.log(`  pid ${t.pid} NOT SERVED on eid ${EID}`);
      }
    }

    if (!writes) {
      console.log('\n--no-writes: stopping before the write test');
      return 0;
    }

    let failures = 0;
    for (const s of snapshot) {
      if (s.value == null) {
        console.log(`\npid ${s.pid}: value is unresolved (null) — the UI's setEnum returns early on this, which is a silent no-op. Nothing to write.`);
        failures++;
        continue;
      }
      const other = s.value === 0 ? 1 : 0;
      console.log(`\npid ${s.pid} (${s.name}): writing ${s.value} → ${other}`);
      const w = await driver.setParam!(EID, s.pid, other, false);
      console.log(`  write result: ok=${w.ok}`);
      const after = await read();
      const e2 = after.enums.find((x) => x.id === s.pid);
      console.log(`  read back: ${e2?.value} (expected ${other})`);
      if (e2?.value !== other) failures++;

      // restore
      const r = await driver.setParam!(EID, s.pid, s.value, false);
      const restored = await read();
      const e3 = restored.enums.find((x) => x.id === s.pid);
      console.log(`  restore → ${s.value}: ok=${r.ok}, read back ${e3?.value}`);
      if (e3?.value !== s.value) {
        console.log(`  !! FAILED RESTORE — pid ${s.pid} (${s.name}) is at ${e3?.value}, original was ${s.value}. Fix by hand.`);
        failures++;
      }
    }

    console.log(`\n${failures === 0 ? 'all targets behaved' : `${failures} problem(s) above`}`);
    return failures === 0 ? 0 : 2;
  } finally {
    await close();
  }
}

main().then((c) => process.exit(c)).catch((e) => {
  console.error(e);
  process.exit(1);
});
