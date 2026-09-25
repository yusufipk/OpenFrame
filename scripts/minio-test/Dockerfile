# Test-only image. The official MinIO registries no longer allow anonymous pulls.
# Release assets and their SHA256 digests come from the minio/minio and minio/mc
# GitHub releases. Keep the server and client available in the same image.
FROM docker.io/library/debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS download

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) minio_sha=7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f; \
             mc_sha=01f866e9c5f9b87c2b09116fa5d7c06695b106242d829a8bb32990c00312e891 ;; \
      arm64) minio_sha=5c83cd2cf151717ba0243f73e1c7802ff36e272b67144bdd7f1f7d684fd6f03d; \
             mc_sha=14c8c9616cfce4636add161304353244e8de383b2e2752c0e9dad01d4c27c12c ;; \
      *) echo "Unsupported test image architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl --fail --location --retry 3 --proto '=https' --proto-redir '=https' \
      "https://github.com/minio/minio/releases/download/RELEASE.2025-09-07T16-13-09Z/minio.linux-${arch}.RELEASE.2025-09-07T16-13-09Z" \
      --output /usr/local/bin/minio; \
    curl --fail --location --retry 3 --proto '=https' --proto-redir '=https' \
      "https://github.com/minio/mc/releases/download/RELEASE.2025-08-13T08-35-41Z/mc.linux-${arch}.RELEASE.2025-08-13T08-35-41Z" \
      --output /usr/local/bin/mc; \
    printf '%s  %s\n' "$minio_sha" /usr/local/bin/minio "$mc_sha" /usr/local/bin/mc | sha256sum --check; \
    chmod 0755 /usr/local/bin/minio /usr/local/bin/mc

FROM docker.io/library/debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
COPY --from=download /usr/local/bin/minio /usr/local/bin/mc /usr/local/bin/
COPY --from=download /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
ENTRYPOINT ["minio"]
CMD ["server", "/data"]
