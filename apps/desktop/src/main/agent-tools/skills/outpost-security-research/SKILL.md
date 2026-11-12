---
name: outpost-security-research
description: Set up and operate a contained PwrAgent Outpost in Docker for security research with models you do not trust. The container has no network; its Codex reaches only one model through a host-side key proxy, repositories move in and out by docker exec, and dependencies install offline. Use when asked to run research or abliterated models against code without network access, to add a model provider behind a key proxy, or to push a repository into an Outpost.
---

# Outpost Security Research

Run a model you do not trust against your own code, from your normal PwrAgent
window, in a container that can reach nothing except that model. Every limit
is enforced outside the container.

```
viewer (desktop) ── gateway ── host relay :47833 ─┐
model provider ── key proxy :8787 (real key) ─────┤  host
                                                  │
              egress container (bridge + internal) relays only :47833 and :8787
                                                  │
              --internal network, no route out:  Outpost (Codex, sandbox, volume)
```

## Files

The scripts sit in `scripts/` beside this file, with the image's `Dockerfile`.
An MCP client reads them as `skill://outpost-security-research/scripts/<file>`
resources; save each one locally and mark the `.sh` files executable. Every script takes the Outpost
container's name from `OUTPOST_CONTAINER` (default `pwragent-outpost`) and
reads the rest from that container.

| Script | Runs on | Does |
| --- | --- | --- |
| `tcp-relay.mjs` | host, egress, Outpost | Forwards one TCP port. |
| `model-key-proxy.mjs` | host | Checks the placeholder, adds the real key, forwards to one upstream. |
| `start-model-key-proxy.sh` | host | Starts the proxy from a mode-600 env file. |
| `setup-network.sh` | host | Creates the internal network and the egress container. |
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
`pwragent` and a pinned Codex under `/opt/outpost-tools` and runs `pwragent
serve` with every path on one volume at `/home/outpost`.

The image runs as `501:20`. On a host whose volume files belong to another
UID, change `USER` in your copy.

Codex runs bubblewrap, which needs namespace syscalls that Docker's default
seccomp profile denies. Without them every command in a turn fails while the
turn still reports `completed`. Save Docker's default seccomp profile for your
engine as `docker-default.json` and add one rule:

```sh
jq '.syscalls += [{"names":["clone","unshare","setns","mount","umount2","pivot_root"],"action":"SCMP_ACT_ALLOW","args":[]}]' \
  docker-default.json > seccomp-outpost.json
```

## 2. Start the Host Side

The model key proxy holds the real key. Make a private env file outside any
repository:

```sh
umask 077
PH="ph_$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')"
cat > ~/.config/outpost/<provider>.env <<EOF
MODEL_PROXY_UPSTREAM=https://<provider-host>/v1
MODEL_PROXY_PLACEHOLDER=$PH
MODEL_PROXY_LISTEN=127.0.0.1:8787
EOF
# Append the key without echoing it, for example from a password manager:
printf 'MODEL_PROXY_API_KEY=%s\n' "$(op read 'op://<vault>/<item>/credential')" >> ~/.config/outpost/<provider>.env
scripts/start-model-key-proxy.sh ~/.config/outpost/<provider>.env
```

The upstream must serve the OpenAI Responses API (`/v1/responses`) and should
serve `/v1/models`. The proxy forwards WebSocket upgrades too.

Relay the federation gateway to the host port the egress will use:

```sh
node scripts/tcp-relay.mjs 127.0.0.1 47833 <gateway-host> <gateway-port>
```

On Docker Desktop, `host.docker.internal` reaches host loopback listeners. On
Linux it reaches the bridge gateway, so bind both host listeners to that
address instead of `127.0.0.1`.

Both host processes stop on reboot or logout. Run them under launchd or
systemd if the Outpost must stay connected.

## 3. Create the Network

```sh
scripts/setup-network.sh
```

