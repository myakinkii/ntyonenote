# Convert design

How ntyonenote converts a regular OneNote section into an `_md` mirror, so all notes end up as
markdown and can leave OneNote for good once a git connector exists.
Numbered like `sync-design.md` ("breaks C5.4"); `S` rules refer to that doc.

The way out of OneNote:

1. **Convert** each regular section into an `_md` mirror (C5). The original stays untouched.
2. **Check** the warnings (C8) and fix pages in the editor, then Sync as usual.
3. **Push** everything with the git connector (C10). Then OneNote can be archived or deleted.

## C1. Principles

1. **One-time exit, safe to repeat.** Converting is meant to be done once per section, but
   running it again is safe: it resumes, adds what's missing and merges what changed (C6).
2. **The source is read-only.** Converting never writes to the source section. All writes go to
   the mirror.
3. **The result is an ordinary `_md` section.** After conversion, everything is plain sync
   (S4): other devices get the mirror with their next Sync, no conversion needed there.
4. **git does the work.** Converting again merges into local edits exactly like a fetch (S4.2).
5. **Honest about loss.** What the converter can't carry over is written into the page (C8).

## C2. Mirror section

1. The mirror is created in the source's notebook, named `_md <source name>`, shortened to
   OneNote's 50 characters, with `\ / * ? " | < > : % # &` replaced by `-`. If the name is taken,
   ` (2)`, ` (3)`, ... is appended.
2. Its ledger entry records the source and a mapping of all converted pages (C3).
3. Converting a section that already has a mirror (a section whose `source.id` is that section)
   reuses it, even if the mirror was renamed since.

## C3. Ledger

```jsonc
"sections": {
  "<mirrorSectionId>": {
    "name": "_md Recipes", "notebook": "My Notebook",
    "source": {
      "id": "<sourceSectionId>",
      "name": "Recipes",
      "pages": { "<sourcePageId>": "<mirrorPageId>" }   // every page ever converted
    }
  }
},
"pages": {
  "<mirrorPageId>": { "...": "as in S3", "created": "2019-03-01T08:15:00Z" }  // source's createdDateTime
}
```

1. The mapping lives on the section, not on the pages: page entries are dropped when a page is
   deleted (S4.3.4), but the mapping keeps it, so a page deleted on purpose isn't recreated by
   converting again (C6.3).
2. `created` keeps the source page's `createdDateTime`, the one OneNote timestamp that works
   (S10.4). The mirror page's own creation time is just the conversion time.
3. The ledger is per device (S3.2), so only the device that converted a section knows the
   mapping. Other devices see the mirror as a plain `_md` section, and the app offers
   "Convert again" only where the mapping exists. Converting the same source on a second device
   would create a second mirror.

## C4. Repo layout

```
main      ledger.json
          <sectionId>/<pageId>.md      as in S2
onenote   <sectionId>/<pageId>.md      as in S2
import    <sectionId>/<pageId>.md      converter output of the last conversion, mirror paths
```

1. `import` starts from the same empty root commit (S2.1), lazily on the first conversion, and
   is never merged into anything. `main` merges it like `onenote`.
2. Its content is the merge base for converting again: local edits since the last conversion
   merge with converter changes, the same lines changed on both sides conflict (S8).
3. A pending merge records which branch it merges (`onenote` or `import`), so finishing it
   (S8.2) commits against the right one. The conflict indicator in the page list (⚠️) works as is.

## C5. Pipeline

Online only, one page at a time, for one section.

1. **List** all source pages (following paging), oldest first, so the mirror is filled in the
   original order.
2. **Skip** pages already in the mapping, except when converting again (C6).
3. **Read** the page's HTML (without `includeIDs`, so unchanged pages convert identically).
4. **Convert** it to markdown plus warnings (C7), and prepend the warnings comment (C8).
5. **Create** the page in the mirror (`createPage`, which stamps the title, S10.4), then commit
   **right away**, as in S4.3.1: the markdown on `import` and on `onenote` (what was sent), and
   on `main` together with the ledger entry and the mapping. All three branches agree, so
   nothing is left unsynced. The entry gets `fetched` as well as `modified`: the version marker
   is ours and unique, so the next fetch can skip the page (unlike S4.1.6, which predates S10.4).
   A create isn't retried on `5xx`, it may have gone through.
6. **Network rules.** On `429` wait `Retry-After`; on `5xx` back off and retry a few times, then
   record the page as failed and continue; on `401` pause until signed in; offline pauses.
7. **Progress and cancel.** A blocking dialog shows the page, "From X to _md X" and a progress
   bar. It blocks on purpose: the run holds the ledger in memory and commits it per page, so a
   save, rename or new page meanwhile would be overwritten. Stop finishes the current page and
   ends the run. Running it again resumes (C5.2).
8. **Summary.** "412 converted, 37 with warnings, 2 failed". Failed pages are listed with the
   reason and are retried by the next run.
9. **Merge.** At the end of a run that committed anything on `import`, `import` is merged into
   `main`. For new pages it's the same content, so it's clean; it's what makes `import` an
   ancestor of `main`, the merge base for converting again (C4.2). Updated pages merge for real
   (C6.2).

## C6. Converting again

The same pipeline, with these differences:

1. Mapped pages are read and converted again. If the output equals the page's file on `import`,
   nothing is committed. Otherwise it's committed on `import`.
