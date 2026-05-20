#!/usr/bin/env bash
set -euo pipefail

repo="${GITHUB_REPOSITORY:-pwrdrvr/PwrAgent}"
environment="${GITHUB_ENVIRONMENT:-apple-signing}"
vault_name="${OP_VAULT_NAME:-PwrDrvr LLC}"
item_title="${OP_ITEM_TITLE:-Apple Signing - PwrDrvr}"
p12_attachment_name="${OP_P12_ATTACHMENT_NAME:-${OP_ATTACHMENT_NAME:-PwrDrvr_DevID_Application.p12}}"
p8_attachment_name="${OP_P8_ATTACHMENT_NAME:-}"

usage() {
  cat >&2 <<'EOF'
Uploads PwrAgent Apple signing secrets from 1Password to the GitHub
apple-signing environment.

Usage:
  scripts/release/upload-csc-link-from-1password.sh
  scripts/release/upload-csc-link-from-1password.sh --list-accounts

Required:
  OP_ACCOUNT=<1Password account identifier>

Use the USER ID from `op account list` when the URL or email appears more than
once. The URL is ambiguous on machines with multiple accounts on the same
1Password domain.

Optional overrides:
  GITHUB_REPOSITORY=pwrdrvr/PwrAgent
  GITHUB_ENVIRONMENT=apple-signing
  OP_VAULT_NAME="PwrDrvr LLC"
  OP_ITEM_TITLE="Apple Signing - PwrDrvr"
  OP_P12_ATTACHMENT_NAME=PwrDrvr_DevID_Application.p12
  OP_P8_ATTACHMENT_NAME=AuthKey_XXXXXXXXXX.p8

Example:
  OP_ACCOUNT=<USER_ID_FROM_OP_ACCOUNT_LIST> scripts/release/upload-csc-link-from-1password.sh
EOF
}

print_accounts() {
  local accounts_json
  if ! accounts_json="$(op account list --format json 2>/dev/null)"; then
    echo "Could not list configured 1Password accounts." >&2
    return 1
  fi

  if ! jq -e 'length > 0' <<<"$accounts_json" >/dev/null; then
    echo "No configured 1Password accounts found." >&2
    return 1
  fi

  cat >&2 <<'EOF'
Configured 1Password accounts:

NAME		URL			EMAIL			USER ID
EOF

  while IFS=$'\t' read -r user_uuid url email; do
    local account_json
    local name
    if account_json="$(op account get --account "$user_uuid" --format json 2>/dev/null)"; then
      name="$(jq -r '.name // "(name unavailable)"' <<<"$account_json")"
    else
      name="(name unavailable)"
    fi
    printf '%s\t%s\t%s\t%s\n' "$name" "$url" "$email" "$user_uuid" >&2
  done < <(jq -r '.[] | [.user_uuid, .url, .email] | @tsv' <<<"$accounts_json")

  cat >&2 <<'EOF'

Use the USER ID for the account that contains the configured vault.
Run again with:
  OP_ACCOUNT=<USER ID> ./scripts/release/upload-csc-link-from-1password.sh
EOF
}

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 127
  fi
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ "${1:-}" == "--list-accounts" ]]; then
  require_command op
  require_command jq
  print_accounts
  exit 0
fi

require_command jq
require_command op

if [[ -z "${OP_ACCOUNT:-}" ]]; then
  cat >&2 <<'EOF'
Set OP_ACCOUNT to the 1Password account identifier first.

Use the USER ID column when the URL or email appears more than once.
EOF
  print_accounts
  exit 2
fi

require_command gh
require_command base64

vault_id="$(
  op vault list --account "$OP_ACCOUNT" --format json \
    | jq -r --arg name "$vault_name" 'first(.[] | select(.name == $name) | .id) // empty'
)"
if [[ -z "$vault_id" ]]; then
  echo "Could not find vault '$vault_name' in 1Password account '$OP_ACCOUNT'." >&2
  exit 1
