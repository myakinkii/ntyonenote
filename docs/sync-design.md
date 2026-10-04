# Sync design

How ntyonenote keeps pages locally in git and syncs them with OneNote.
Numbered so issues can point at a rule ("breaks S3.2").

## S1. Principles

1. **Local first.** Reading, editing, saving, creating, renaming and deleting pages work offline,
   against the local git repo. The network is only used by **Sync** and by opening a page whose
   content was never downloaded (S6).
2. **git does the work.** Content merging, conflict detection and history are plain git
   (isomorphic-git on lightning-fs / IndexedDB). No custom diffing.
3. **OneNote is the truth for what it holds.** We never sync history between clients; another
   client's edits arrive as one fetch, like a squash.
4. **Never match by name.** Pages are identified by ids only. Two pages with the same title are
   different pages.
5. **Only `_md` sections** are synced (known limitation: without one there is nothing to sync).

## S2. Repo layout

```
main      ledger.json                 OneNote metadata, exists ONLY on main
          <sectionId>/<pageId>.md     page content
onenote   <sectionId>/<pageId>.md     content exactly as last fetched from / sent to OneNote
```

1. Both branches start from one **empty** root commit, so they always have a merge base and
   `ledger.json` can never appear on `onenote`.
2. A page's file is named by its OneNote id. Pages created offline use `local-<uuid>` until
   their first upload (S5.2).
3. Titles are **not** in files: OneNote's title is a separate field, kept in the ledger.
4. The `onenote` branch never contains `main` as an ancestor; `main` merges `onenote` in.

## S3. Ledger (`ledger.json` on main)

```jsonc
{
  "connector": "onenote",
  "lastSync": "2026-10-04T12:00:00Z",
  "sections": { "<sectionId>": { "name": "_md TST", "notebook": "My Notebook", "deleted": true? } },
  "pages": {
    "<pageId>": {
      "section": "<sectionId>",
      "title": "local title",
      "remote": true,                 // the page exists in OneNote
      "remoteTitle": "...",           // OneNote's title as of the last fetch
      "modified": "...",              // the page's version as of the last listing (S10.4)
      "fetched": "...",               // version of the content on the onenote branch
      "createdAs": "local-...",       // id it had before its first upload
      "deleted": true                 // deleted here, to be deleted in OneNote on push
    }
  }
}
```

1. The ledger is the OneNote connector's artifact: another connector would have its own.
2. Only the local app writes it, so git never has to merge it.
3. A page is **downloaded** when its `.md` exists on `main`; otherwise only its metadata is local.
4. A page has **unsynced changes** when: it's not `remote` yet, its title differs from
   `remoteTitle`, its `.md` differs between `main` and `onenote`, or it's `deleted`.

## S4. Sync = fetch + merge + push (+ merge)

### S4.1 Fetch

1. List notebooks; every `_md` section is added to / updated in `sections`.
   A section missing from OneNote gets `deleted: true`: its pages stay locally until the user
   removes them (S7).
2. List **all** pages of each section (following paging, newest first).
3. For each listed page:
   - unknown → new entry, `title = remoteTitle = OneNote title`;
   - OneNote renamed it (`remoteTitle` differs) → `title = remoteTitle = OneNote title`.
     If it was renamed locally too, **OneNote wins** and the sync reports it;
   - content is downloaded when the page is on the `onenote` branch and `fetched` differs from
     its version, or when it's not downloaded yet but among the **20 most recent** pages of the
     section (prefetch). Others stay lazy (S6).
4. A known remote page missing from the listing is only treated as deleted after a direct
   request for it says 404 (listings can lag). Then its `.md` is removed from `onenote` and the
   entry becomes `remote: false`.
5. Downloaded content is committed on `onenote` ("Fetch"), the ledger on `main` ("Fetch").
6. `modified`/`fetched` are only ever written from OneNote's answers during fetch, never after
   our own upload, so a remote edit right after our upload can't be missed. The cost: the next
   sync downloads our own uploads once more and finds them identical.

### S4.2 Merge

`git merge onenote` into `main`, never fast-forward. Edits on different lines merge cleanly;
the same lines changed on both sides stop the sync with conflicts (S8). Nothing is uploaded then.

### S4.3 Push

1. Pages created offline: create in OneNote, then **immediately** commit the pure rename
   `local-x.md → <id>.md` plus its ledger entry (`createdAs: local-x`) on `main`, and the content
   on `onenote`. If the app or the network dies later, the page isn't created twice.
2. Changed content: `PATCH` the page, record the sent text on `onenote`.
   We trust the codec to store exactly what we sent (tabs are expanded before sending).
3. Renamed pages: `PATCH` the title, `remoteTitle = title`.
4. Deleted pages: delete in OneNote (404 counts as done), drop the entry.
5. Commit what was sent on `onenote` ("Push") and the ledger on `main`.

### S4.4 Merge after push

Merge `onenote` again, so what we pushed becomes the new merge base. Its content equals `main`'s,
so this merge never conflicts.

## S5. Local operations (offline)

1. **Save**: commit the `.md` on `main`.
2. **New page**: `local-<uuid>.md` + ledger entry with `remote: false`.
3. **Rename**: commit the ledger entry's `title`.
4. **Delete**: remove the `.md`; a remote page gets `deleted: true` until pushed, a local-only
   page's entry is dropped.
5. Rename/New/Delete are blocked while a merge is unresolved.

## S6. Lazy pages

1. Pages not prefetched show in the list with metadata only (☁️).
2. Opening one while online downloads it: content committed on `onenote`, `fetched` on `main`,
   then merged, which creates the `.md` on `main`. Offline it can't be opened yet.

## S7. Deleted sections

A section deleted in OneNote stays in the tree as "deleted in OneNote" with all its local pages
until the user removes the local copy. That removes its files from both branches and its
entries from the ledger.

## S8. Conflicts

1. Only page content conflicts. Titles never do (OneNote wins, S4.1.3); the ledger never does (S3.2).
2. Conflicts leave git markers in the worktree; the user keeps a side or edits the markers, then
   finishes the merge. The next Sync pushes the result.
3. A page deleted in OneNote but edited locally is a conflict too; keeping it turns it into a
   local page that is created again on the next push.

## S9. History tab

1. The commits on `main`'s first-parent line that changed the page's `.md` or its ledger entry.
2. It follows `createdAs`, so a page created offline keeps its history from before the upload.
3. Each row shows where it came from: 💻 local (Save/New/Rename/Delete/Restore),
   ☁️ OneNote (sync commits), 🔀 merge.

## S10. Known gaps

1. Pages moved to another section in OneNote get a new id: deleted + new page, history doesn't
   follow.
2. If OneNote ever stores text differently from what we sent, the next fetch brings back the
   difference and it may conflict with local edits (we rely on the codec, S4.3.2).
3. Unsynced local commits can be lost if iOS evicts the app's storage; the last synced state can
   always be fetched again.
4. OneNote's `lastModifiedDateTime` doesn't move when a page is edited, not even in the OneNote
   app (https://learn.microsoft.com/en-us/answers/questions/5908957). So every upload, content
   write and rename stamps the title with a version marker, `#<ISO time># Title`, which the
   listing exposes. The connector strips it, so titles in the ledger and UI never contain it.
   Leading the title, it makes `$orderby=title desc` list stamped pages newest first; the
   connector also sorts by version, since the listing is complete anyway and unstamped pages
   (falling back to `lastModifiedDateTime`) would otherwise sort by name. Edits made outside
   ntyonenote don't change the marker and stay unnoticed (they break the magic paragraph anyway).
