// ────────────────────────────────────────────────────────────────────────────────────────────────
// standing-read — READ-ONLY. The four-frame "where is the device right now" instrument.
//
// WHY THIS EXISTS (ROUND 15, task 5). The hole record's regime change on 2026-10-12 had to be
// RECONSTRUCTED BY HAND from console scrollback, because nothing was measuring it on a schedule: the
// address read `00 00 00 00 00 02 00 00 00` at 13:57 and `1b 14 4c 7a 0a 02 00 00 00` from 14:20 on,
// and no frame this stack sent caused the transition (the only scene frames in any tap are ROUND 14's
// two authorised arms, both ending at scene 0). A regime is only datable if something DATED is
// written down every time the device is looked at. This is that thing.
//
// IT SENDS FOUR READS AND NOTHING ELSE — no write, no scene switch, no preset change:
//   1. the HOLE RECORD        fn=0x01 sub=0x1b at [00, ANCHOR, 00, 00, 00] → the 9-byte content field
//   2. the PRESET NAME        fn=0x0d 7f 7f                                  → which preset is loaded
//   3. the PLACED SET         fn=0x13 status dump                            → every placed eid
//   4. the SCENE INDEX        fn=0x0c                                        → scene 0..7
// plus two controls, because a reading with no control cannot be trusted:
//   NEGATIVE  fn=0x01 sub=0x99 (an unmapped sub) MUST come back SILENT — a probe that cannot fail
//             is worthless, and this is the same control every other probe in this repo carries.
//   POSITIVE  the 0x1b reply itself must have arrived (and the 0x13 dump must be non-empty) — if the
//             link is deaf, every field below reads as a value rather than as an absence.
//
// EVERY LINE IS APPENDED to a JSONL log (default ~/repos/stack/standing-read.jsonl) with an ISO
// timestamp, so the next transition is DATED and can be diffed rather than narrated.
//
// INDEX CONVENTIONS (stated, because this repo has four):
//   payload = frame.slice(7, -1) (checksum + F7 removed) — the space the 0x1b content field is quoted in
//   content = payload bytes 5..13  (9 bytes; the task's own convention, same as probe-hole-vs-scene)
//   data    = frame.slice(12, -2)= payload[5..]  — the diff-2e-head-vs-grid "data" space
//   the raw reply is printed in full, so no reader has to reconstruct an offset.
//
// USAGE  npx tsx scripts/standing-read.ts [--port /dev/ttyACM0] [--anchor 0x24] [--note "…"]
//                                  [--jsonl <path>] [--no-log] [--tap <path>]
// Exit: 0 read (controls green) · 2 a control failed (the reading is NOT trustworthy) · 3 no device.
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { fractalChecksum } from 'forgefx-midi/shared';

const MODEL = 0x11;
const DEFAULT_JSONL = '/home/insn/repos/stack/standing-read.jsonl';
const HOLE_ANCHOR_DEFAULT = 0x24;

const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fn=0x01 <sub> <5-byte address region>, zero-padded past the region exactly as the other probes do. */
export function subQuery(sub: number, at: readonly number[], model = MODEL): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, model, 0x01, sub, ...at];
  while (body.length < 20) body.push(0x00);
  return [...body, fractalChecksum(body), 0xf7];
}

/** fn=0x0D QUERY PATCH NAME (current preset) — the cheap "which preset is loaded" oracle. */
export function patchNameQuery(model = MODEL): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, model, 0x0d, 0x7f, 0x7f];
  return [...body, fractalChecksum(body), 0xf7];
}

function patchNameOf(frames: readonly number[][]): string {
  const f = frames.find((x) => x[5] === 0x0d);
  if (!f) return '<no reply>';
  const body = f.slice(6, -2).filter((b) => b >= 0x20 && b < 0x7f);
  return String.fromCharCode(...body).trim();
}

/** Placed eids + their live bypass/channel, from a fn=0x13 status dump (id,id,dd triples). */
function parseStatusDump(f: readonly number[]): { eid: number; bypassed: boolean; channel: number }[] {
  const payload = f.slice(6, f.length - 2);
  const out: { eid: number; bypassed: boolean; channel: number }[] = [];
  for (let i = 0; i + 2 < payload.length; i += 3) {
    const eid = (payload[i]! & 0x7f) | ((payload[i + 1]! & 0x7f) << 7);
    const dd = payload[i + 2]! & 0x7f;
    out.push({ eid, bypassed: (dd & 0x01) !== 0, channel: (dd >> 1) & 0x07 });
  }
  return out;
}

export interface StandingRead {
  ts: string;
  epochMs: number;
  note: string | null;
  label: string;
  presetName: string;
  sceneIndex: number;
  placedEids: number[];
  placed: { eid: number; bypassed: boolean; channel: number }[];
  hole: { anchor: number; at: string; content: string; rawReply: string | null; replyBytes: number } | null;
  controls: { negativeSub99: 'silent' | 'ANSWERED (unexpected)'; statusDumpTriples: number; holeAnswered: boolean };
  verdict: 'read (controls green)' | 'UNTRUSTWORTHY — a control failed';
}

/**
 * Take one standing read on an OPEN session. Read-only: four reads plus two controls, no write.
 * Call this at the head of any probe that is about to change device state, so the state it started
 * from is dated rather than remembered.
 */
