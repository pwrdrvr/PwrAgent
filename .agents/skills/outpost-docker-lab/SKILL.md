---
name: outpost-docker-lab
description: Build, run, upgrade, connect, and drive a PwrAgent Outpost (the headless Node owner) in a local Docker container with a working Codex sandbox. Use when a task needs a live Outpost for a demo or end-to-end check, when an existing Docker Outpost needs a new image, or when an Outpost turn "completes" but its commands never ran.
---

# Outpost Docker Lab

A Docker Outpost is `pwragent serve` in a Linux container. It owns its own
threads and joins a federation like any other instance, so a desktop can
start and steer its turns remotely. Codex runs inside it, and Codex's
bubblewrap sandbox needs container options that Docker does not grant by
default.

## Read First

- [Outpost README](../../../packages/pwragent/README.md): install, the local
  CLI, the unattended execution policy, and the Linux container recipe.
- [Outpost Dockerfile](../../../packages/pwragent/Dockerfile): the image this
  skill builds.
- [Live Docker migration](../../../packages/pwragent/LIVE-DOCKER-MIGRATION.md):
  a one-off identity adoption. It shows the backup and rollback discipline.

## Rules

- A running Outpost belongs to the operator. Get the operator's explicit
  consent before you stop, replace, upgrade, or re-enroll it.
- Run one container per Outpost volume. Two owners on one profile is not a
  supported state; `serve` holds `state/headless/owner.lock` to refuse it.
- Never print or commit these files. Each one holds a credential:
  - `state/profiles/<profile>/state/headless/federation.json` (private keys).
  - `state/profiles/<profile>/state/headless-secret.key` (the secret store key).
  - The Codex home's `auth.json`.
  - A federation invite.
- Do not create a new federation identity for an Outpost that already has one.
  A new identity is a new instance, and every peer must enroll it again.
- Back up the whole volume before any change to the image, profile, or
  enrollment. Keep the previous container, stopped and renamed, for rollback.
- Keep machine-specific details in an untracked note under `.local/`:
  gateway host and port, instance id, volume names, host paths. This skill
  uses placeholders for all of them.
- Serialize lab changes with one host-wide lock. Take it before you stop the
  container and release it when the new one is verified:

  ```sh
  LAB_LOCK="${TMPDIR:-/tmp}/pwragent-outpost-lab.lock.d"
  mkdir "$LAB_LOCK" || { echo "another agent holds the Outpost lab"; exit 1; }
  # ... change the lab ...
  rmdir "$LAB_LOCK"
  ```

## Volume Layout

The image expects one volume mounted at `/home/outpost`:

| Path | Contents |
| --- | --- |
| `/home/outpost/state` | `PWRAGENT_HOME`. The image selects profile `docker`. |
| `/home/outpost/codex` | The dedicated Codex home, with its own credentials. |
| `/home/outpost/workspace` | Project directories. `serve --workspace` points here. |
| `/home/outpost/home` | `HOME` for the service user. |

The image runs as `501:20`, the first macOS user and the `staff` group.
Files in the volume must be owned by that UID. On another host, change
`USER` in your build copy of the Dockerfile to the owning UID and GID.

## Build an Image

From a checkout of the commit you want to run:

```sh
pnpm install --frozen-lockfile
pnpm --filter pwragent build
BUILD_DIR="$(mktemp -d)"
(cd packages/pwragent && npm pack --pack-destination "$BUILD_DIR")
mv "$BUILD_DIR"/pwragent-*.tgz "$BUILD_DIR/pwragent.tgz"
cp packages/pwragent/Dockerfile "$BUILD_DIR/"
docker build \
  --build-arg SOURCE_COMMIT="$(git rev-parse HEAD)" \
  -t pwragent-outpost:<tag> "$BUILD_DIR"
```

The Dockerfile pins the Codex CLI with `CODEX_VERSION`. That version is the
App Server contract the Outpost was tested against. Change it on purpose,
not to fix a build.

## Make the Seccomp Profile

Without it, bubblewrap fails with `bwrap: No permissions to create a new
namespace`. Every shell command and file edit in a turn fails, and the turn
still ends `completed`, so a turn that "worked" can have done nothing.

Start from Docker's default seccomp profile for your engine, saved as
`docker-default.json`, and add one rule:

```sh
jq '.syscalls += [{"names":["clone","unshare","setns","mount","umount2","pivot_root"],"action":"SCMP_ACT_ALLOW","args":[]}]' \
  docker-default.json > seccomp-outpost.json
```

Keep every other restriction in the default profile. Keep the result
outside the repository, or under `.local/`.

