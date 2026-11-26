#!/usr/bin/env bash
# Deploys the PCBL field server on the automation server (run by GitHub Actions, or by hand from the repo root).
# Build + tests first while the old one keeps running -> swap -> health check -> roll back if unhealthy.
# Submissions are kept in the Docker volume "pcbl-field-data", so they survive every deploy.
set -uo pipefail
NAME=pcbl-field-server
ENV_FILE=${ENV_FILE:-/etc/pcbl-field/server.env}
BIND=${BIND:-127.0.0.1}          # 127.0.0.1 = only via HTTPS proxy/tunnel; 0.0.0.0 = open on the public IP (testing only)
HOST_PORT=${HOST_PORT:-8090}
SHA=${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || date +%s)}
TAG=$NAME:${SHA:0:7}
fail() { echo "!!! $*"; exit 1; }

[ -r "$ENV_FILE" ] || fail "Settings file $ENV_FILE is missing or not readable by $(whoami)."
grep -qE '^API_KEY=.{16,}' "$ENV_FILE" || fail "Set API_KEY (16+ characters) in $ENV_FILE."

echo ">>> Building $TAG"
docker build --pull -f server/Dockerfile -t "$TAG" -t "$NAME:latest" . || fail "Build or tests failed - running server not touched."

docker rm -f "${NAME}_old" >/dev/null 2>&1 || true
if docker inspect "$NAME" >/dev/null 2>&1; then docker stop -t 30 "$NAME" >/dev/null; docker rename "$NAME" "${NAME}_old"; fi

rollback() {
  echo "!!! New version not healthy - restoring the previous one"
  docker logs --tail 40 "$NAME" 2>&1 || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker inspect "${NAME}_old" >/dev/null 2>&1 && docker rename "${NAME}_old" "$NAME" && docker start "$NAME" >/dev/null
  exit 1
}

docker run -d --name "$NAME" --restart unless-stopped --env-file "$ENV_FILE" \
  -v pcbl-field-data:/data -p "$BIND:$HOST_PORT:8090" \
  --log-opt max-size=10m --log-opt max-file=5 "$TAG" >/dev/null || rollback

for i in $(seq 1 15); do
  sleep 2
  if curl -fs "http://127.0.0.1:$HOST_PORT/healthz" >/dev/null; then
    echo ">>> Deployed $TAG - healthy: $(curl -s http://127.0.0.1:$HOST_PORT/healthz)"
    docker rm -f "${NAME}_old" >/dev/null 2>&1 || true
    docker images "$NAME" --format '{{.Tag}} {{.ID}}' | grep -v '^latest ' | tail -n +4 | awk '{print $2}' | xargs -r docker rmi >/dev/null 2>&1 || true
    exit 0
  fi
done
rollback
