# Flaxia Studio Linux image.
# Keep this image deliberately small: the WASI emulator is the bottleneck,
# not the compiler. build-essential + python3 + git cover the common cases.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      git \
      less \
      python3 \
      python3-pip \
      vim-tiny \
      procps \
 && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /workspace
WORKDIR /workspace

# c2w runs the container entrypoint. sh -c is the command-mode contract used
# by public/linux-runtime/worker.js.
ENTRYPOINT ["/bin/sh"]
CMD ["-i"]