export async function standingRead(
  session: { transport: { request: (f: number[], o?: { timeoutMs?: number; quietMs?: number }) => Promise<number[][]> }; driver: { getScene?: () => Promise<{ index: number }> }; label: string; codec: { buildStatusDump: () => number[] } },
  opts: { anchor?: number; note?: string | null } = {}
): Promise<StandingRead> {
  const anchor = opts.anchor ?? HOLE_ANCHOR_DEFAULT;
  const at = `00 ${hex([anchor, 0, 0, 0])}`; // the byte the fn=0x01 query puts FIRST is 0x00 (see probe-hole-vs-scene: [0x00, anchor, 0,0,0])

  const holeFrames = await session.transport.request(subQuery(0x1b, [0x00, anchor, 0x00, 0x00, 0x00]), { timeoutMs: 900, quietMs: 30 });
  const holeReply = holeFrames.find((f) => f[5] === 0x01 && f[6] === 0x1b && f.length > 10 && f.length <= 100) ?? null;

  const nameFrames = await session.transport.request(patchNameQuery(), { timeoutMs: 900, quietMs: 60 });
  const statusFrames = await session.transport.request(session.codec.buildStatusDump(), { timeoutMs: 1500, quietMs: 90 });
  const scene = (await session.driver.getScene?.())?.index ?? -1;

  const negFrames = (await session.transport.request(subQuery(0x99, [0x00, 0x24, 0, 0, 0]), { timeoutMs: 900, quietMs: 60 }))
    .filter((f) => f[5] === 0x01 && f[6] === 0x99);

  const placed = statusFrames.filter((f) => f[5] === 0x13).flatMap((f) => parseStatusDump(f));
  const negativesSilent = negFrames.length === 0;
  const controlsGreen = negativesSilent && placed.length > 0 && holeReply !== null;

  return {
    ts: new Date().toISOString(),
    epochMs: Date.now(),
    note: opts.note ?? null,
    label: session.label,
    presetName: patchNameOf(nameFrames),
    sceneIndex: scene,
    placedEids: placed.map((p) => p.eid).sort((a, b) => a - b),
    placed,
    hole: holeReply
      ? {
          anchor,
          at,
          content: hex(holeReply.slice(7, -1).slice(5, 14)),
          rawReply: hex(holeReply),
          replyBytes: holeReply.length
        }
      : null,
    controls: {
      negativeSub99: negativesSilent ? 'silent' : 'ANSWERED (unexpected)',
      statusDumpTriples: placed.length,
      holeAnswered: holeReply !== null
    },
    verdict: controlsGreen ? 'read (controls green)' : 'UNTRUSTWORTHY — a control failed'
  };
}

/** One-line human summary of a standing read (what a console or a log reader wants). */
export function standingLine(r: StandingRead): string {
  return `${r.ts} · ${r.presetName} · scene ${r.sceneIndex} · ${r.placedEids.length} placed [${r.placedEids.map((e) => '0x' + e.toString(16)).join(',')}] · hole(${r.hole ? r.hole.content : '<no reply>'})`;
}

export async function main(argv: string[]): Promise<number> {
  const arg = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const anchor = arg('--anchor') !== undefined ? parseInt(arg('--anchor')!, 16) : HOLE_ANCHOR_DEFAULT;
  const note = arg('--note') ?? null;
  const jsonl = arg('--jsonl') ?? DEFAULT_JSONL;
  const noLog = argv.includes('--no-log');
  if (arg('--tap')) process.env.FORGEFX_TAP = arg('--tap')!;

  const opened = await openProbeSession(MODEL, arg('--port'));
  if (!opened.ok) { console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`); return 3; }
  const { session } = opened;
  try {
    console.log(`device ${session.label} · STANDING READ (read-only: 4 reads + 2 controls, nothing written)`);
    console.log(`tap: ${process.env.FORGEFX_TAP ?? '(none set)'}`);
    const r = await standingRead(session, { anchor, note });
    console.log(standingLine(r));
    console.log(`  preset name   ${JSON.stringify(r.presetName)}`);
    console.log(`  scene index   ${r.sceneIndex}${r.sceneIndex < 0 ? '  (read FAILED — a sentinel, not a value)' : ''}`);
    console.log(`  placed set    ${r.placedEids.length} block(s): ${r.placed.map((p) => `0x${p.eid.toString(16)}${p.bypassed ? ' (bypassed)' : ''} ch${p.channel}`).join(', ')}`);
    if (r.hole) {
      console.log(`  hole record   content(9B, payload[5..13]) = ${r.hole.content}`);
      console.log(`                raw reply ${r.hole.replyBytes}B: ${r.hole.rawReply}`);
      console.log(`                query was fn=01 sub=1b at [${r.hole.at}]`);
    } else {
      console.log('  hole record   NO REPLY (the 0x1b read from this anchor did not answer)');
    }
    console.log(`  controls      negative sub 0x99 → ${r.controls.negativeSub99}; status-dump triples ${r.controls.statusDumpTriples}; hole answered ${r.controls.holeAnswered}`);
    console.log(`VERDICT: ${r.verdict}`);
    if (!noLog) {
      mkdirSync(dirname(jsonl), { recursive: true });
      appendFileSync(jsonl, JSON.stringify(r) + '\n');
      console.log(`logged: ${jsonl}`);
    } else {
      console.log('logged: (suppressed by --no-log)');
    }
    return r.verdict === 'read (controls green)' ? 0 : 2;
  } finally {
    await sleep(50);
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
