FROM oven/bun:1.4-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY src ./src
RUN mkdir /data && chown bun:bun /data
USER bun
ENV DATABASE_URL=sqlite:///data/aikatsu-sync.db PORT=3000
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:${PORT}/health || exit 1
CMD ["bun", "src/index.ts"]
