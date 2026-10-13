// ────────────────────────────────────────────────────────────────────────────────
// probe-1f-raw — READ-ONLY: dump the RAW payload bytes of real view-0x1f ENUM-LABEL replies.
//
// WHY (round-19 third-party review of the codec change in forgefx-midi 1d7f5ee).
// The commit scoped the "interior NUL" tolerance to the VALUE view (0x00), on the argument that a
// VALUE buffer packs several NUL-separated fields (the measured Delay Low Cut reply decodes to
// "20.0 Hz\0\0sec") while a LABEL buffer (0x1f) holds exactly ONE string — so any non-NUL byte after
// the terminating NUL means "not a label". The reviewer raised two objections that only the instrument
// can answer:
//   (a) the repo holds NO real 0x1f frame to check that premise against (the only real captures are
//       view-0x00 frames), and
//   (b) "20.0 Hz\0\0sec" — "sec" inside a Hz parameter's reply — reads like RESIDUE from an earlier
//       formatted string in a reused buffer, which would mean the VALUE view does not "pack fields"
//       either and the label view may reuse the buffer the same way.
// If (b) is true, a real label could carry such residue and the strict rule would REJECT it: the walk
// stops at that ordinal, the label list truncates, and a step!=0 enum that needs label recovery falls
// back to a float — the mirror image of the bug the commit fixed.
//
// This probe asks the unit for real 0x1f replies and prints, for each: the raw payload length, the
// index of the first NUL, the bytes AFTER that NUL, and the label decodeReply produced. A label with
// real content after its terminator is the answer to (b).
//
// NOTHING IS WRITTEN: view 0x1f and view 0x00 reads only. The enum list (which params to ask about) is
// read through the driver's own blockParams, so it is the same roster the live walk uses.
//
// USAGE  npx tsx scripts/probe-1f-raw.ts [--port /dev/ttyACM0] [--out <path.json>] [--per-param 2]
//        (the ForgeFX server must be stopped — one serial owner)
// ────────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { adaptRequest } from '../src/services/deviceCache.js';
import type { Transport } from '../src/transport/types.js';
import { buildEnumQuery, buildValueQuery, decodeReply, decodeSeptetStream } from 'forgefx-midi/cache';

const MODEL = 0x11;
const hex = (b: ArrayLike<number>) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join(' ');

/** Placed blocks on the preset; a family that is not placed simply yields no enum roster. */
const BLOCKS = [62, 66, 70, 78, 82, 90, 94, 118, 130, 37, 42, 43, 46, 58];

/** Pull the raw payload out of a reply frame without decodeReply's classification. */
function payloadOf(frame: Uint8Array): { inner: Uint8Array; cnt: number; raw: Uint8Array | null; tag: number } {
  const n = frame.length;
  const inner = frame.subarray(6, n - 2);
  if (inner.length < 15) return { inner, cnt: 0, raw: null, tag: inner[6] ?? -1 };
  const cnt = inner[13]! | (inner[14]! << 8);
  let raw: Uint8Array | null = null;
  try {
    raw = cnt > 0 ? decodeSeptetStream(inner, cnt, 15) : null;
  } catch {
    raw = null;
  }
  return { inner, cnt, raw, tag: inner[6]! };
}

/** Classify a payload the way the codec change does: content after the first NUL is structural for a
 *  value buffer, and (per the commit) impossible for a label buffer. */
function tail(raw: Uint8Array): { firstNul: number; afterFirstNul: number[] } {
  let i = 0;
  while (i < raw.length && raw[i] !== 0x00) i += 1;
  return { firstNul: i, afterFirstNul: Array.from(raw.slice(i + 1)).filter((b) => b !== 0x00) };
}

async function ask(transport: Transport, q: Uint8Array) {
  const frame = await adaptRequest(transport, q);
  if (!frame) return null;
  return { frame, ...payloadOf(frame), dec: decodeReply(frame) };
}

