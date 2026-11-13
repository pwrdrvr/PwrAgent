---
name: outpost-security-research
description: Set up and operate a contained PwrAgent Outpost in Docker for security research with models you do not trust. The container has no network; its Codex reaches only one model through a key proxy container, Docker Compose keeps it running, repositories move in and out by docker exec, and dependencies install offline. Use when asked to run research or abliterated models against code without network access, to add a model provider behind a key proxy, or to push a repository into an Outpost.
---

# Outpost Security Research

Run a model you do not trust against your own code, from your normal PwrAgent
window, in a container that can reach nothing except that model. Every limit
is enforced outside the Outpost container.

```
viewer (desktop) ── gateway ◄─────────────────────────┐
model provider ◄── key-proxy (real key) ◄─────────────┤  egress network
                                                      │
          egress container relays only :47833 (gateway) and :8787 (key-proxy)
                                                      │
          internal network, no route out:  Outpost (Codex, sandbox, volume)
```

One `compose.yaml` runs all three containers, and Docker restarts each of them
after a crash or a reboot. No long-running process runs on the host outside
Docker; the `.sh` scripts are one-shot commands.

## Files

The files sit beside this file. An MCP client reads them as
`skill://outpost-security-research/<path>` resources. Save them all into one
folder that stays where it is, such as `~/.config/outpost/stack`, keeping
`scripts/`, and mark the `.sh` files executable. The containers mount the two
`.mjs` scripts from that folder. Every `.sh` script takes the Outpost
container's name from `OUTPOST_CONTAINER` (default `pwragent-outpost`) and
reads the rest from that container.

| File | Runs in | Does |
| --- | --- | --- |
| `Dockerfile` | build | The Outpost image. |
| `compose.yaml` | Docker Compose | Runs the Outpost, the egress relay and the key proxy. |
| `compose.env.example` | Docker Compose | Settings for `compose.yaml`; copy it to `.env`. |
| `tcp-relay.mjs` | egress, Outpost | Forwards one TCP port. |
| `model-key-proxy.mjs` | key-proxy | Checks the placeholder, adds the real key, forwards to one upstream. |
| `push-repo.sh` | host | Moves a repository in and registers it as a project. |
| `pull-branch.sh` | host | Brings an agent's branch out as `outpost/<branch>`. |
| `deps-helper.sh` | host | Installs dependencies from an agent-free helper with network. |

## Rules

- The operator owns the Outpost. Ask before you stop, replace or re-enroll it.
  Back up its volume before any change, and keep the old container for
  rollback.
- Never print, log or commit: the provider API key, the placeholder token,
  federation invites, `federation.json`, `headless-secret.key`, or any
  `auth.json`.
- Put no credentials in a research Outpost: no Codex login, no forge token, no
  provider key. In Default and Auto, agent commands can read the whole volume
  except `$PWRAGENT_HOME/profiles` and the Codex home's credential files, and
  can send what they read out inside a model request.
- Only the operator moves code. Review every branch you pull out before you
  merge it.

## 1. Build the Image

The image needs `pwragent` 1.4.0 or later: earlier releases have no operator
policy settings and no `register-directory`. Pack the published release, or
`npm pack` `packages/pwragent` from a checkout after `pnpm --filter pwragent
build`:

```sh
BUILD_DIR="$(mktemp -d)"
(cd "$BUILD_DIR" && npm pack pwragent@<version> && mv pwragent-*.tgz pwragent.tgz)
cp Dockerfile "$BUILD_DIR/Dockerfile"
docker build -t pwragent-outpost:research "$BUILD_DIR"
```

`Dockerfile` sits beside this file (resource
`skill://outpost-security-research/Dockerfile`). It installs the packed
`pwragent` and a pinned Codex under `/opt/outpost-tools`, enables corepack's
`pnpm` shims as root-owned files, and runs `pwragent serve` with every path on
one volume at `/home/outpost`. The image has no `git-lfs`: see step 6.

The image runs as `501:20`. On a host whose volume files belong to another
UID, change `USER` in your copy.

Codex runs bubblewrap, which needs namespace syscalls that Docker's default
seccomp profile denies. Without them every command in a turn fails while the
turn still reports `completed`. Save Docker's default seccomp profile for your
engine as `docker-default.json` and add one rule, saving the result beside
`compose.yaml`:

```sh
jq '.syscalls += [{"names":["clone","unshare","setns","mount","umount2","pivot_root"],"action":"SCMP_ACT_ALLOW","args":[]}]' \
  docker-default.json > seccomp-outpost.json
```

## 2. Configure the Stack

In the folder that holds `compose.yaml`:

