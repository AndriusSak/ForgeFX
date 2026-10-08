# Capture recipes — what to capture, and what each one closes

A capture is only worth taking if it answers a question that cannot be answered any other way. Each recipe
below names the open item it closes, the exact actions, and what "this capture is useless" looks like. Run

    cd ForgeFX/server && npx tsx scripts/analyze-cab-capture.ts <capture.pcapng>

on anything captured here: it names the function bytes and sub-actions that are **not** already mapped, and
every frame carrying readable text (a NAME looks exactly like that). It says **nothing new** in so many
words when the capture contains nothing new, so a wasted capture is obvious immediately instead of after an
afternoon of decoding.

---

## R1 — Manage Cabs: RENAME a user cab (and reorder one) — the cab fixture

**Closes:** §2.5c (does the wire ever carry a user-slot name / does FM3-Edit show names it can read) and the
cab **reorder** item. Both were narrowed to a single question that a capture answers decisively — *is there
a slot-data read?* Probing for one (`fn=0x7D/0x7E/0x7F/0x79`, and the `fn=0x01` sub-actions `0x4A`-`0x4E`)
found none, which is very likely deliberate: extractable user-IR data is exactly what protects commercial IR
vendors. If the editor CAN read a slot's data, this capture shows the opcode and the finding is corrected.

**THE 2-MINUTE QUESTION IS ANSWERED (2026-10-08): the editor DOES read names from the unit.**

The stack wrote a silent container named `LYKOS-NAMETEST` to `U0030` over the wire; FM3-Edit had never seen
the file; it displayed `LYKOS-NAMETEST`. So **a user-cab name is readable over the wire** — the path is simply
not one this stack has found. It is NOT the `0x4B` region: with two known plaintexts that region shows no
repeated values for a name with repeated letters, i.e. it is a hash-like fingerprint, not an encoding.

**A capture of the cab page showing the name was taken and it does NOT contain the name** (2026-10-08, checked
in 8 encodings with a validated tool — see below). `U0030` still holds `LYKOS-NAMETEST`, the editor displayed
it, and no frame in that capture carries it in ASCII, charset-index, 16-bit, high-bit or 5-septet-packed form.
**So the read happens OUTSIDE that window — it must be at CONNECT.**

**What R1 needs: capture the CONNECT, not the cab page.**

1. **Close FM3-Edit completely.**
2. Start the capture.
3. **Launch FM3-Edit** and let it connect to the unit.
4. Open the cab manager and let the USER bank fill in — slot 30's name is the one to look for.
5. Stop the capture.

At connect the editor must read everything it needs to paint that page, so the name read has to be in the
window. If it still is not, the answer is a different one and worth knowing: the editor keeps a **local
database** and the name for a stack-written cab comes from somewhere other than this unit — which would itself
be a finding, since the editor had never seen that file.

**Two tools for the fixture, both validated by a POSITIVE CONTROL before any negative is believed:**

- `npx tsx scripts/analyze-cab-capture.ts <cap>` — unmapped function bytes and sub-actions, frames carrying
  readable text. It immediately surfaced **`fn=0x01 sub=0x00`, `0x20`, `0x56` as previously unseen**, plus a
  **590-byte DUMP reply on `sub=0x2e`** (12 distinct payloads over 11 request/reply pairs) — all four still
  unmapped and worth decoding: a dump that size is a table.
- `npx tsx scripts/hunt-cab-name.ts <cap> [container.syx]` and `hunt-charset.ts <cap> TEXT` — hunt the name in
  8 encodings and name the carrier frame. **Always run the control first**: hunt for a string you know is in
  the capture (`HUNT_NAME="Jul 16 2026"` finds the firmware build date in the `fn=0x08` frame). A tool that
  cannot find a known string cannot be trusted to report an absence.

That distinction is why the refresh capture matters here: it contains **only `fn=0x01 sub=0x4B`** (1056
queries for 528 slots) and no other read at all, so whatever the editor displays for the cab list it gets
from that one reply — either by decoding the 15-byte region, or from a local cache it maintains itself.

**Prerequisites:** FM3 on the firmware the stack targets (13.0), FM3-Edit 1.07.16, the unit connected, and a
USB capture running (Windows: USBPcap + Wireshark. macOS: XHC20 + tcpdump. See the capture-shape note at the
bottom — the file must contain the FM3's USB device, not just any traffic.)

**Steps — start the capture FIRST, then touch the editor:**

1. Start capture.
2. Open FM3-Edit and let it connect. Open the cab manager (Manage Cabs / the cab browser).
3. **Wait ~5 s.** The editor's per-slot queries land here, which is how we learn which sub-action it uses to
   show names.
4. **Rename ONE user cab** you do not mind renaming (a user slot — factory cabs are presumably read-only):
   e.g. `U0002` → `ZZTEST`. Waiting 3 s after it.
5. **Rename it back.** Wait 2 s.
6. **Reorder one user cab** to a different slot, if the UI offers it. Wait 3 s.
7. Close the cab manager, stop the capture, export as `.pcapng`.

**Also worth reporting:** any FM3-Edit dialog or error text, and whether the unit's own front-panel display
changed during the rename (that is the independent-read question of §3.7 in the same motion).

**What it answers:**
- a **new function byte or sub-action** around the rename → the rename opcode, and therefore how a name is
  written (and possibly read);
- **a frame carrying readable text** → the name on the wire, with its encoding;
- **reorder** → either a device move/copy op, or the editor doing a read+write (which would mean a slot-data
  read exists after all, and the probe's negative result needs revisiting);
- if the analyser says **nothing new**, the rename is being done with opcodes already mapped — which is also
  an answer, and means the name question has to be settled another way.

**Known-good comparison:** the upload capture (`cab_upload.pcapng`, FM3-Edit 1.07.16 loading an IR onto fw
13.0) contains the `0x7A` + 8×`0x7B` + `0x7C` trio and the `fn=0x01 sub=0x4B` per-slot query — that file is
what "already mapped" looks like.

---

## Capture shape — what makes a capture usable

- **USBPcap on Windows / `XHC20` interface on macOS**, exported as `.pcapng`. Both are already supported by
  `scripts/scan-usb-capture.ts` (linktype 249 and the usbmon layouts).
- **The FM3 must be the device captured.** A capture of the wrong USB device yields zero SysEx frames and the
  analyser says so rather than reporting an empty result as a negative finding.
- **Do not trim it down** to the interesting moment: the surrounding poll traffic is what shows which
  opcodes belong together, and the per-slot queries at step 3 are half the value.
- **Same firmware + editor versions as the stack targets**, otherwise a new opcode may be a version artefact
  rather than the thing being looked for.
