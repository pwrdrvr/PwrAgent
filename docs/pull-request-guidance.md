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
- Prefer before/after screenshots on PRs that change visible UI.
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
