// §2.7 — the server-side cab-IR BYTE LIBRARY. Two layers, both proven here:
//   1. the STORE (runtime/cabLibrary.ts) over an in-memory backend: round-trip, dedup, a CORRUPT /
//      partial index entry (skipped + reported, never thrown), a MISSING blob (listed available:false),
//      and the growth cap;
//   2. the ROUTES on BOTH surfaces (app.ts + the browser runtime router): list, one entry's bytes,
//      the malformed-id 400 and the unknown-id 404 — plus the upload→store wiring (a verified upload
//      leaves its bytes in the library; a DISCARDED one does not).
//
// No hardware: a hand-built fake driver returns a canned upload result; the store is the isolated
// default store (FORGEFX_DATA_DIR is a throwaway — helpers/env.ts) or a fresh in-memory one.
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeviceDriver, DriverCapabilities } from '../../src/drivers/types.js';
import { createRouter } from '../../src/runtime/router.js';
import { createStore } from '../../src/runtime/store.js';
import { createMemStoreBackend } from '../../src/runtime/memStoreBackend.js';
import { createFsStoreBackend, nodeCodec } from '../../src/runtime/fsStoreBackend.js';
import * as cabLibrary from '../../src/runtime/cabLibrary.js';
import { buildCabIrContainerFromWords, parseCabIrSyx, CAB_IR_SAMPLE_SLOTS } from 'forgefx-midi/devices/gen3';
import * as store from '../../src/store.js';
import { buildTestApp } from '../helpers/api.js';
import { assert, assertEqual } from '../helpers/mock.js';

export const CAB_LIBRARY_CASE_COUNT = 24;

// Real-sized payloads from an existing fixture (a 24680-byte FM3 dump) — the store is byte-agnostic,
// so a real dump makes the round-trip and the cap exercise realistic byte volumes rather than toys.
const FIXTURE = new Uint8Array(readFileSync(new URL('../fixtures/preset-convert/fm3-preset-5.syx', import.meta.url)));

const CAPS: DriverCapabilities = {
  slotModel: 'grid',
  grid: { rows: 4, cols: 12 },
  gridEdit: true,
  scenes: 8,
  channels: true,
  presetDump: true,
  blockParamDecode: true,
  telemetry: { tuner: false, outputMeters: false, cpu: false },
  fcModel: true,
  fcLiveRead: false,
  modBind: true,
  cabIrs: true,
  supportsSave: true,
  selfDescribe: false,
  cacheImport: false,
  fullCapture: false
};

/** Fake FM3 whose upload is scriptable: `ok` decides whether the bytes land (and thus are stored). */
function makeFakeFm3WithUpload(ok: boolean): DeviceDriver {
  return {
    modelId: 0x11,
    key: 'fm3',
    name: 'FM3',
    capabilities: CAPS,
    uploadCabIr: async (bytes: Uint8Array, opts?: { dest?: { page: number; index: number }; name?: string }) =>
      ({
        ok,
        discarded: !ok,
        closeCode: ok ? 0x00 : 0x13,
        reason: ok ? 'accepted the container' : 'the unit DISCARDED it',
        name: opts?.name ?? 'LT TV Mix 7',
        modelId: 0x11,
        frames: 10,
        bytes: bytes.length,
        sampleSlots: 2040,
        renamed: !!opts?.name,
        dest: opts?.dest ?? { page: 0x10, index: 0 },
        acks: { start: true, end: true, data: 8, expectedData: 8, complete: true, codes: [] }
      }) as never
  } as DeviceDriver;
}

function freshStore(): { store: ReturnType<typeof createStore>; backend: ReturnType<typeof createMemStoreBackend> } {
  const backend = createMemStoreBackend();
  return { store: createStore(backend, nodeCodec), backend };
}

function clearDefaultLibrary(): void {
  for (const d of store.defaultStore.listDocs(cabLibrary.CAB_LIBRARY_COLLECTION)) {
    store.defaultStore.delDoc(cabLibrary.CAB_LIBRARY_COLLECTION, d.id);
  }
}

