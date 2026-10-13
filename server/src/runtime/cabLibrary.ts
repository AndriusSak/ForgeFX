// Cab-IR byte library (§2.7) — the SERVER-SIDE store of the user-cab IR bytes this stack has uploaded.
//
// WHY: moving a user cab is a device-side NO-OP; the only way is re-uploading the IR's BYTES to the
// destination and erasing the source. Today those bytes live only in the file the user picked in the
// browser, so once an IR is on the unit the stack cannot move/restore/re-upload it without the user
// re-finding that file. Persisting the bytes at upload time makes a move a first-class action.
//
// SCOPE, STATED PLAINLY: there is NO device slot-data read on this firmware, so the library can only
// ever contain IRs that were uploaded THROUGH this stack. IRs that were already on the unit (e.g. a
// pre-loaded "Res Psycho" set) CANNOT be captured. Every consumer MUST say "IRs uploaded through
// Axis", never "your cab library" / "all your IRs" — a library that silently looks complete when it
// is not is the failure mode this module exists to avoid (see CAB_LIBRARY_SCOPE).
//
// STORAGE: no database, no cloud, no new dependency. Metadata entries are ordinary store documents
// (one per entry, collection `cabLibrary`) so on Node they land in the fs backend's `store/cabLibrary
// .json` — a JSON index; the bytes are content-addressed blobs (`cab-<sha256>`) in the SAME blob
// directory the preset versions use, so identical bytes are stored once and the map stays small.
//
// RESILIENCE: a malformed / partial entry is SKIPPED and counted (`skipped`) — never thrown out of —
// and an entry whose blob is missing is listed with `available:false` rather than crashing a read.
//
// BROWSER-SAFE: type-only store import, NO node:/fastify imports — this module is in the runtime
// router's import graph (check-browser-safe.ts enforces it). All persistence goes through the
// injected Store, so the browser runtime's own store backs browser-direct mode identically.
import { renameCabIrSyx, parseCabIrSyx } from 'forgefx-midi/devices/gen3';
import type { Store } from './store.js';
import type { Doc } from './storeBackend.js';

/** The one collection the library index lives in. */
export const CAB_LIBRARY_COLLECTION = 'cabLibrary';

/**
 * GROWTH CAP (documented): at most this many entries are kept. User cab slots number 512, but each
 * stored IR is a real ~20 KB container, so an unbounded library would grow without limit; 200 covers
 * a heavy moving/restoring workflow many times over. When the cap is exceeded the OLDEST entries are
 * evicted (and their blob deleted once no surviving entry references that content). */
export const CAB_LIBRARY_MAX = 200;

/** The bytes blob key prefix — kept DISTINCT from the preset-version blobs (bare sha) so content
 *  addressing never collides across the two subsystems. */
const BLOB_PREFIX = 'cab-';

/**
 * The honest scope line EVERY consumer must carry (route response + UI). Do not paraphrase it into
 * "your cab library" — the library is incomplete BY CONSTRUCTION, and saying so is the requirement.
 */
export const CAB_LIBRARY_SCOPE =
  'IRs uploaded through Axis. Slots that already held an IR when the stack first saw the unit are not captured — the firmware has no slot-samples read.';

/** One stored IR. `page`/`index` are the 0x7A destination fields; `user` is the 1..512 convenience
 *  slot when the upload named one, else null. `sha256` is the content address (the blob key). */
export interface CabLibraryEntry {
  id: string;
  /** The name AS SENT in the container (a rename is part of the bytes, so it differs per entry). */
  name: string;
  /** Destination page (0x10–0x13 = the 512 user banks). */
  page: number;
  /** Destination index within the page (0–127). */
  index: number;
  /** 1..512 user slot if the upload used ?user=, else null. */
  user: number | null;
  /** Container size in bytes. */
  length: number;
  /** sha256 of the container bytes — the content-address key. */
  sha256: string;
  /**
   * Whether the STORED container's own name equals the entry's `name` label. `true` when no rename was
   * requested, or when the codec's rename landed. `false` means the container's bytes and its name
   * DISAGREE (the codec could not parse/rewrite them): the bytes were stored as received under a name
   * they do not carry. Such an entry is STILL stored — but flagged, so a later move/restore can refuse to
   * act on bytes whose name could not be rewritten (see `findCabBySlot`). A silent substitution — the old
   * `bytesAsLanded` behaviour of returning the original bytes with no record — is what this field removes.
   */
  nameApplied: boolean;
  /** Epoch ms the entry was stored. */
  savedAt: number;
  source: 'upload';
}

