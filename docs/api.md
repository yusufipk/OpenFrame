# The OpenFrame API

A personal API token lets a script, a render machine or an AI agent (Claude Code, Codex and the like) work in OpenFrame without a browser: upload new versions, read and resolve comments, request approvals, share, download. On a paid plan or a trial, or as an editor on a team that has one, create one under **Settings → API Tokens** and tick the permissions it needs. It is shown once; store it like a password.

Send it on every call:

```
Authorization: Bearer of_pat_...
```

The API is the one the web app itself calls, so the routes under `app/api` are the reference, and every response is `{"data": ...}` or `{"error": "..."}`.

## Permissions

| Permission       | Opens                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `read`           | workspaces, projects, folders, videos, versions, subtitles, assets, search, and streaming the media they show |
| `upload`         | new videos and versions (including image reviews), assets, subtitles                                          |
| `manage`         | creating and editing workspaces, private projects and folders, project branding, renaming                     |
| `delete`         | deleting workspaces, projects, videos, versions, assets and subtitles                                         |
| `comments:read`  | comments, replies, attachment comments, tags, comment export                                                  |
| `comments:write` | adding, editing, resolving and deleting comments and tags                                                     |
| `approvals`      | approval candidates, requesting, deciding and cancelling approvals                                            |
| `share`          | share links, members, invitations and roles, project visibility and downloads, moving content                 |
| `download`       | the download endpoints: a version's file, an asset, a whole project                                           |

A token never goes beyond what you can do yourself: every call runs the same access checks as the browser, so a token of someone who can only comment on a project cannot delete its videos whatever permissions it carries, and removing you from a project takes it away from your tokens too. Anything that changes who can see content needs `share` even when it also looks like organising: making a project public or downloadable, and moving videos or folders, since what moves takes on the access of where it lands. `share` can invite someone as an admin or turn on downloads for a share link, which gives that person everything the other permissions guard, so treat a token with `share` like one with all of them. `approvals` lists the people who can approve, with their email addresses. A `read` token can already play and stream the media it shows, assets included, so leaving `download` off withholds the download endpoints, not the bytes. A `read` token gets videos without their comments; comments come with `comments:read`. Billing, settings, admin pages and token management are never reachable with a token. A wrong or revoked token gets a 401 and a token without the permission a route needs gets a 403; neither falls back to a signed-in browser session on the same machine. Uploads count against the workspace owner's storage exactly as browser uploads do.

A few calls to start with, all with the token header:

- `GET /api/projects`, then `GET /api/projects/{projectId}/videos`, then `GET /api/projects/{projectId}/videos/{videoId}/versions` to find the ids.
- `GET /api/versions/{versionId}/comments` to read a version's comments, `POST` there with `{"content", "timestamp"}` to add one, and `PATCH /api/comments/{commentId}` with `{"isResolved": true}` to resolve it.
- `POST /api/projects/{projectId}/videos` with `{"title", "videoUrl"}` to add a video from a link.

## Upload a new version (hosted OpenFrame)

The hosted instance stores video on Bunny Stream, which takes the file over the [tus](https://tus.io) protocol. `curl` is enough.

```bash
BASE=https://openframe.example.com    # your OpenFrame address
TOKEN=of_pat_...
PROJECT=...                           # from GET /api/projects
VIDEO=...                             # from GET /api/projects/$PROJECT/videos
FILE=cut-v4.mp4
SIZE=$(stat -c %s "$FILE")            # macOS: stat -f %z

# 1. Reserve the upload. Returns the tus credentials and the URLs to register.
INIT=$(curl -sf "$BASE/api/projects/$PROJECT/videos/bunny-init" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg v "$VIDEO" --arg t "$FILE" --arg s "$SIZE" \
        '{targetVideoId:$v, title:$t, sizeBytes:$s}')")
get() { printf '%s' "$INIT" | jq -r ".data.$1"; }

# 2. Create the tus upload, then send the bytes.
AUTH=(-H "AuthorizationSignature: $(get signature)" -H "AuthorizationExpire: $(get expirationTime)"
      -H "VideoId: $(get videoId)" -H "LibraryId: $(get libraryId)" -H 'Tus-Resumable: 1.0.0')
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
LOCATION=$(curl -sf -D - -o /dev/null -X POST https://video.bunnycdn.com/tusupload "${AUTH[@]}" \
  -H "Upload-Length: $SIZE" -H "Upload-Metadata: filetype $(b64 video/mp4),title $(b64 "$FILE")" | awk 'tolower($1)=="location:"{print $2}' | tr -d '\r')
case "$LOCATION" in http*) ;; *) LOCATION="https://video.bunnycdn.com$LOCATION" ;; esac
curl -sf -X PATCH "$LOCATION" "${AUTH[@]}" -H 'Upload-Offset: 0' \
  -H 'Content-Type: application/offset+octet-stream' -T "$FILE"

# 3. Register the version and make it the one reviewers see.
curl -sf "$BASE/api/projects/$PROJECT/videos/$VIDEO/versions" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg url "$(get videoUrl)" --arg thumb "$(get thumbnailUrl)" \
        --arg id "$(get videoId)" --arg tok "$(get uploadToken)" \
        '{videoUrl:$url, thumbnailUrl:(if $thumb=="null" then null else $thumb end), providerId:"bunny",
          providerVideoId:$id, uploadToken:$tok, versionLabel:"v4", setActive:true}')"
```

The tus credentials expire after an hour. If the upload fails after step 1, send `DELETE` to the same `bunny-init` path with `{"videoId": ..., "uploadToken": ...}` to give the reserved storage back. Bunny encodes the file after step 3, so the new version can take a few minutes to become playable.

## Upload a new version (S3/R2 self-hosted instances)

On an instance with `OPENFRAME_ENABLE_S3_VIDEO_UPLOADS=true`, the flow is the same shape. Leave out `targetVideoId` to start a new video instead, and finish it with `POST /api/projects/{projectId}/videos` rather than `.../versions`:

1. `POST /api/projects/{projectId}/videos/r2-init` with `{"targetVideoId", "fileName", "sizeBytes", "contentType"}`. Files under the multipart threshold get a `presignedPutUrl`; larger ones get `multipart.parts`, one presigned URL per part of `multipart.partSizeBytes`.
2. `PUT` the file to `presignedPutUrl` (with the same `Content-Type`), or each part to its URL, keeping every part's `ETag` response header. Also `PUT` a JPEG frame to `thumbnailPresignedPutUrl` (`Content-Type: image/jpeg`): the version always points at that object, so skipping it leaves a broken thumbnail.
3. Multipart only: `POST .../r2-complete` with `{"objectKey", "uploadToken", "parts": [{"partNumber", "etag"}]}`.
4. `POST .../videos/{videoId}/versions` with `{"videoUrl": proxyUrl, "providerId": "r2", "objectKey", "uploadToken", "versionLabel", "setActive": true}`.

## Letting an AI agent do it

Point the agent at this page and give it the token through an environment variable rather than pasting it into the chat, for example `OPENFRAME_TOKEN` in the shell it runs in. Give it only the permissions the job needs: an agent that uploads cuts needs `read` and `upload`, one that works through review notes also needs `comments:read` and `comments:write`, and `delete` and `share` are worth leaving off unless the job is exactly that.