export async function main(argv: string[]): Promise<number> {
  const argOf = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const port = argOf('--port');
  const out = argOf('--out');
  const perParam = Number(argOf('--per-param') ?? 2);

  const opened = await openProbeSession(MODEL, port);
  if (!opened.ok) {
    console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`);
    return 3;
  }
  const s = opened.session;
  const artifact: { at: string; readOnly: string; labels: unknown[]; values: unknown[] } = {
    at: new Date().toISOString(),
    readOnly: 'view 0x1f enum-label reads + view 0x00 value reads only',
    labels: [],
    values: [],
  };

  let labelsWithJunk = 0;
  let labelsTotal = 0;
  let labelsClean = 0;
  let labelsNoReply = 0;

  try {
    console.log(`device: ${s.label} (model 0x${MODEL.toString(16)}) · READ-ONLY (view 0x1f + 0x00)`);
    console.log('asking the unit for REAL enum-label payloads (the repo has no captured 0x1f frame)\n');
    console.log('blk param  sub  len  firstNUL  bytes AFTER the first NUL        decoded label            verdict');

    for (const eid of BLOCKS) {
      if (!s.driver.blockParams) continue;
      let enums: { id: number; name: string; options: { value: number; label: string }[] }[] = [];
      try {
        const bp = await s.driver.blockParams(eid);
        enums = bp.enums.slice(0, perParam);
      } catch {
        continue; // block not placed / no roster
      }
      for (const en of enums) {
        for (const opt of en.options.slice(0, 8)) {
          const r = await ask(s.transport, buildEnumQuery(MODEL, eid, en.id, opt.value));
          if (!r || !r.raw || r.raw.length === 0) {
            labelsNoReply += 1;
            console.log(
              `${String(eid).padStart(3)} ${String(en.id).padStart(5)}  ${String(opt.value).padStart(3)}  —    —         —                             —                         NO REPLY`
            );
            continue;
          }
          const t = tail(r.raw);
          labelsTotal += 1;
          const junk = t.afterFirstNul.length > 0;
          if (junk) labelsWithJunk += 1;
          else labelsClean += 1;
          const label = r.dec && r.dec.view === 'enum_label' ? r.dec.label : r.dec ? `(${r.dec.view})` : 'NULL';
          console.log(
            `${String(eid).padStart(3)} ${String(en.id).padStart(5)}  ${String(opt.value).padStart(3)}  ${String(r.raw.length).padStart(3)}  ${String(t.firstNul).padStart(7)}  ` +
              `${hex(t.afterFirstNul).slice(0, 28).padEnd(28)}  ${JSON.stringify(label).slice(0, 24).padEnd(24)}  ${junk ? 'JUNK AFTER NUL' : 'clean'}`
          );
          artifact.labels.push({
            eid,
            param: en.id,
            paramName: en.name,
            sub: opt.value,
            expectedLabel: opt.label,
            rawLen: r.raw.length,
            firstNul: t.firstNul,
            afterFirstNul: t.afterFirstNul,
            rawHex: hex(r.raw),
            decoded: r.dec,
            junkAfterNul: junk,
          });
        }
      }
    }

    // ── POSITIVE CONTROL: the value view is KNOWN to carry interior NUL padding ──────────────────────
    console.log('\n── CONTROL: view 0x00 (the buffer that measured "20.0 Hz\\0\\0sec") ─────────────────────────');
    console.log('blk param  len  firstNUL  bytes AFTER the first NUL        decoded value');
    for (const [eid, pid, why] of [
      [70, 16, 'Delay Low Cut — the measured interior-NUL case'],
      [62, 33, 'Cab Drive — trailing-NUL padding'],
      [94, 3, 'Wah Resonance Q'],
      [66, 32, 'Reverb Drive'],
    ] as [number, number, string][]) {
      const r = await ask(s.transport, buildValueQuery(MODEL, eid, pid));
      if (!r || !r.raw) {
        console.log(`${String(eid).padStart(3)} ${String(pid).padStart(5)}  NO REPLY   (${why})`);
        continue;
      }
      const t = tail(r.raw);
      console.log(
        `${String(eid).padStart(3)} ${String(pid).padStart(5)}  ${String(r.raw.length).padStart(3)}  ${String(t.firstNul).padStart(7)}  ` +
          `${hex(t.afterFirstNul).slice(0, 28).padEnd(28)}  ${JSON.stringify(r.dec && 'value' in r.dec ? r.dec.value : r.dec)}   (${why})`
      );
      artifact.values.push({ eid, pid, why, rawLen: r.raw.length, firstNul: t.firstNul, afterFirstNul: t.afterFirstNul, rawHex: hex(r.raw), decoded: r.dec });
    }

    console.log(
      `\nlabels: ${labelsTotal} read (${labelsClean} clean, ${labelsWithJunk} WITH JUNK AFTER THE TERMINATING NUL), ${labelsNoReply} no reply`
    );

    // ── THE OTHER HALF OF THE REVIEW'S QUESTION: what does a FLOAT answer to a 0x1f probe? ──────────
    // The codec change was motivated by a speculative 0x1f probe of a numeric float decoding
    // "printable prefix + NUL + junk" as a label and flipping the float to an enum. If such replies
    // exist they are visible here; if a float answers nothing (or a sentinel), the hazard is
    // hypothetical on this unit.
    console.log('\n── FLOAT params probed with view 0x1f (does a float ever answer a label query?) ────────────');
    console.log('blk param  sub  len  firstNUL  raw payload (hex)                     decodeReply');
    for (const [eid, pid, why] of [
      [94, 3, 'Wah Resonance Q (0x52 float)'],
      [62, 33, 'Cab Drive (0x52 float)'],
      [70, 22, 'Delay Drive (0x52 float)'],
      [66, 32, 'Reverb Drive (0x52 float)'],
      [118, 6, 'Slew Rate (0x52 float)'],
      [94, 1, 'Wah Frequency Min (0x240 log float)'],
    ] as [number, number, string][]) {
      for (let sub = 0; sub < 3; sub += 1) {
        const r = await ask(s.transport, buildEnumQuery(MODEL, eid, pid, sub));
        if (!r || !r.raw) {
          console.log(`${String(eid).padStart(3)} ${String(pid).padStart(5)}  ${String(sub).padStart(3)}  —    —         NO PAYLOAD (${why})`);
          continue;
        }
        const t = tail(r.raw);
        console.log(
          `${String(eid).padStart(3)} ${String(pid).padStart(5)}  ${String(sub).padStart(3)}  ${String(r.raw.length).padStart(3)}  ${String(t.firstNul).padStart(7)}  ` +
            `${hex(r.raw).slice(0, 34).padEnd(34)}  ${JSON.stringify(r.dec)}   (${why})`
        );
        artifact.values.push({ eid, pid, sub, why: `0x1f probe of a float: ${why}`, rawLen: r.raw.length, firstNul: t.firstNul, afterFirstNul: t.afterFirstNul, rawHex: hex(r.raw), decoded: r.dec });
      }
    }

    console.log(
      labelsWithJunk === 0
        ? 'the unit’s real 0x1f labels carry nothing after their terminator — the strict rule is safe on this unit'
        : 'at least one REAL label has content after its terminator — the strict rule rejects a valid label'
    );
    if (out) {
      mkdirSync(dirname(resolve(out)), { recursive: true });
      writeFileSync(resolve(out), JSON.stringify({ ...artifact, labelsTotal, labelsClean, labelsWithJunk, labelsNoReply }, null, 2));
      console.log(`artifact: ${resolve(out)}`);
    }
    return 0;
  } finally {
    await s.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).then((c) => process.exit(c));
