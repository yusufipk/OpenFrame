# Export comments to an editor

Open a video version, choose **Download comments**, then **DaVinci Resolve (EDL)** or
**Adobe Premiere (XML)**. CSV and PDF are still available,
including for images: the CSV opens in Excel with readable columns and UTF-8 text, and
the PDF lists each thread with its time, tag and status.
NLE exports require an authenticated account with access to the video. The resolved
filter behaves like CSV/PDF: hidden resolved root comments are excluded; replies to
included roots remain included, even if a reply is resolved.

Choose the frame rate of the target timeline and its start timecode. OpenFrame stores
comment times as seconds relative to the reviewed video, so these settings must match
the edit that produced that video. For example, a comment at one second with a
`01:00:00:00` origin on a 24 fps timeline becomes `01:00:01:00`.

- Fractional rates use exact `24000/1001`, `30000/1001`, and `60000/1001` ratios;
  23.976, 29.97 and 59.94 are display labels only. Other supported rates are 24, 25,
  30, 48, 50 and 60 fps. Times round to the nearest frame, with half frames rounded up.
- Drop-frame numbering is available only at 30000/1001 and 60000/1001 fps. Use a
  semicolon before frames for DF (`01:00:00;00`), a colon for NDF (`01:00:00:00`).
  Skipped DF labels are rejected. DF changes timecode numbering, not playback speed.
- Exports reject invalid ranges or a timeline reaching 24 hours instead of wrapping
  markers into an earlier day. Point comments occupy one frame; ranges use the rounded
  end, extended to at least one frame.
- Multiple comments and replies that round to the same frame share one marker whose
  range covers their longest range. Marker text is plain text an editor can read:
  `Author [Tag] (resolved): comment`, with each reply listed under the comment it
  answers. Voice notes, images and drawings are named but not embedded. No comment
  text is truncated, except the short XML marker name; the XML comment holds it all.
- In XML the marker comment keeps line breaks and indents replies. EDL marker text is
  a single line: comments are separated by slashes, line breaks become spaces, `|`
  becomes `¦` so it cannot start a directive, and emoji outside the Basic Multilingual Plane (most of them) are dropped because Resolve
  garbles them when it reads an EDL.
- A marker takes the color of its first comment's tag, falling back to the colors
  the OpenFrame player uses (cyan, or green when resolved). Tag colors are matched by
  hue to Resolve's marker palette (EDL) and Premiere's (`pproColor` in XML), so a
  custom tag color lands on the nearest named color. Resolve 20.3 ignores marker
  colors in XML and shows those markers blue; import the EDL to get colors there.
- NLE exports preserve every reply depth and actual parent ID; the resolved filter applies to the thread root. To bound memory, NLE exports enforce a 5,000-comment limit for the whole version before filtering. CSV/PDF retain their existing root/direct-reply layout and filtered limit. EDL also refuses more than 999 distinct
  marker frames. Use XML or CSV when an EDL would exceed that event limit.

## Import and compatibility

In Resolve, use **Timelines → Import → Timeline Markers from EDL** on the target timeline
in the Media Pool. Match the timeline frame rate, start timecode and DF/NDF setting.
Do not use the general EDL timeline/conform importer for this marker file.

In Premiere, use **File → Import** for the `.xml` file. This is FCP7 `xmeml` version 5,
which describes a separate sequence containing sequence markers and no linked media.
It does not insert markers directly into an existing sequence. To move them into your
edit, turn on **Markers → Copy Paste Includes Sequence Markers**, put an adjustment
layer across the imported sequence, copy it, and paste it at the start of your own
sequence; the markers come with it. The sequence uses placeholder 1920×1080
square-pixel progressive video settings. No media files or external URLs are referenced.

Checked by hand in DaVinci Resolve Studio 20.3: a 29.97 DF marker EDL imported
through Timeline Markers from EDL, and 23.976 NDF and 59.94 DF XML files (one starting
at `00:59:59;58`) imported as timelines, all landed on the exact expected frames and
durations. Premiere XML import has **not** been tested, and neither has the Premiere
copy-paste route above. Before relying on a file for a live edit, import it into
a copy and check marker positions, colors and text. This feature exports from OpenFrame
for import into editors; it does not import editor files back into OpenFrame.

### Editor plugins

Two plugins write the markers straight into the timeline the editor has open, at its
own frame rate, with no file and no separate sequence: a UXP panel for Premiere and a
Lua script for Resolve. On a project's video page the comments menu offers **Premiere
Pro: add to timeline** and **DaVinci Resolve: add to timeline**; the dialog downloads
the plugin, copies the video link and creates a token with only the **Read** and
**Read comments** permissions. `/guides/editor-markers` is the public setup guide with
screenshots. `GET /api/integrations/premiere-panel` (a `.ccx`, built as a stored ZIP of
the folder) and `GET /api/integrations/resolve-script` serve the files to anyone; they
hold no secrets. Both plugins leave resolved comments out unless asked and remember
the choice, so a re-sync also clears markers of comments resolved since.

