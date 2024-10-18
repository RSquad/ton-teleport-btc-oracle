FROM oven/bun:latest AS base

FROM base AS installer

WORKDIR /home
COPY . .

RUN bun install

FROM base AS builder

RUN apt-get update && \
    apt-get install -y curl build-essential && \
    rm -rf /var/lib/apt/lists/* && \
    curl https://sh.rustup.rs -sSf | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /home
COPY --from=installer ./home .

RUN bun run build:frost

FROM base AS runner

WORKDIR /home
RUN addgroup --system --gid 1001 runners && \
    adduser --system --uid 1001 --ingroup runners runner && \
    chown -R runner:runners /home
USER runner
COPY --from=builder ./home .

CMD bun start