```sh
cp compose.env.example .env
chmod 600 .env
node -e 'console.log("MODEL_PROXY_PLACEHOLDER=ph_" + require("crypto").randomBytes(16).toString("hex"))' >> .env
```

Then edit `.env`. The example has no placeholder line; the one you just
appended is the only one.

- `GATEWAY_HOST` and `GATEWAY_PORT`: the federation gateway, as a container
  reaches it. On Docker Desktop, `host.docker.internal` reaches a gateway
  listening on the host's loopback. On Linux it is the bridge gateway, so the
  gateway must listen on that address, or name an address containers can
  reach.
- `MODEL_PROXY_UPSTREAM`: it must serve the OpenAI Responses API
  (`/v1/responses`) and should serve `/v1/models`. A model served on the Docker
  host is `http://host.docker.internal:<port>/v1`. The proxy forwards WebSocket
  upgrades too.

`.env` holds no key. Keep it out of every repository: it holds the
placeholder.

## 3. Start the Stack

```sh
docker volume create pwragent-outpost-home
MODEL_PROXY_API_KEY="$(op read 'op://<vault>/<item>/<field>')" docker compose up -d
docker compose logs --tail 40 outpost
```

On macOS, `"$(security find-generic-password -a "$USER" -s <service> -w)"`
reads the key from the Keychain instead.

Compose passes the key to the `key-proxy` container alone, as a secret: it
copies the key to `/run/secrets/model_api_key` inside that container, readable
only by the proxy's user. The key is not in `.env`, on the host disk, or in
`docker inspect`. Compose needs it again only when it recreates `key-proxy`,
for example after you change that service or run `docker compose down`;
without it Compose refuses and says so. `restart`, `logs`, and `up -d` with
nothing changed do not need it.

What `compose.yaml` sets up:

- The Outpost is on an `--internal` network with no route out, with every
  capability dropped, `no-new-privileges`, and your seccomp profile.
  `PWRAGENT_OUTPOST_EXECUTION_MODES=default,auto` lists the modes viewers may
  pick (`default` is read-only, `auto` is workspace-write, `full-access` is
  never right for research). `PWRAGENT_OUTPOST_AGENT_NETWORK=off` keeps the
  Codex sandbox's own network off as a second layer.
- The egress container is on both networks and relays exactly `:47833` to the
  gateway and `:8787` to `key-proxy`. Nothing else crosses. `key-proxy` is not
  on the internal network, so the Outpost reaches it only through that relay.
- Every service has `restart: unless-stopped`. Make sure Docker itself starts
  at login or boot: Docker Desktop's "Start Docker Desktop when you sign in",
  or the `docker` service on Linux.

## 4. Join the Federation

Join with an invite passed in a file, never on a command line:

```sh
docker exec -i pwragent-outpost sh -c 'umask 077; cat > /tmp/join.json' < join.json   # {"invite":"<invite>"}
docker exec pwragent-outpost /opt/outpost-tools/node_modules/.bin/pwragent federation-join --params-file /tmp/join.json
docker exec pwragent-outpost rm /tmp/join.json
```

The Outpost dials the gateway endpoint saved at enrollment, which the internal
network cannot reach. Its entrypoint relays `127.0.0.1:<GATEWAY_PORT>` inside
the container to the egress at every start. If `pwragent federation-status`
shows a saved endpoint with another port, or a host name rather than
`127.0.0.1`, set `OUTPOST_ENDPOINT_PORT` or `OUTPOST_ENDPOINT_HOST` in `.env`
and run `docker compose up -d`. A saved IP address other than `127.0.0.1`
cannot be redirected this way: join with an invite whose endpoint is
`127.0.0.1` or a host name. Then check `federation-status` again: the gateway
should be connected.

## 5. Add the Model Provider

Append a Codex provider whose base URL is the egress, the placeholder and
`/v1`. `PH` is `.env`'s `MODEL_PROXY_PLACEHOLDER`; load it with
`PH="$(sed -n 's/^MODEL_PROXY_PLACEHOLDER=//p' .env)"`. The container's shell
expands it, so it is never printed:

```sh
docker exec -e PH="$PH" pwragent-outpost sh -c 'cat >> "$PWRAGENT_HOME/profiles/docker/config.toml" <<EOF

[[models.codex.providers]]
id = "<provider>"
name = "<Provider> (key proxy)"
base_url = "http://pwragent-outpost-egress:8787/$PH/v1"
EOF'
docker compose restart outpost
```

The egress is `<OUTPOST_CONTAINER>-egress`. If model discovery misses a model,
add `models = ["<model-id>"]` to the entry.

