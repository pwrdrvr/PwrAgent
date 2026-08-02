#!/usr/bin/env bash
# Create or repair the restricted organization runner group shared by PwrSnap
# and PwrAgent. This script intentionally grants no other repository access.

set -euo pipefail

ORGANIZATION=pwrdrvr
RUNNER_GROUP="PwrDrvr macOS"
REPOSITORIES=(PwrSnap PwrAgent)

if ! gh api "orgs/$ORGANIZATION/actions/runner-groups?per_page=100" >/dev/null 2>&1; then
  echo "GitHub denied organization runner access." >&2
  echo "Refresh gh with an org-admin or fine-grained token that has Actions Runners and Administration write access:" >&2
  echo "  gh auth refresh -h github.com -s admin:org" >&2
  exit 1
fi

GROUP_ID=$(gh api "orgs/$ORGANIZATION/actions/runner-groups?per_page=100" \
  | RUNNER_GROUP="$RUNNER_GROUP" /usr/bin/python3 -c '
import json, os, sys
for group in json.load(sys.stdin).get("runner_groups", []):
    if group.get("name") == os.environ["RUNNER_GROUP"]:
        print(group["id"])
        break
')

REPOSITORY_IDS=()
for repository in "${REPOSITORIES[@]}"; do
  REPOSITORY_IDS+=("$(gh api "repos/$ORGANIZATION/$repository" --jq .id)")
done

if [[ -z "$GROUP_ID" ]]; then
  CREATE_ARGS=(--method POST "orgs/$ORGANIZATION/actions/runner-groups" -f "name=$RUNNER_GROUP" -f "visibility=selected")
  for repository_id in "${REPOSITORY_IDS[@]}"; do
    CREATE_ARGS+=(-F "selected_repository_ids[]=$repository_id")
  done
  GROUP_ID=$(gh api "${CREATE_ARGS[@]}" --jq .id)
else
  echo ">> organization runner group already exists: $RUNNER_GROUP ($GROUP_ID)"
fi

for index in "${!REPOSITORIES[@]}"; do
  repository=${REPOSITORIES[$index]}
  repository_id=${REPOSITORY_IDS[$index]}
  gh api --method PUT \
    "orgs/$ORGANIZATION/actions/runner-groups/$GROUP_ID/repositories/$repository_id" \
    >/dev/null
  echo ">> granted $ORGANIZATION/$repository access to $RUNNER_GROUP"
done