### Premiere panel

`integrations/premiere-panel/` needs Premiere 25.6 or later. Double-clicking the `.ccx`
opens Creative Cloud, which installs it after a warning about unverified plugins; it
then sits under **Window → UXP Plugins → OpenFrame Comments**. Creative Cloud refuses
it when Premiere was not installed through Creative Cloud.

Paste a video page address and an API token with the **Read** and **Read comments**
permissions, load the versions, pick one and add the comments. Running it again for the
same version replaces the markers it wrote before and leaves every other marker alone;
it recognizes its own by the `[OpenFrame <version id>]` line at the end of the marker
comment. Colors use Premiere's seven named marker colors: violet and pink tags become
magenta, and gray tags keep Premiere's default color, which can look like the green of
a resolved comment. New markers are added before the old ones are removed, so a step
Premiere refuses never leaves fewer markers than before. Each step is its own undo:
a first sync of up to 50 markers undoes in two (add, color), a later one in three
(add, remove the old ones, color).

The panel may reach any server, since OpenFrame can be self-hosted, so the token is
bound to one: it is kept in UXP secure storage under the server's origin and filled in
only for a link to that same server. Plain `http` links are accepted only for localhost
and private network addresses.

Checked by hand in Premiere 26.0 on Windows with a 23.976 fps sequence: eight markers
landed on the expected frames and durations with the expected colors (magenta shows as
Premiere's lilac), thread text and Turkish letters came through, a second sync replaced
them instead of doubling them, a marker added by hand survived it, and in a sequence
starting at `01:00:00:00` the markers counted from that start. The same seven markers
also landed on the expected frames at 25, 29.97 DF and 59.94 DF, including past the
first minute and the first ten minutes. macOS has not been tried.

### Resolve script

`integrations/resolve/OpenFrame Comments.lua` goes into Resolve's
`Fusion/Scripts/Utility` folder and runs from **Workspace → Scripts**. It uses Resolve's
own Lua (no Python install) and `curl` for HTTPS, with the token in a temporary header
file so it never shows on a command line. Markers are added with
`Timeline:AddMarker(frame, color, name, note, duration, customData)`; the custom data
`openframe:<version id>` is how a re-sync finds and deletes its own markers, so the
marker text carries no tag. A marker owns its frame in Resolve, so a comment landing
on a frame that already has one of the editor's markers is skipped and counted. The
link, the include-resolved choice and one token per server are kept in
`%APPDATA%\OpenFrame-resolve.txt` or `~/.openframe-resolve` (mode 600). The helpers are
unit-tested through fengari, which is Lua 5.3; Resolve runs LuaJIT, so the script
avoids 5.3-only syntax and library calls.

Checked by hand in Resolve Studio 20 on Linux with 23.976, 29.97 DF and 59.94 DF timelines: seven markers
with resolved comments left out, on the expected frames with the expected colors
(orange tags show as yellow, Resolve has no orange), the thread in the notes, and a
second sync replacing them. The free edition of Resolve and Windows and macOS have not
been tried.

References:

- [Apple FCP7 XML element catalog](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/FinalCutPro_XML/Elements/Elements.html)
- [Adobe FCP7 XML import workflow](https://helpx.adobe.com/ph_fil/premiere-pro/how-to/migrate-from-final-cut-pro.html)
- [Resolve marker EDL workflow](https://help.frame.io/en/articles/4128691-import-comments-into-resolve-with-edl)

## API

`GET /api/versions/{versionId}/comments/export` takes `format=csv|pdf|edl|xml|markers`.
The CSV columns are `#, Time, Author, Comment, Reply to, Tag, Status, Attachments,
Created, Comment ID, Parent comment ID` (no `Time` for images); a reply's `Status` is
its thread's, since only a root can be resolved. UTF-8 with a byte order
mark and CRLF line endings. NLE formats require all three timing parameters:

```text
?format=edl&fps=30000%2F1001&origin=01%3A00%3A00%3B00&dropFrame=true&includeResolved=false
```

`format=markers&fps=...` returns JSON for editor plugins: one entry per marker with
`startFrame`, `durationFrames`, `name`, `comments`, `color`, `premiereColor`, `done` and
`commentIds`, counted from the start of the video at that rate.

Invalid options or unsupported image exports return 400. Session authentication,
`comments:read` token scope, video access checks, the export rate limit and private
no-store responses apply to NLE exports too. XML downloads use
`application/xml`, EDL uses `text/plain`; all use UTF-8 and `Content-Disposition: attachment`.