It creates `pwragent-outpost-internal` with `--internal`, and an egress
container on both networks that relays exactly `:47833` and `:8787` to the
host. Nothing else crosses.

## 4. Run the Outpost

```sh
docker volume create pwragent-outpost-home
docker run -d --name pwragent-outpost \
  --network pwragent-outpost-internal \
  --cap-drop ALL --security-opt no-new-privileges \
  --security-opt seccomp=<absolute-path>/seccomp-outpost.json \
  -e PWRAGENT_OUTPOST_EXECUTION_MODES=default,auto \
  -e PWRAGENT_OUTPOST_AGENT_NETWORK=off \
  -v pwragent-outpost-home:/home/outpost \
  pwragent-outpost:research
docker logs --tail 40 pwragent-outpost
```

`PWRAGENT_OUTPOST_EXECUTION_MODES` lists the modes viewers may pick (`default`
is read-only, `auto` is workspace-write, `full-access` is never right for
research). `PWRAGENT_OUTPOST_AGENT_NETWORK=off` keeps the Codex sandbox's own
network off as a second layer. Unknown values stop startup.

Join the federation with an invite passed in a file, never on a command line:

```sh
docker exec -i pwragent-outpost sh -c 'umask 077; cat > /tmp/join.json' < join.json   # {"invite":"<invite>"}
docker exec pwragent-outpost /opt/outpost-tools/node_modules/.bin/pwragent federation-join --params-file /tmp/join.json
docker exec pwragent-outpost rm /tmp/join.json
```

The Outpost dials the gateway endpoint saved at enrollment, which the internal
network cannot reach. Relay it inside the container to the egress, after
every container start:

```sh
docker cp scripts/tcp-relay.mjs pwragent-outpost:/tmp/tcp-relay.mjs
docker exec -d pwragent-outpost node /tmp/tcp-relay.mjs 127.0.0.1 <endpoint-port> pwragent-outpost-egress 47833
```

If the saved endpoint names a host rather than `127.0.0.1`, also pass
`--add-host <endpoint-host>:127.0.0.1` to `docker run`. Check with
`pwragent federation-status`: the gateway should be connected.

## 5. Add the Model Provider

Append a Codex provider whose base URL is the egress, the placeholder and
`/v1`. `PH` is the env file's `MODEL_PROXY_PLACEHOLDER`. The container's shell
expands it, so it is never printed:

```sh
docker exec -e PH="$PH" pwragent-outpost sh -c 'cat >> "$PWRAGENT_HOME/profiles/docker/config.toml" <<EOF

[[models.codex.providers]]
id = "<provider>"
name = "<Provider> (key proxy)"
base_url = "http://pwragent-outpost-egress:8787/$PH/v1"
EOF'
docker restart pwragent-outpost
```

Restart the in-container relay from step 4 after the restart. If model
discovery misses a model, add `models = ["<model-id>"]` to the entry.

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
`EAI_AGAIN`. The proxy log records the rejection with the token redacted.

## 6. Move Code In

```sh
OUTPOST_CONTAINER=pwragent-outpost scripts/push-repo.sh <local-repo> [project-name] [branch]
OUTPOST_CONTAINER=pwragent-outpost scripts/deps-helper.sh <local-repo>
```

The first command prints the project key, `directory:/home/outpost/workspace/<name>`.
Pass a branch to send only that branch; a shallow source needs one. Run it
again to send new commits; they land under `host/*` and never touch the
agent's branches.

`deps-helper.sh` runs the Outpost's image with network, its volume and its
user, installs once and exits. No agent runs there, and it runs nothing from
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
docker run --rm --user 0:0 --entrypoint sh -v pwragent-outpost-home:/v node:24-bookworm -c \
  'rm -f /v/state/profiles/docker/state/runtime-instances/*.json /v/state/profiles/docker/state/headless/owner.lock'
docker start pwragent-outpost
```

Then restart the in-container relay from step 4.

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