Verify from inside the container, again without printing the token:

```sh
docker exec -e PH="$PH" pwragent-outpost node -e '
const base = `http://pwragent-outpost-egress:8787/${process.env.PH}/v1`;
const show = async (label, p) => { try { const r = await p; console.log(label, r.status); } catch (e) { console.log(label, "ERR", e.cause?.code || e.message); } };
await show("models", fetch(`${base}/models`));
await show("wrong token", fetch("http://pwragent-outpost-egress:8787/wrong/v1/models"));
await show("internet", fetch("https://example.com", { signal: AbortSignal.timeout(5000) }));'
```

Expect `models 200`, `wrong token 403`, and an `internet` error such as
`EAI_AGAIN`. `docker compose logs key-proxy` records the rejection with the
token redacted.

## Move an Existing Outpost to Compose

An Outpost started with `docker run` and `setup-network.sh` moves over with its
volume, so it keeps its enrollment, projects and threads. Ask the operator
first, and back up the volume.

1. Stop and remove the old containers, not the volume:
   `docker rm -f pwragent-outpost pwragent-outpost-egress`, then
   `docker network rm pwragent-outpost-internal`.
2. Stop the host relay and the host key proxy that served them.
3. Follow steps 2 and 3, with `OUTPOST_VOLUME` naming the existing volume.
   Skip step 4: the enrollment is on the volume.
4. Check `federation-status`, then run the step 5 verification.

## 6. Move Code In

```sh
OUTPOST_CONTAINER=pwragent-outpost scripts/push-repo.sh <local-repo> [project-name] [branch]
OUTPOST_CONTAINER=pwragent-outpost scripts/deps-helper.sh <local-repo>
```

The first command prints the project key, `directory:/home/outpost/workspace/<name>`.
Pass a branch to send only that branch; a shallow source needs one. Run it
again to send new commits; they land under `host/*` and never touch the
agent's branches.

Git LFS content does not cross. A bundle carries no LFS objects and the
Outpost cannot fetch them, so LFS-tracked files arrive as pointer files. The
image therefore has no `git-lfs`, and `push-repo.sh` removes the repository's
LFS hooks, which would otherwise make worktree creation fail.

`deps-helper.sh` runs the Outpost's image with network, its volume and its
user, installs once and exits. It runs `pnpm` through the image's corepack
shims, which agents cannot replace; corepack caches the `pnpm` release itself
on the volume. No agent runs there, and it runs nothing from
the Outpost's checkouts, which agents can edit: it installs from a `git
archive` of your repository's `HEAD`, or of `OUTPOST_DEPS_REF`. Afterwards a
plain `pnpm install` in any checkout or worktree inside the Outpost completes
offline in seconds. Run it again after a lockfile change (`fetch` mode fills
the store only). Never run it on an Outpost that allows Full Access.

## 7. Start Research Threads

From any viewer, pick the Outpost's project, choose a model under the custom
provider, and use Auto: a writable workspace with no network. Agents start
threads with `create_instance_thread`, passing the model as
`@<provider>/<model>`.

Expect two quirks. Codex has no metadata for custom models, so it warns once
and uses fallback limits. The thread-naming helper uses a default model the
Outpost cannot reach, so new threads stay untitled.

## 8. Move Work Out

```sh
OUTPOST_CONTAINER=pwragent-outpost scripts/pull-branch.sh <project-name> <branch> <local-repo>
```

The branch arrives as `outpost/<branch>`. Read the diff before you use it.

## Recover a Container That Will Not Start

The Outpost runs as PID 1, so a crashed container leaves an owner lock and a
runtime lease that look alive to the next one. If startup fails with "Headless
owner lock already exists" or "Profile federation lease is held by another
runtime", and no other container uses the volume, remove both from a root
helper and start again:

```sh
docker compose stop outpost
docker run --rm --user 0:0 --entrypoint sh -v pwragent-outpost-home:/v node:24-bookworm -c \
  'rm -f /v/state/profiles/docker/state/runtime-instances/*.json /v/state/profiles/docker/state/headless/owner.lock'
docker compose start outpost
```

## Known Limits

- In Default and Auto, Codex's permission profiles deny agent commands the
  profile folder, which holds the secret store key, the state database and the
  local control socket, and the Codex home's credentials (`auth.json`,
  `.credentials.json`, `secrets/`). Full Access has no sandbox: never allow it
  on a research Outpost.
- Everything else on the volume is readable, including the rest of the Codex
  home and every pushed repository.
- The Outpost's federation role is contained: peers refuse requests it
  originates. Viewers can still start, read and steer its threads.
