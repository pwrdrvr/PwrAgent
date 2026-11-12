#!/bin/sh
# Create the contained Outpost's network: an --internal Docker network with no
# route out, and one egress container that relays exactly two ports to the host.
#
# Usage: setup-network.sh
#   OUTPOST_INTERNAL_NETWORK  default pwragent-outpost-internal
#   OUTPOST_EGRESS            default pwragent-outpost-egress
#   OUTPOST_FEDERATION_PORT   default 47833 (host federation relay port)
#   OUTPOST_MODEL_PROXY_PORT  default 8787  (host model key proxy port)
#   OUTPOST_RELAY_IMAGE       default node:24-bookworm
#
# The egress relays the same port numbers to host.docker.internal. Start the
# host federation relay and the model key proxy on those ports first.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
net="${OUTPOST_INTERNAL_NETWORK:-pwragent-outpost-internal}"
egress="${OUTPOST_EGRESS:-pwragent-outpost-egress}"
fed="${OUTPOST_FEDERATION_PORT:-47833}"
proxy="${OUTPOST_MODEL_PROXY_PORT:-8787}"
image="${OUTPOST_RELAY_IMAGE:-node:24-bookworm}"
case "$fed$proxy" in *[!0-9]*) echo "ports must be numbers" >&2; exit 2;; esac

if ! docker network inspect "$net" >/dev/null 2>&1; then
  docker network create --internal "$net" >/dev/null
  echo "Created internal network $net"
fi
[ "$(docker network inspect -f '{{.Internal}}' "$net")" = true ] || {
  echo "$net exists but is not --internal; refusing to use it" >&2; exit 1;
}

if docker inspect "$egress" >/dev/null 2>&1; then
  echo "Egress container $egress already exists; remove it first to recreate it" >&2
else
  # The relay script is copied in, so the container does not depend on this checkout's path.
  docker create --name "$egress" --restart unless-stopped --cap-drop ALL \
    --security-opt no-new-privileges --add-host host.docker.internal:host-gateway \
    --entrypoint sh "$image" -c \
    "node /tcp-relay.mjs 0.0.0.0 $fed host.docker.internal $fed & node /tcp-relay.mjs 0.0.0.0 $proxy host.docker.internal $proxy & wait" >/dev/null
  docker cp "$here/tcp-relay.mjs" "$egress:/tcp-relay.mjs"
  docker network connect "$net" "$egress"
  docker start "$egress" >/dev/null
  echo "Started egress $egress: :$fed and :$proxy to the host"
fi
docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' "$net"