/** An entry as listed: `available` is false when the index references a blob that is not on disk. */
export interface CabLibraryListEntry extends CabLibraryEntry {
  available: boolean;
}

export interface CabLibraryListResult {
  entries: CabLibraryListEntry[];
  total: number;
  /** Number of index records skipped because they were malformed / partial (never a crash). */
  skipped: number;
  cap: number;
  scope: string;
}

/** Entry id shape: `cab-<base36 time>-<sha8>`. Used by the bytes route to 400 a malformed id. */
const ID_RE = /^cab-[0-9a-z]{1,13}-[0-9a-f]{8}$/;
export function isCabLibraryId(id: string): boolean {
  return typeof id === 'string' && ID_RE.test(id);
}

/** The 1..512 user slot for a destination page/index, or null when it is not a user bank (page
 *  0x10–0x13 × 128). Mirrors the codec's `cabIrUserSlot` inverse without pulling the codec in. */
export function userSlotForDestination(page: number, index: number): number | null {
  if (page >= 0x10 && page <= 0x13 && index >= 0 && index <= 127) return (page - 0x10) * 128 + index + 1;
  return null;
}

const blobKey = (sha256: string): string => `${BLOB_PREFIX}${sha256}`;

/** Structural validation of a stored entry — a doc failing this is skipped and counted, not trusted. */
function asEntry(data: unknown): CabLibraryEntry | null {
  if (!data || typeof data !== 'object') return null;
  const e = data as Record<string, unknown>;
  if (typeof e.id !== 'string' || !isCabLibraryId(e.id)) return null;
  if (typeof e.name !== 'string') return null;
  if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) return null;
  if (!Number.isInteger(e.page) || !Number.isInteger(e.index)) return null;
  if (typeof e.length !== 'number' || !Number.isFinite(e.length) || e.length < 0) return null;
  if (typeof e.savedAt !== 'number' || !Number.isFinite(e.savedAt)) return null;
  return {
    id: e.id,
    name: e.name,
    page: e.page as number,
    index: e.index as number,
    user: Number.isInteger(e.user) ? (e.user as number) : null,
    length: e.length as number,
    sha256: e.sha256,
    // Older docs predate the field; only an explicit `false` records a failed rename, so a missing value
    // reads as applied (a rename that was not requested is vacuously applied).
    nameApplied: e.nameApplied !== false,
    savedAt: e.savedAt,
    source: 'upload'
  };
}

function entryId(savedAt: number, page: number, index: number, sha256: string): string {
  // `cab-<time><page><index>-<sha8>`: the destination is baked into the id so two DIFFERENT slots
  // receiving identical bytes in the same millisecond can never collide onto one id (a same-slot,
  // same-content re-upload is de-duplicated before this is reached).
  return `cab-${savedAt.toString(36)}${page.toString(36)}${index.toString(36)}-${sha256.slice(0, 8)}`;
}

/** Evict the oldest entries past the cap, deleting a blob only once no surviving entry references it. */
function prune(store: Store, all: CabLibraryEntry[]): void {
  if (all.length <= CAB_LIBRARY_MAX) return;
  const sorted = [...all].sort((a, b) => a.savedAt - b.savedAt); // oldest first
  const drop = sorted.slice(0, all.length - CAB_LIBRARY_MAX);
  const kept = sorted.slice(all.length - CAB_LIBRARY_MAX);
  const keepShas = new Set(kept.map((e) => e.sha256));
  for (const e of drop) {
    store.delDoc(CAB_LIBRARY_COLLECTION, e.id);
    if (!keepShas.has(e.sha256)) store.deleteBlob(blobKey(e.sha256));
  }
}

/**
 * Persist the bytes of a just-accepted upload. Returns the stored entry. Identical content to the
 * SAME destination is de-duplicated (the existing entry's name + savedAt are refreshed instead of
 * appending a duplicate); identical content to a different destination is a separate entry.
 */