## Run It

```sh
docker run -d --name <container> \
  --cap-drop ALL --security-opt no-new-privileges \
  --security-opt seccomp=<absolute-path>/seccomp-outpost.json \
  -v <volume>:/home/outpost \
  pwragent-outpost:<tag>
docker logs --tail 40 <container>
```

`serve` runs a Codex sandbox check before it opens the owner. A failed check
stops startup with its diagnostic and never retries with broader
permissions. Read the log before you trust the container.

Put Codex credentials in `/home/outpost/codex` once, with the Codex CLI in
the container or by copying an auth file you own. Never bake credentials
into the image.

## Join a Federation

On a new volume, create an invite on the gateway instance, then join from
the container. Pass the invite in a file so it never appears in a command
line or log:

```sh
docker exec -i <container> sh -c 'umask 077; cat > /tmp/join.json' < join.json
docker exec <container> /opt/outpost-tools/node_modules/.bin/pwragent \
  federation-join --params-file /tmp/join.json
docker exec <container> rm /tmp/join.json
docker exec <container> /opt/outpost-tools/node_modules/.bin/pwragent federation-status
```

`join.json` is `{"invite":"<invite>"}`. Delete the local copy too.

### Relay an Unreachable Gateway Endpoint

The Outpost dials the endpoint saved at enrollment. If that endpoint is not
reachable from inside the container, such as a host loopback address, relay
it with [`scripts/tcp-relay.mjs`](scripts/tcp-relay.mjs):

```sh
# On the Docker host. Keep it running.
node .agents/skills/outpost-docker-lab/scripts/tcp-relay.mjs \
  127.0.0.1 <relay-port> <gateway-host> <gateway-port>

# In the container. Repeat after every container start.
docker cp .agents/skills/outpost-docker-lab/scripts/tcp-relay.mjs \
  <container>:/tmp/tcp-relay.mjs
docker exec -d <container> node /tmp/tcp-relay.mjs \
  127.0.0.1 <saved-endpoint-port> host.docker.internal <relay-port>
```

Then check `federation-status` again. Stopping the container relay is a
clean way to simulate a lost connection.

## Add a Project

A desktop viewer cannot browse the Outpost's file system. Create the project
directory from the Docker host. `docker exec` runs outside the agent
sandbox, so `git clone` has network access there:

```sh
docker exec <container> git clone <public-repo-url> \
  /home/outpost/workspace/<project>
```

Its project key is `directory:/home/outpost/workspace/<project>`. A bare
path is not a project key. Confirm the project with `list_instance_projects`
before you start a thread. The workspace root is always listed, as
`directory:/home/outpost/workspace`. If the new directory is missing, start
one thread locally with `start-thread` and a `cwd` in that directory; see the
README's local commands.

## Drive It From a Desktop

- Find the Outpost's instance id with `list_federation_instances`.
- Start a thread with `create_instance_thread`: that instance id, the
  `directory:` project key, backend `codex`, work mode `local`, and execution
  mode `default` (read-only) or `auto` (workspace-write).
- Queue more turns with `send_message_to_thread` and `delivery: new_turn`.
- Read results with `read_thread`. The local `list` and `show` commands read
  the same threads inside the container.

## Upgrade an Existing Outpost

1. Take the lab lock. Confirm with the operator, then confirm no turn is
   running.
2. Build the new image. Do not stop anything until it builds.
3. Stop the container and back up the volume to a new, dated volume. Never
   overwrite an existing backup:

   ```sh
   docker stop <container>
   docker volume create <volume>-before-<change>-<date>
   docker run --rm --user 0:0 --entrypoint sh \
     -v <volume>:/from:ro -v <volume>-before-<change>-<date>:/to \
     node:24-bookworm -c 'cp -a /from/. /to/'
   docker rename <container> <container>-before-<change>-<date>
   ```

4. Run the new image with the same name, options, and volume.
5. Verify: the log shows a passed sandbox check, `federation-status` reports
   the same instance id and a connected gateway, and a short `auto` turn
   creates a file in a project.
6. To roll back, remove the new container, restore the backup volume into the
   live volume the same way, and rename the old container back.
7. Release the lab lock. Leave old backups and containers until the operator
   asks you to delete them.

## Current Limits

- The Outpost policy is fixed in code: approval `never`, no full access,
  no network for agent commands, and federation containment. It cannot be
  viewed or changed remotely yet.
- Codex's Linux sandbox restricts writes, not reads. Until per-host policy
  ships, agent commands can read the Codex home and the secret store key in
  the same volume. Do not run untrusted prompts on an Outpost whose
  credentials matter.
