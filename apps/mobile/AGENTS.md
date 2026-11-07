# Mobile client

Use Expo development builds and local Metro for LAN iteration. No cloud build,
store submission or billed Live test is implicit in a code/build request.

Keep credentials in expo-secure-store. Never add vendor API credentials or direct
vendor REST session creation. The trusted gateway owns Live signaling and tools.
Keep desktop and mobile Live on the shared session owner.

Persist enqueue UUID, timestamp, canonical hash, ingress, device, owner and the
exact payload before dispatch. Do not replay under a different device or ingress.
Do not generate replacement IDs for retries or auto-replay uncertain outcomes.
Do not insert an optimistic transcript echo: pending messages are outbox receipts.

Core tests run with `pnpm --filter @pwragent/mobile test`; typecheck with
`pnpm --filter @pwragent/mobile typecheck`. Root syntax/typed lint also applies.
Generated ios/android projects are ignored; app.json and the lockfile own them.
Run prebuild after native config/dependency changes. Match the installed Xcode
version with a supported Expo SDK. Do not patch native vendor code to hide a
compiler incompatibility.
