# Live review

Live review follows one presenter on a fixed Bunny or R2 video version. Viewers join explicitly from the video page; sharing permissions still apply. Commenters can draw on a paused frame and save their own drawing as a timestamped comment. Managers can hand over presentation control and end the room. Calls remain in your existing meeting app. YouTube, playlists and frame-locked playback are not supported.

## Deployment

Run one live review service alongside the app and PostgreSQL. In `.env.docker`, set `OPENFRAME_ENABLE_LIVE_REVIEW=true`, a random `LIVE_REVIEW_SECRET` shared by the app and service, `LIVE_REVIEW_INTERNAL_URL=http://live-review:3101`, a public `wss://review.example.com/ws` URL in `LIVE_REVIEW_PUBLIC_URL`, and the exact browser app origin in `LIVE_REVIEW_ALLOWED_ORIGIN`. The service uses `LIVE_REVIEW_APP_URL` to reach the app internally; compose sets it to `http://app:3000`. Use a secret with at least 32 random bytes. The database URL must address PostgreSQL from inside both containers.

Apply database migrations before starting the service, then enable the `live-review` compose profile. Route the public WebSocket URL to port 3101 with WebSocket upgrades and long-lived connections enabled in your reverse proxy. Only `/ws` needs public exposure; `/health` and `/comments` are internal endpoints authenticated by the shared secret. `/api/internal/live-review/access` is also authenticated by that secret. Use HTTPS/WSS in production; plaintext WebSocket URLs are accepted on loopback for testing. Browser CSP permits only the configured WebSocket origin.

The feature defaults to disabled. A running service is required for room creation. Test a manager and a guest in separate browsers before enabling it for users, including your proxy's reconnect behavior. Repository tests do not verify a deployment's proxy configuration.

## Behavior and limits

Rooms allow up to 10 connected participants. A room keeps its selected version until it ends. Personal volume, quality, subtitles and fullscreen settings remain local. Browser autoplay restrictions can require each participant to click to enable playback. Buffering and connection loss are shown; synchronization depends on media seek accuracy and network conditions and is not a frame accuracy guarantee.

Drawings are temporary until saved as comments. Moving playback, ending a room or restarting the service can discard unsaved strokes. Saved comments remain in the normal review history. Missed comment notifications recover through polling or reconnect. Service restart restores a paused room from the last committed position; playback is checkpointed every five seconds while the database is healthy, so a crash can rewind to that checkpoint. It does not advance through downtime or replay queued commands. Losing the presenter pauses the room. A manager must assign presentation control when needed; guests are never automatically promoted to manager.

Run exactly one WebSocket service instance. Room presence and transient drawing state are process-local. Horizontal replication requires a shared room ownership and broadcast design. Access is periodically revalidated, including share expiry and revocation; connected clients may retain access until the next check, at most 15 seconds under a healthy service. Failed validation closes the connection.

## Verification

Use `bun run verify`, `bun run test:api` with the disposable test database, and `bun run test:e2e:live-review` for the dedicated two-browser suite. Run JavaScript commands inside the project's Podman test environment with dependencies in a container volume. The browser suite starts a production app and the real WebSocket service against test data. Repeat with `CI=true` to exercise CI server lifecycle rules.

The browser suite uses Chromium and a local native-video fixture. It checks playback progress and drift, checkpointing, drawing and saved comments, presenter handover, reconnect, guest permissions, revoked links, stale control epochs, duplicate commands, message-rate limits and mobile panel interaction. It does not certify production Bunny/R2 delivery, other browsers, proxy behavior, a 10-person load, slow-client backpressure or abrupt service-crash recovery. Validate those deployment conditions before a broad rollout; the local drift check is not a production latency guarantee.
