# Export comments to an editor

Open a video version, choose **Download comments**, then **DaVinci Resolve (EDL)** or
**Adobe Premiere (XML)**. CSV and PDF are still available, including for images.
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
It does not insert markers directly into an existing sequence. The sequence uses
placeholder 1920×1080 square-pixel progressive video settings; adjust those settings
as needed for your edit. No media files or external URLs are referenced.

Checked by hand in DaVinci Resolve Studio 20.3: a 29.97 DF marker EDL imported
through Timeline Markers from EDL, and 23.976 NDF and 59.94 DF XML files (one starting
at `00:59:59;58`) imported as timelines, all landed on the exact expected frames and
durations. Premiere import has **not** been tested. Before relying on a file for a live
edit, import it into a copy and check marker positions, colors and text.

Final Cut Pro's modern FCPXML is a different format and is not included in this change;
its inclusion awaits confirmation of the requested editor. This feature exports from
OpenFrame for import into editors; it does not import editor files back into OpenFrame.

References:

- [Apple FCP7 XML element catalog](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/FinalCutPro_XML/Elements/Elements.html)
- [Adobe FCP7 XML import workflow](https://helpx.adobe.com/ph_fil/premiere-pro/how-to/migrate-from-final-cut-pro.html)
- [Resolve marker EDL workflow](https://help.frame.io/en/articles/4128691-import-comments-into-resolve-with-edl)

## API

`GET /api/versions/{versionId}/comments/export` keeps `format=csv|pdf` unchanged and
adds `format=edl|xml`. NLE formats require all three timing parameters:

```text
?format=edl&fps=30000%2F1001&origin=01%3A00%3A00%3B00&dropFrame=true&includeResolved=false
```

Invalid options or unsupported image exports return 400. Session authentication,
`comments:read` token scope, video access checks, the export rate limit and private
no-store responses apply to NLE exports too. XML downloads use `application/xml`, EDL
uses `text/plain`; both use UTF-8 and `Content-Disposition: attachment`.