export function saveCabIr(
  store: Store,
  input: { bytes: Uint8Array; name: string; page: number; index: number; user: number | null }
): CabLibraryEntry {
  const sha256 = store.sha256Hex(input.bytes);
  if (!store.hasBlob(blobKey(sha256))) store.putBlob(blobKey(sha256), input.bytes);

  // Record whether the bytes ABOUT TO BE STORED actually carry the requested name. `bytesAsLanded` renames
  // best-effort; this is the AUTHORITY — it re-reads the container and records the outcome, so a rename
  // that could not be applied is visible on the entry instead of silently substituted.
  const nameApplied = input.name === '' || containerNameIs(input.bytes, input.name);

  const existing = listCabLibrary(store).entries.find(
    (e) => e.sha256 === sha256 && e.page === input.page && e.index === input.index
  );
  const savedAt = Date.now();
  const entry: CabLibraryEntry = existing
    ? { ...existing, name: input.name, user: input.user, length: input.bytes.length, nameApplied, savedAt }
    : {
        id: entryId(savedAt, input.page, input.index, sha256),
        name: input.name,
        page: input.page,
        index: input.index,
        user: input.user,
        length: input.bytes.length,
        sha256,
        nameApplied,
        savedAt,
        source: 'upload'
      };
  store.putDoc(CAB_LIBRARY_COLLECTION, entry.id, entry);
  prune(store, listCabLibrary(store).entries);
  return entry;
}

/** List the library, newest first. Malformed records are skipped and counted; never throws. */
export function listCabLibrary(store: Store): CabLibraryListResult {
  const entries: CabLibraryListEntry[] = [];
  let skipped = 0;
  for (const d of store.listDocs(CAB_LIBRARY_COLLECTION)) {
    const e = asEntry(d.data);
    if (!e) {
      skipped++;
      continue;
    }
    entries.push({ ...e, available: store.hasBlob(blobKey(e.sha256)) });
  }
  entries.sort((a, b) => b.savedAt - a.savedAt);
  return { entries, total: entries.length, skipped, cap: CAB_LIBRARY_MAX, scope: CAB_LIBRARY_SCOPE };
}

/** The stored bytes of one entry, or null when the entry is unknown / its blob is missing. */
export function readCabLibraryBytes(store: Store, id: string): Uint8Array | null {
  if (!isCabLibraryId(id)) return null;
  const doc: Doc | null = store.getDoc(CAB_LIBRARY_COLLECTION, id);
  const e = doc ? asEntry(doc.data) : null;
  if (!e) return null;
  return store.getBlob(blobKey(e.sha256));
}

/**
 * The newest USABLE stored IR for a destination slot, or null. Used to prefer stored bytes for a move.
 * An entry whose bytes are gone (`available:false`) OR whose stored container does not carry the name it
 * is labelled with (`nameApplied:false` — a rename that could not be rewritten) is INELIGIBLE: a move
 * must never put bytes on a slot whose name disagrees with what the library claims.
 */
export function findCabBySlot(store: Store, page: number, index: number): CabLibraryEntry | null {
  const hit = listCabLibrary(store).entries.find(
    (e) => e.page === page && e.index === index && e.available && e.nameApplied
  );
  return hit ?? null;
}

/**
 * The bytes to PERSIST for an upload that asked for a rename (`?name=`).
 *
 * The driver applies the rename to what it SENDS, but the route only holds the bytes it RECEIVED — so
 * storing those would file the old container name inside a library entry labelled with the new one, and a
 * later restore-to-slot would put the OLD name back on the unit. Apply the same codec rename here so the
 * stored container is the one that actually landed.
 *
 * BEST-EFFORT, and NOT the authority: a body the codec cannot parse/rewrite is returned UNCHANGED, and
 * whether that happened is recorded by `saveCabIr` on the entry (`nameApplied`), which re-reads the bytes
 * it is about to store. A rename that could not be applied therefore never becomes a silent substitution —
 * the entry is flagged and `findCabBySlot` refuses to move it. (This function returning the original bytes
 * on failure used to be stored with no record at all, i.e. a slot's bytes silently disagreeing with its
 * name — review finding #16.)
 */
export function bytesAsLanded(bytes: Uint8Array, name: string | null | undefined): Uint8Array {
  if (name == null || name === '') return bytes;
  try {
    return Uint8Array.from(renameCabIrSyx(bytes, name));
  } catch {
    return bytes;
  }
}

/** Does the container carry `name` as its own stored name? `false` for bytes the codec cannot parse. */
function containerNameIs(bytes: Uint8Array, name: string): boolean {
  try {
    return parseCabIrSyx(bytes).name === name;
  } catch {
    return false;
  }
}
