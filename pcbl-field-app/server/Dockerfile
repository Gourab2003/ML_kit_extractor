# PCBL field prototype server. Build from the repo root:  docker build -f server/Dockerfile .
FROM node:22-bookworm-slim
WORKDIR /srv
COPY app/src/engine ./app/src/engine
COPY server ./server
# The reading rules are shared with the phone app; their tests must pass or the image is not built.
RUN node --test app/src/engine/engine.test.ts
RUN mkdir -p /data && chown node:node /data
ENV DATA_DIR=/data PORT=8090 NODE_ENV=production
USER node
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8090/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/server.ts"]
