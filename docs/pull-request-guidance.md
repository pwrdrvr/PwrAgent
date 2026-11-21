# Pull Request Guidance

Read this before drafting or editing a PR title or description, or capturing, attaching, or editing PR media. Also read the operator’s `~/.codex/pr-style.md` and follow the target repository’s PR template.

- Use Conventional Commit-style PR titles: `type(scope): short description`.
- Select the scope that matches the changed area:
  - Use `messaging` for Telegram, Discord, adapters, and messaging integrations.
  - Use `desktop` for the desktop application.
  - Use `agent-core` for coding-agent backends and ACP integration.
  - Use `release` for packaging, signing, notarization, distribution, and automatic updates.
  - Use `docs` for documentation.
  - Use `tests` for test coverage, fixtures, and test infrastructure.
- Include before/after screenshots on every PR that changes visible UI, in the template's Screenshots section. A PR without UI changes says "No UI change." there. Cost is not a reason to skip them: a capture takes one build and a throwaway spec (see [Capturing PR screenshots](#capturing-pr-screenshots)).
  - Use 100% contrived fixture data when possible.
  - If a screenshot is not 100% contrived, show it to the operator and wait for approval before attaching. Redact anything that must not ship (secrets, tokens, customer data, private thread text, account identifiers).
- GitHub CLI 2.99+ (`gh` v2.99.0) can attach images and videos with the repeatable `--attach` flag on `gh pr create`, `gh pr edit`, and `gh pr comment`.
  - Use this upload path. Never create or push orphan commits, evidence branches, or other Git commits solely to host media, and never substitute raw repository URLs. If upload is unavailable or fails, report the blocker.
  - Reference the local path in the Markdown body so `gh` rewrites it to the uploaded URL in place. Unreferenced attachments are appended at the end.
  - Example:

    ```bash
    gh pr create \
      --title "fix(desktop): tighten composer padding" \
      --body-file /tmp/pr-body.md \
      --attach ./before.png \
      --attach ./after.png
    ```

    With this body:

    ```markdown
    ## Before
    ![composer before](./before.png)

    ## After
    ![composer after](./after.png)
    ```

  - Alt text can also follow the path after `#`, as in `--attach './after.png#composer after'`. Update `gh` to v2.99.0 or later before using `--attach`.
  - `gh` rewrites a link only when its target equals an `--attach` path byte-for-byte. The `#alt` suffix is not compared. On a mismatch, `gh` appends the upload at the end instead.
  - The rewrite exists only in the uploaded body. The local body file keeps the local paths.
  - For every later body edit, run `gh pr view <n> --json body -q .body > <file>` and edit that copy. Never re-send the original draft. It replaces the live `user-attachments` URLs with dead local paths.
  - To add an image later, pass `--attach` for the new file only. Existing `user-attachments` URLs match no `--attach` path, so `gh` leaves them alone.
  - `gh` exits 0 in each of these cases. Verify that every body image link is a `user-attachments` URL, and that each asset fetches with HTTP 200 and the local file's byte count.

## Capturing PR screenshots

Use a throwaway Playwright inspect spec, not the running app: several dev Electron windows cannot be told apart, and real threads are not contrived data.

1. Write `apps/desktop/e2e/zz-<feature>.inspect.spec.ts`. Launch with `launchElectronApp({ fixturePath, appearance: { theme }, preLaunchHook })`: a replay fixture supplies the threads, and `preLaunchHook` seeds state (for example to-do cards through `ThreadTodoService`). `e2e/todo-dispatch-model.spec.ts` is a working example.
2. Run `pnpm --filter @pwragent/desktop build`, then `pnpm exec playwright test -c playwright.inspect.config.ts zz-<feature>` from `apps/desktop`. The inspect run does not build, so rebuild after every source change.
3. Take element screenshots into `.local/`, in dark and light themes.
4. For the "before" image, temporarily restore the changed renderer files from the base commit (`git show <base>:<path> > <path>`), rebuild, capture, and restore your files.
5. Delete the spec before committing, and attach the images with `gh --attach` as described above.
