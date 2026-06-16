FROM oven/bun:1-slim

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --production

COPY . .
RUN openqueue build

EXPOSE 8090
CMD ["openqueue", "start", "--env-file", ".env"]