2. After the run, `import` is merged into `main` once (C5.9). A clean merge leaves changes that
   the next Sync pushes (S4.3). Conflicts stop there and are resolved as in S8, with
   "🔄 Keep converted" instead of "☁️ Keep OneNote's".
3. A mirror page that no longer exists (deleted on purpose) is skipped and reported, not
   recreated: its mapping entry is kept (C3.1).
4. Source pages that appeared since are converted and created as in C5.
5. Source pages that are gone leave their mirror page alone, they're reported.
6. There's no change signal for source pages (S10.4), so converting again reads every page.
   Slow, but it's an exit tool, not a sync.

## C7. Converter

Input: one page's HTML. Output: markdown plus warning codes. Built on `DOMParser` (as
`codec.ts`, jsdom in tests), Turndown with the GFM plugin for the generic parts, custom rules for
OneNote's quirks.

1. **Deterministic.** The same HTML always gives the same markdown, byte for byte, otherwise
   converting again produces diffs without changes.
2. **Structure.**
   - The title comes from the listing, never from the body (S2.3).
   - Absolutely positioned `<div>` outlines are emitted in reading order (by `top`, then
     `left`), separated by a blank line.
   - Each `<p>` becomes its own paragraph; `<br>` becomes a hard break.
   - `h1`–`h6` become `#` headings; nested `ul`/`ol` become nested lists, keeping `start`.
   - `data-tag="to-do"` / `"to-do:completed"` become `- [ ]` / `- [x]`; other tags are dropped
     with a `tag` warning.
   - A page that already holds a magic paragraph is decoded with the existing codec instead.
3. **Inline formatting.** OneNote uses inline styles, not tags:
   - `font-weight:bold` → `**`, `font-style:italic` → `*`, `text-decoration:line-through` → `~~`.
   - A monospace `font-family` (Consolas, Courier New, monospace) on whole paragraphs becomes a
     fenced code block, on part of a line inline code.
   - Underline, colors, highlights, fonts and sizes are dropped silently.
   - `&nbsp;` becomes a space; runs of blank lines collapse into one.
   - Text is kept as typed, never escaped: old notes often contain markdown written by hand.
4. **Links.** `<a href>` becomes `[text](href)`. `onenote:` links stay as they are, with an
   `onenote-link` warning (C10.3).
5. **Tables.** Simple ones (no merged cells, no block content) become GFM tables, others stay as
   raw HTML with a `table` warning.
6. **Not converted.** Images, attachments and embeds become placeholders
   (`![alt](onenote-resource:<id>)`, `[📎 name](onenote-resource:<id>)`, `[embed](<url>)`) with
   an `image`, `attachment` or `embed` warning.
7. **Anything unknown** keeps its text content with an `unknown:<tag>` warning.
8. **Tests.** Golden files: real OneNote HTML in `src/graph/__tests__/fixtures` next to the
   expected markdown. Every converter fix adds a fixture.

## C8. Warnings comment

1. Pages with warnings start with one HTML comment:
   `<!-- ntyonenote convert: table kept as HTML (2), image not converted (1) -->`.
2. It's plain markdown content: visible in the editor, invisible when rendered, synced like
   any text. The user deletes it once the page is fixed, like any other edit.
3. Converting again doesn't bring a deleted comment back: the merge keeps the deletion (C4.2).
   If the warnings themselves changed, the comment line conflicts and the user picks a side.

## C9. History

1. Commits from `import` show up in the History tab (S9) with their own origin, 🔄 convert,
   next to 💻 local, ☁️ OneNote and 🔀 merge.

## C10. Handoff to the git connector

The git connector gets its own design. Converting commits to these constraints:

1. After conversion, all content lives in `_md` sections, so the git connector only has to
   handle those. Source sections are never read again unless the user converts again.
2. Everything git needs is derivable from `main`: notebook, section, title and `created` are in
   the ledger. A readable export tree (e.g. `Notebook/Section/Title.md`, sanitized, suffixes for
   duplicate titles, `created` as front matter) is the git connector's job.
3. The section mappings (C3) let it rewrite `onenote:` links (C7.4) into relative paths.
4. The app never deletes source sections. Removing them from OneNote is the user's call.

## C11. Changes to sync-design.md

1. S2: the `import` branch (C4).
2. S3: `source` on section entries, `created` on page entries (C3). Fetch (S4.1.1) keeps any
   other fields of a section entry, only `deleted` is cleared when a section is listed again.
3. S8.2: a pending merge records its branch (C4.3).
4. S9.3: the 🔄 convert origin (C9).

## C12. Known gaps

1. `notebooks()` doesn't expand section groups yet, so sections inside groups can't be
   converted until it does.
2. The mapping is per device (C3.3): converting the same source on two devices makes two mirrors.
3. If the app dies between creating a mirror page and committing it (C5.5), the next run
   creates the page again, as in S4.3.1.
4. Images, attachments, ink and audio aren't converted, only flagged (C7.6).
5. Password-protected sections can't be read through the API.
6. Formatting without a markdown equivalent is lost: layout positions, colors, fonts (C7.3).
7. Mirror pages are created now, so OneNote shows today's date on them; the original date is
   only in the ledger (C3.2).
8. There's no page list marker for pages with warnings yet: the comment is only visible in the
   editor (C8).
