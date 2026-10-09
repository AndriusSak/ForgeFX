// ────────────────────────────────────────────────────────────────────────────────
// verify-review-2026-10-09 — falsify the third-party review's checkable claims.
//
// A reviewer's label is not evidence. Every claim the pass made that CAN be settled offline is settled
// here, with the reviewer's own falsification where they offered one. Nothing in this file asserts a
// desired outcome: each check prints what it OBSERVED, so the report can separate confirmed findings
// from claims that did not survive re-reading.
//
// READ-ONLY on the device (mocked transport throughout). Run from ForgeFX/server:
//   npx tsx scripts/verify-review-2026-10-09.ts
// ────────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePresetDump, decodeRawPatch, parsePerformPage, patchPerformSlot, findPerformTables, parsePerPresetSwitches, PP_TARGET_OFFSET } from 'forgefx-midi/devices/gen3';
import { isDryRunRequest } from '../src/runtime/writeGate.js';
import { buildTestApp } from '../test/helpers/api.js';

const MODEL = 0x11;
const fixture = (rel: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(rel, import.meta.url))));
const bodyOf = (bytes: Uint8Array): Uint8Array =>
  decodeRawPatch(parsePresetDump(bytes, 0, MODEL).chunkPayloads).body;

const line = (s: string): void => console.log(s);
const hdr = (n: string): void => console.log(`\n=== ${n} ===`);

async function main(): Promise<void> {
  // ── Finding 1: can a percent-encoded path slip past the write gate? ──────────────
  hdr('F1  percent-encoded path vs the write gate (read-only server must 403)');
  {
    const { app, mock } = await buildTestApp(MODEL, undefined, { writes: false });
    const before = mock.sent.length;
    const plain = await app.inject({ method: 'PUT', url: '/preset/perform/1', payload: { effectId: 62 } });
    const encoded = await app.inject({ method: 'PUT', url: '/preset/%70erform/1', payload: { effectId: 62 } });
    line(`  plain   /preset/perform/1      -> ${plain.statusCode}  (403 = gate held)`);
    line(`  encoded /preset/%70erform/1    -> ${encoded.statusCode}  (403 = gate held; anything else = BYPASS)`);
    line(`  device frames sent: ${mock.sent.length - before}`);
    await app.close();
  }
  {
    const { app, mock } = await buildTestApp(MODEL, undefined, { writes: false });
    const encSwitch = await app.inject({ method: 'PUT', url: '/preset/%73witches/1', payload: { targetIndex: 51 } });
    line(`  encoded /preset/%73witches/1   -> ${encSwitch.statusCode}`);
    await app.close();
  }
  hdr('F1b dry run on an encoded path (must be 400 dry-run-unsupported)');
  {
    const { app, mock } = await buildTestApp(MODEL);
    const before = mock.sent.length;
    const dryPlain = await app.inject({ method: 'PUT', url: '/preset/perform/1?dryRun=true', payload: { effectId: 62 } });
    const dryEnc = await app.inject({ method: 'PUT', url: '/preset/%70erform/1?dryRun=true', payload: { effectId: 62 } });
    line(`  plain   -> ${dryPlain.statusCode}  (400 = refused)`);
    line(`  encoded -> ${dryEnc.statusCode}  (400 = refused; anything else = the preview ran against the unit)`);
    await app.close();
  }

  // ── Finding 5: unrecognized dry-run spellings (fail-open?) ──────────────────────
  hdr('F5  isDryRunRequest on spellings a user might actually type');
  for (const q of ['?dryRun=true', '?dryRun=1', '?dryRun=yes', '?dryRun=TRUE', '?dryrun=true', '?dryRun=false', '?dryRun=0']) {
    line(`  ${q.padEnd(18)} -> ${isDryRunRequest('/preset/perform/1' + q)}`);
  }

  // ── Finding 2: does a short label move the page anchor? ─────────────────────────
  hdr('F2  perform page: patch a SHORT effect label, then re-locate the page');
  {
    const bytes = fixture('../test/fixtures/preset-perform/preset-410.bin');
    const original = bodyOf(bytes);
    const at0 = findPerformTables(original);
    line(`  page located at ${at0} before the patch`);
    for (const label of ['EQ', 'X', '', 'CAB']) {
      const body = Uint8Array.from(original);
      const ok = patchPerformSlot(body, 1, { effectLabel: label });
      const at1 = findPerformTables(body);
      const page = parsePerformPage(body);
      line(`  effectLabel=${JSON.stringify(label).padEnd(6)} patch=${ok}  findPerformTables=${at1}  parsed=${page ? `at ${page.at}, slot1=${page.slots[0]!.effectId}/${page.slots[0]!.paramId}` : 'undefined'}`);
    }
  }

  // ── Finding 10: labels that cannot round-trip read back as '' ───────────────────
  hdr('F10 label round-trip (the driver compares against the REQUESTED label)');
  {
    const original = bodyOf(fixture('../test/fixtures/preset-perform/preset-410.bin'));
    for (const label of ['Tone', 'AB', 'A', 'Café']) {
      const body = Uint8Array.from(original);
      patchPerformSlot(body, 6, { paramLabel: label });
      const back = parsePerformPage(body)?.slots.find((s) => s.slot === 6)?.paramLabel;
      line(`  wrote ${JSON.stringify(label).padEnd(8)} read back ${JSON.stringify(back)}  ${back === label ? 'match' : 'MISMATCH -> ok:false'}`);
    }
  }

  // ── Finding 6: is `populated` a claim about bytes nobody read? ──────────────────
  hdr('F6  populated=false while an UNOBSERVED byte is non-zero (the UI says "all zero")');
  {
    const body = bodyOf(fixture('../test/fixtures/preset-switches/preset-410-delay2.bin'));
    const page = parsePerPresetSwitches(body)!;
    const at = page.at;
    line(`  real capture: marker+6=${body[at + 6]} marker+148=${body[at + 148]} marker+160=${body[at + 160]}  populated=${page.populated}`);
    // zero every field the decoder observes, leave marker+160 (unobserved) alone
    const z = Uint8Array.from(body);
    z[at + 4] = 0; z[at + 5] = 0; z[at + 6] = 0; z[at + 7] = 0; z[at + 148] = 0;
    const zPage = parsePerPresetSwitches(z)!;
    line(`  observed fields zeroed: marker+160 still ${z[at + 160]}  ->  populated=${zPage.populated}`);
    line(`  => the panel would render "the block is all zero" while marker+160 = ${z[at + 160]}`);
  }

  // ── Finding 8: the midi test's own assertion (slice indexing) ───────────────────
  hdr('F8  populatedSlice: does the assertion check the byte it claims?');
  {
    const MARKER_AT = 8; // populatedSlice() puts the marker at region offset 8
    line(`  slice marker offset ${MARKER_AT}, PP_TARGET_OFFSET ${PP_TARGET_OFFSET}`);
    line(`  test asserts body[PP_TARGET_OFFSET + 1]      = index ${PP_TARGET_OFFSET + 1}`);
    line(`  marker+149 is actually at slice index        = ${MARKER_AT + PP_TARGET_OFFSET + 1}`);
    line(`  => the assertion checks an unrelated byte (a write corrupting marker+149 would still pass)`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