export async function runCabLibraryTests(): Promise<void> {
  // ── 1. STORE round-trip: bytes + metadata come back, blob is content-addressed ──
  {
    const { store: mem, backend } = freshStore();
    const sha = nodeCodec.sha256Hex(FIXTURE);
    const e = cabLibrary.saveCabIr(mem, { bytes: FIXTURE, name: 'LT TV Mix 7', page: 0x10, index: 3, user: 4 });
    assertEqual(e.sha256, sha, 'the entry is keyed by the real sha256 of the bytes');
    assertEqual(e.length, FIXTURE.length, 'the byte length is recorded');
    assertEqual(e.user, 4, 'the convenience user slot is recorded');
    assertEqual(e.page, 0x10, 'the destination page is recorded');

    const list = cabLibrary.listCabLibrary(mem);
    assertEqual(list.total, 1, 'one entry lists');
    assertEqual(list.skipped, 0, 'nothing skipped for a well-formed library');
    assertEqual(list.cap, cabLibrary.CAB_LIBRARY_MAX, 'the cap is reported');
    assert(list.scope.includes('uploaded through Axis'), 'the list carries the honest scope line');
    assert(list.entries[0]!.available === true, 'the entry reports its bytes as available');

    const got = cabLibrary.readCabLibraryBytes(mem, e.id);
    assert(!!got && got.length === FIXTURE.length, 'the stored bytes come back at full length');
    assert(Buffer.compare(Buffer.from(got!), Buffer.from(FIXTURE)) === 0, 'the stored bytes are byte-identical');
    assert(backend.getJSON<string | null>('__nope', null) === null, 'mem backend sanity: no stray json key');
  }

  // ── 2. dedup: identical content to the SAME slot refreshes, not duplicates ──
  {
    const { store: mem } = freshStore();
    const a = cabLibrary.saveCabIr(mem, { bytes: FIXTURE, name: 'A', page: 0x10, index: 1, user: 2 });
    const b = cabLibrary.saveCabIr(mem, { bytes: FIXTURE, name: 'B', page: 0x10, index: 1, user: 2 });
    assertEqual(cabLibrary.listCabLibrary(mem).total, 1, 'same content + same slot does not duplicate');
    assertEqual(a.id, b.id, 'the entry keeps its id');
    assertEqual(b.name, 'B', 'the name is refreshed');
  }

  // ── 3. CORRUPT / PARTIAL index entry: skipped + counted, never thrown ──
  {
    const { store: mem, backend } = freshStore();
    cabLibrary.saveCabIr(mem, { bytes: FIXTURE, name: 'good', page: 0x10, index: 0, user: 1 });
    // a malformed record injected straight into the collection (missing sha256, bad page type)
    backend.putDoc({ id: 'cab-1-aaaaaaaa', collection: cabLibrary.CAB_LIBRARY_COLLECTION, data: { id: 'cab-1-aaaaaaaa', name: 'bad', page: 'ten', index: 0 }, updatedAt: Date.now(), rev: 1 });
    const list = cabLibrary.listCabLibrary(mem); // must NOT throw
    assertEqual(list.total, 1, 'the malformed entry is not listed');
    assertEqual(list.skipped, 1, 'the malformed entry is counted as skipped');
  }

  // ── 4. MISSING blob: an index record whose bytes are gone lists available:false, read is null ──
  {
    const { store: mem, backend } = freshStore();
    const e = cabLibrary.saveCabIr(mem, { bytes: FIXTURE, name: 'orphan', page: 0x10, index: 9, user: 10 });
    backend.deleteBlob(`cab-${e.sha256}`);
    const list = cabLibrary.listCabLibrary(mem);
    assertEqual(list.entries[0]!.available, false, 'an entry with no blob is listed as unavailable');
    assertEqual(cabLibrary.readCabLibraryBytes(mem, e.id), null, 'its bytes read back null (route → 404)');
    assertEqual(cabLibrary.findCabBySlot(mem, 0x10, 9), null, 'a move never prefers an unavailable entry');
  }

  // ── 5. CAP: saving past the cap evicts the OLDEST, fabricating the count in is deterministic ──
  {
    const { store: mem } = freshStore();
    const cap = cabLibrary.CAB_LIBRARY_MAX;
    // one entry per distinct tiny payload, inserted oldest-first (savedAt is non-decreasing)
    const firstId = cabLibrary.saveCabIr(mem, { bytes: Uint8Array.from([0]), name: 'oldest', page: 0x10, index: 0, user: 1 }).id;
    for (let i = 1; i < cap + 1; i++) {
      cabLibrary.saveCabIr(mem, { bytes: Uint8Array.from([i & 0xff, 1]), name: `e${i}`, page: 0x10, index: (i % 128), user: (i % 512) + 1 });
    }
    const list = cabLibrary.listCabLibrary(mem);
    assertEqual(list.total, cap, `the library is capped at ${cap}`);
    assert(!list.entries.some((x) => x.id === firstId), 'the oldest entry was evicted');
  }

  // ── 6. ROUTES on BOTH surfaces: list parity, bytes parity, 400, 404, and upload→store wiring ──
  {
    clearDefaultLibrary();
    const { app, registry } = await buildTestApp(0x11, makeFakeFm3WithUpload(true));
    const router = createRouter({ registry, store: store.defaultStore });
    try {
      // 6a — empty library: app ↔ router body parity, scope line present
      const gl = await app.inject({ method: 'GET', url: '/cab/library' });
      const rl = await router.handle('GET', '/cab/library', undefined);
      assertEqual(gl.statusCode, 200, 'GET /cab/library → 200');
      assertEqual(rl.status, 200, 'router GET /cab/library → 200');
      assertEqual(rl.body, gl.payload, 'list body parity (app ↔ router)');
      const empty = JSON.parse(gl.payload) as cabLibrary.CabLibraryListResult;
      assertEqual(empty.total, 0, 'the library starts empty');
      assert(empty.scope.includes('uploaded through Axis'), 'the list names the honest scope');

      // 6b — upload→store wiring on BOTH surfaces: a verified upload leaves the bytes in the library
      const up = await app.inject({
        method: 'POST', url: '/cab/ir/upload?user=7&name=Wired',
        headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from(FIXTURE)
      });
      assertEqual(up.statusCode, 200, 'POST /cab/ir/upload → 200');
      assertEqual((JSON.parse(up.payload) as { ok: boolean }).ok, true, 'the upload reported ok');
      const afterUp = cabLibrary.listCabLibrary(store.defaultStore);
      assertEqual(afterUp.total, 1, 'the verified upload was persisted');
      assertEqual(afterUp.entries[0]!.user, 7, 'the destination user slot was recorded');
      assertEqual(afterUp.entries[0]!.name, 'Wired', 'the name as sent was recorded');
      const id = afterUp.entries[0]!.id;

      // 6c — list now shows it on both surfaces, identical
      const gl2 = await app.inject({ method: 'GET', url: '/cab/library' });
      const rl2 = await router.handle('GET', '/cab/library', undefined);
      assertEqual(rl2.body, gl2.payload, 'populated list body parity');
      assertEqual((JSON.parse(gl2.payload) as cabLibrary.CabLibraryListResult).entries[0]!.id, id, 'the new entry is listed');

      // 6d — bytes on both surfaces: 200 + identical raw bytes
      const gb = await app.inject({ method: 'GET', url: `/cab/library/${id}/bytes` });
      const rb = await router.handle('GET', `/cab/library/${id}/bytes`, undefined);
      assertEqual(gb.statusCode, 200, 'GET bytes → 200');
      assertEqual(rb.status, 200, 'router GET bytes → 200');
      assert(String(gb.headers['content-type']).includes('octet-stream'), 'app serves the bytes as octet-stream');
      assert(rb.body instanceof Uint8Array, 'router serves the bytes as a Uint8Array (octet)');
      assertEqual(Buffer.compare(Buffer.from(gb.rawPayload), Buffer.from(rb.body as Uint8Array)), 0, 'byte parity');
      assertEqual(gb.rawPayload.length, FIXTURE.length, 'the served bytes are the stored length');

      // 6e — malformed id: 400 on both surfaces, identical body
      const badA = await app.inject({ method: 'GET', url: '/cab/library/not-an-id/bytes' });
      const badR = await router.handle('GET', '/cab/library/not-an-id/bytes', undefined);
      assertEqual(badA.statusCode, 400, 'malformed id → 400 (app)');
      assertEqual(badR.status, 400, 'malformed id → 400 (router)');
      assertEqual(badR.body, badA.payload, 'the 400 body matches on both surfaces');

      // 6f — well-formed but unknown id: 404 on both surfaces, identical body
      const missA = await app.inject({ method: 'GET', url: '/cab/library/cab-1-aaaaaaaa/bytes' });
      const missR = await router.handle('GET', '/cab/library/cab-1-aaaaaaaa/bytes', undefined);
      assertEqual(missA.statusCode, 404, 'unknown id → 404 (app)');
      assertEqual(missR.status, 404, 'unknown id → 404 (router)');
      assertEqual(missR.body, missA.payload, 'the 404 body matches on both surfaces');

      // 6g — the list route is a plain READ: still served on a read-only server
      const { app: roApp } = await buildTestApp(0x11, makeFakeFm3WithUpload(true), { writes: false });
      const ro = await roApp.inject({ method: 'GET', url: '/cab/library' });
      assertEqual(ro.statusCode, 200, 'GET /cab/library is available on a read-only server');
      await roApp.close();
    } finally {
      await app.close();
      clearDefaultLibrary();
    }
  }

  // ── 7. a DISCARDED upload never persists (the unit rejected it; a later "move" must not resurrect it) ──
  {
    clearDefaultLibrary();
    const { app } = await buildTestApp(0x11, makeFakeFm3WithUpload(false));
    try {
      const up = await app.inject({
        method: 'POST', url: '/cab/ir/upload?user=9',
        headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from(FIXTURE)
      });
      assertEqual(up.statusCode, 200, 'the request itself is served');
      assertEqual((JSON.parse(up.payload) as { ok: boolean }).ok, false, 'the upload reported NOT ok');
      assertEqual(cabLibrary.listCabLibrary(store.defaultStore).total, 0, 'a discarded upload leaves the library empty');
    } finally {
      await app.close();
      clearDefaultLibrary();
    }
  }

  // ── 8. SURVIVES A RESTART: a fresh store over the SAME on-disk dir sees the bytes + metadata ──
  {
    const dir = mkdtempSync(join(tmpdir(), 'axis-cablib-'));
    try {
      const first = createStore(createFsStoreBackend(dir), nodeCodec);
      const e = cabLibrary.saveCabIr(first, { bytes: FIXTURE, name: 'Persist', page: 0x10, index: 5, user: 6 });
      // a brand-new store instance over the same directory — as a restart would build
      const reopened = createStore(createFsStoreBackend(dir), nodeCodec);
      const list = cabLibrary.listCabLibrary(reopened);
      assertEqual(list.total, 1, 'the entry survives a store re-open');
      assertEqual(list.entries[0]!.id, e.id, 'with the same id');
      const bytes = cabLibrary.readCabLibraryBytes(reopened, e.id);
      assertEqual(bytes?.length, FIXTURE.length, 'and its bytes come back at full length');
      assert(!!bytes && Buffer.compare(Buffer.from(bytes), Buffer.from(FIXTURE)) === 0, 'the bytes survive byte-identical');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ── 9. a RENAMED upload stores the bytes that LANDED (new name inside), on BOTH surfaces ──
  // Without this a library entry labelled "Renamed" held a container still named "Original", and a
  // restore-to-slot put the old name back on the unit.
  {
    const container = Uint8Array.from(
      buildCabIrContainerFromWords(0x11, { index: 0, page: 0x10 }, 'Original', Array.from({ length: CAB_IR_SAMPLE_SLOTS }, (_, i) => i))
    );
    clearDefaultLibrary();
    const { app, registry } = await buildTestApp(0x11, makeFakeFm3WithUpload(true));
    const router = createRouter({ registry, store: store.defaultStore });
    try {
      const up = await app.inject({
        method: 'POST', url: '/cab/ir/upload?user=3&name=Renamed',
        headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from(container)
      });
      assertEqual(up.statusCode, 200, 'app: POST /cab/ir/upload?name= → 200');
      const viaApp = cabLibrary.listCabLibrary(store.defaultStore).entries[0]!;
      const storedApp = cabLibrary.readCabLibraryBytes(store.defaultStore, viaApp.id)!;
      assertEqual(parseCabIrSyx(storedApp).name, 'Renamed', 'app: the STORED container carries the new name');
      assertEqual(viaApp.name, 'Renamed', 'app: and the entry label matches it');
      clearDefaultLibrary();
      const rr = await router.handle('POST', '/cab/ir/upload?user=3&name=Renamed', container);
      assertEqual(rr.status, 200, 'router: POST /cab/ir/upload?name= → 200');
      const viaRouter = cabLibrary.listCabLibrary(store.defaultStore).entries[0]!;
      const storedRouter = cabLibrary.readCabLibraryBytes(store.defaultStore, viaRouter.id)!;
      assertEqual(parseCabIrSyx(storedRouter).name, 'Renamed', 'router: the STORED container carries the new name');
      assertEqual(Buffer.compare(Buffer.from(storedApp), Buffer.from(storedRouter)), 0, 'both surfaces store identical bytes');
      assertEqual(viaApp.nameApplied, true, 'a rename that landed records nameApplied:true');
    } finally {
      await app.close();
      clearDefaultLibrary();
    }
  }

  // ── 10. FINDING #16 — a rename the codec CANNOT apply is RECORDED, not silently substituted. The bytes
  //        are still stored (the upload landed), but the entry carries nameApplied:false, and a move
  //        (findCabBySlot) refuses it, so bytes whose name could not be rewritten never reach a slot.
  //        FAILS BEFORE: `bytesAsLanded` returned the original bytes with NO record — a silent mismatch.
  {
    const { store: mem } = freshStore();
    const notAContainer = Uint8Array.from([0xf0, 0x00, 0x01, 0x74, 0x11, 0x0d, 0x01, 0x02, 0xf7]); // not a cab container
    const e = cabLibrary.saveCabIr(mem, { bytes: notAContainer, name: 'Wanted', page: 0x10, index: 4, user: 5 });
    assertEqual(e.nameApplied, false,
      'case 10: bytes the codec cannot rewrite with the name must record nameApplied:false');
    const listed = cabLibrary.listCabLibrary(mem).entries.find((x) => x.id === e.id)!;
    assertEqual(listed.nameApplied, false, 'case 10: the flag is SERVED on the list entry, not hidden');
    assertEqual(cabLibrary.findCabBySlot(mem, 0x10, 4), null,
      'case 10: a move must REFUSE an entry whose name could not be written');

    // Control 1: a real container renamed DOES apply, and the move accepts it.
    const container = Uint8Array.from(
      buildCabIrContainerFromWords(0x11, { index: 0, page: 0x10 }, 'Original', Array.from({ length: CAB_IR_SAMPLE_SLOTS }, (_, i) => i))
    );
    const renamed = cabLibrary.bytesAsLanded(container, 'Landed');
    const e2 = cabLibrary.saveCabIr(mem, { bytes: renamed, name: 'Landed', page: 0x10, index: 6, user: 7 });
    assertEqual(e2.nameApplied, true, 'case 10 (control): a rename that landed records nameApplied:true');
    assert(cabLibrary.findCabBySlot(mem, 0x10, 6) !== null,
      'case 10 (control): a move ACCEPTS a name-applied entry');

    // Control 2: no rename requested → vacuously applied.
    const e3 = cabLibrary.saveCabIr(mem, { bytes: notAContainer, name: '', page: 0x10, index: 8, user: 9 });
    assertEqual(e3.nameApplied, true, 'case 10 (control): no rename requested is vacuously nameApplied');
  }
}