fi

item_id="$(
  op item list --account "$OP_ACCOUNT" --vault "$vault_id" --format json \
    | jq -r --arg title "$item_title" 'first(.[] | select(.title == $title) | .id) // empty'
)"
if [[ -z "$item_id" ]]; then
  echo "Could not find item '$item_title' in vault '$vault_name'." >&2
  exit 1
fi

item_json="$(op item get "$item_id" --account "$OP_ACCOUNT" --vault "$vault_id" --format json)"

if ! jq -e --arg name "$p12_attachment_name" '.files[]? | select(.name == $name)' <<<"$item_json" >/dev/null; then
  echo "Could not find attachment '$p12_attachment_name' on item '$item_title'." >&2
  exit 1
fi

if [[ -z "$p8_attachment_name" ]]; then
  p8_attachment_name="$(
    jq -r 'first(.files[]?.name | select(test("^AuthKey_[A-Za-z0-9]+\\.p8$"))) // empty' <<<"$item_json"
  )"
fi
if [[ -z "$p8_attachment_name" ]]; then
  echo "Could not find an AuthKey_*.p8 attachment on item '$item_title'." >&2
  echo "Set OP_P8_ATTACHMENT_NAME if the attachment has a different name." >&2
  exit 1
fi
if ! jq -e --arg name "$p8_attachment_name" '.files[]? | select(.name == $name)' <<<"$item_json" >/dev/null; then
  echo "Could not find attachment '$p8_attachment_name' on item '$item_title'." >&2
  exit 1
fi

tmpdir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmpdir"
}
trap cleanup EXIT

read_field() {
  local field_name="$1"
  local value
  if ! value="$(op read --account "$OP_ACCOUNT" "op://$vault_id/$item_id/$field_name")"; then
    echo "Could not read field '$field_name' on item '$item_title'." >&2
    return 1
  fi
  if [[ -z "$value" ]]; then
    echo "Field '$field_name' is empty on item '$item_title'." >&2
    return 1
  fi
  printf "%s" "$value"
}

set_secret_from_value() {
  local secret_name="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    echo "Refusing to upload empty value for $secret_name." >&2
    exit 1
  fi
  printf "%s" "$value" | gh secret set "$secret_name" --repo "$repo" --env "$environment"
  echo "Uploaded $secret_name to $repo environment '$environment'."
}

set_secret_from_attachment_base64() {
  local secret_name="$1"
  local attachment_name="$2"
  local output_path="$tmpdir/$attachment_name"
  op read --account "$OP_ACCOUNT" --out-file "$output_path" "op://$vault_id/$item_id/$attachment_name" >/dev/null
  if [[ ! -s "$output_path" ]]; then
    echo "Attachment '$attachment_name' downloaded as an empty file." >&2
    exit 1
  fi
  base64 < "$output_path" | tr -d '\n' | gh secret set "$secret_name" --repo "$repo" --env "$environment"
  echo "Uploaded $secret_name from $attachment_name to $repo environment '$environment'."
}

if ! csc_key_password="$(read_field CSC_KEY_PASSWORD)"; then
  exit 1
fi
if ! apple_api_key_id="$(read_field APPLE_API_KEY_ID)"; then
  exit 1
fi
if ! apple_api_issuer="$(read_field APPLE_API_ISSUER)"; then
  exit 1
fi

set_secret_from_attachment_base64 CSC_LINK "$p12_attachment_name"
set_secret_from_value CSC_KEY_PASSWORD "$csc_key_password"
set_secret_from_attachment_base64 APPLE_API_KEY_BASE64 "$p8_attachment_name"
set_secret_from_value APPLE_API_KEY_ID "$apple_api_key_id"
set_secret_from_value APPLE_API_ISSUER "$apple_api_issuer"

echo "Uploaded all Apple signing secrets from 1Password item '$item_title'."
