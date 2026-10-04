# An alternative client for MS OneNote

You might think that ntyonenote reads like anti-OneNote, but its just a coincidence, yeah..

What we really wanted to do here is to mock modern design and add win98 vibes into it with the help of [98.css](https://github.com/jdan/98.css)

So basically its something between anti- and ninety- one note :)

Markdown-only (plain text allowed ofc), not compatible with official client - it ruins our magic paragraph tags.

100% vibe-coded

## Before you try it

ntyonenote only works with OneNote sections whose name starts with `_md`
(e.g. `_md Notes`). Create one in the regular OneNote client first, then
edit its pages **only through ntyonenote**. Other sections are listed but read-only.

## Known gaps

- Editing `_md` pages in the official OneNote client is not supported:
  it splits our markdown paragraph on every line break, and those edits may be lost.
- Moving a page to another section gives it a new id, so ntyonenote treats it
  as a deleted page plus a new one; its history doesn't follow the move.
