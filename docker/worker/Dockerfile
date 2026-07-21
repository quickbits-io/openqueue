FROM oven/bun:1-slim

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --production

COPY . .
# `openqueue build` compiles the worker into a Nitro node-server bundle at
# `.output`; `openqueue start` runs it (falling back to source if absent). To run
# the artifact on Node instead of Bun, see the multi-stage recipe in the
# deployment docs (build under Bun, copy `.output` into a slim node image).
RUN openqueue build

EXPOSE 8090
CMD ["openqueue", "start", "--env-file", ".env"]
