FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241

RUN groupadd --gid 1000 code \
    && useradd --uid 1000 --gid 1000 --no-create-home --home-dir /workspace --shell /bin/sh code \
    && mkdir -p /workspace \
    && chown code:code /workspace

COPY --chmod=0555 agent/target/x86_64-unknown-linux-musl/release/electrosphere-agent /usr/local/bin/electrosphere-agent

USER code:code
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/electrosphere-agent"]
