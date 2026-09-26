FROM docker.io/library/alpine:3.22
WORKDIR /context
COPY . .
# Exercise the actual build context, not a second implementation of ignore rules.
RUN test -f package.json && test -f tsconfig.json && \
    for config in playwright*.config.ts; do \
      if [ -f "$config" ]; then \
        echo "Test configuration leaked into production build context: $config" >&2; \
        exit 1; \
      fi; \
    done
