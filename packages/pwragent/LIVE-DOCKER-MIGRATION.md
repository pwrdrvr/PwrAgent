# PWR-141 live Docker migration

This is a one-off adoption of `4f9b407d-2bb9-4893-9b98-28b88952a3de`
and its existing Mac mini enrollment. It imports no jobs, pending invites or
other legacy profiles. The original `state/headless/federation.json` stays intact.
Run the commands from the repository root on the machine in the live runbook.
Do not print that JSON: it contains private keys.

1. Take the runbook's `lock.d` with `mkdir`; another holder means stop here.
   Confirm the existing owner has no active work before stopping it. Keep the
   old image and container configuration for rollback.
2. Stop `pwragent-outpost-main`. Create a new backup volume (do not reuse or
   overwrite `pwragent-outpost-npm-home-backup-20261110`):

   ```sh
   docker volume create pwragent-outpost-npm-home-before-pwr141-20261110
   docker run --rm --user 0:0 --entrypoint sh \
     -v pwragent-outpost-npm-home:/from:ro \
     -v pwragent-outpost-npm-home-before-pwr141-20261110:/to \
     node:24-bookworm -c 'cp -a /from/. /to/'
   docker rename pwragent-outpost-main pwragent-outpost-main-before-pwr141
   ```

   The backup includes the entire volume without interpreting any provider files.
   Verify the backup is populated and the federation source is byte-identical.
3. Build the narrow admin script. Its native SQLite import resolves inside the
   installed package in the target image:

   ```sh
   pnpm exec esbuild apps/desktop/scripts/adopt-live-docker-identity.ts \
     --bundle --platform=node --format=cjs --external:better-sqlite3 \
     --outfile=.local/pwr-141/adopt-live-docker-identity.cjs
   docker run --rm --entrypoint node \
     -v pwragent-outpost-npm-home:/home/outpost \
     -v "$PWD/.local/pwr-141/adopt-live-docker-identity.cjs:/opt/outpost-tools/node_modules/pwragent/adopt-live-docker-identity.cjs:ro" \
     pwragent-outpost:pwr141-arm64 -e \
     'require("/opt/outpost-tools/node_modules/pwragent/adopt-live-docker-identity.cjs").adoptLiveDockerOutpost(process.argv[1], process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; })' \
     /home/outpost/state/profiles/docker/state/headless/federation.json \
     /home/outpost/state/profiles/docker
   ```

   The script validates both key pairs, pins the one allowed instance and gateway,
   encrypts the keys with the Node host's private file key, and seeds standard
   SQLite federation metadata and client configuration. It preserves the loopback
   relay endpoint first. It refuses a running owner or different destination keys.
4. Start the new image with the runbook's original volume, UID, seccomp,
   capability, no-new-privileges and auth-mount settings. Restart the container
   relay. Verify the exact identity and Mac mini pairing before sending work.
   Run the PWR-141 live acceptance. Keep the backup after success.

## Rollback if adoption or acceptance fails

Stop and remove only the new container. Restore the backup while neither owner
is running, then restart the preserved original container and its relay:

```sh
docker stop pwragent-outpost-main
docker rm pwragent-outpost-main
docker run --rm --user 0:0 --entrypoint sh \
  -v pwragent-outpost-npm-home-before-pwr141-20261110:/from:ro \
  -v pwragent-outpost-npm-home:/to \
  node:24-bookworm -c 'find /to -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; cp -a /from/. /to/'
docker rename pwragent-outpost-main-before-pwr141 pwragent-outpost-main
docker start pwragent-outpost-main
```

Reinstall the container relay exactly as in the live runbook. Verify identity
`4f9b407d-2bb9-4893-9b98-28b88952a3de` and the original Mini enrollment. Remove
the live runbook's `lock.d` when finished, including after a rollback. Do not
delete either backup volume or the old image during this task.
