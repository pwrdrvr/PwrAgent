# Agent invocation trust

An Agent's invocation trust narrows which admitted messaging actors may send
input to that Agent. Provider admission, messaging capability checks, and the
Automation's own inbound trigger filters still apply. A trust match grants no
RBAC role, tool, execution mode, or general messaging access.

## Policy version 1

An absent policy inherits existing admission. An explicit version 1 policy is
an allowlist. `rules: []` denies all messaging invocations. An invalid or
unrecognized policy denies silently. Use `denialResponse: "silent"` by default
or opt in to `"generic"`.

Rules are alternatives. One rule must match the provider, connection
namespace, conversation selector (if present), and every requirement in its
nonempty `allOf` list. Fields never satisfy a requirement on another rule.

| Selector | Match |
| --- | --- |
| `provider` | Exact provider kind. |
| `connectionId` | Exact opaque profile-local connection ID. Omission matches only an inbound event in the legacy namespace, with no profile-local connection ID. Existing retained provider-account IDs and Federation instance IDs are separate identities. |
| `conversation` | An exact `kind`, `id`, `parentId`, and `workspaceId` tuple. Optional tuple components must agree, including absence. Omitting the entire selector allows any admitted conversation in the rule's namespace. |
| `actor-id` | Exact normalized actor ID from provider admission. |
| `rbac-role` | Exact nonempty role ID explicitly resolved for the admitted actor on this admission path, including any whitespace preserved by RBAC. Legacy implicit Admin is insufficient. |
| `provider-property` | The supported equality predicate `slack.workspace-admin` with boolean value `true`. |

The canonical validator is `isAgentTrustPolicy` in
`@pwragent/shared/contracts/agent-trust-policy`. It rejects unknown fields,
versions, providers, and predicates, and caps the number of rules and actor
requirements. It never repairs or removes a clause.

## Provider evidence contract

Slack workspace administrator evidence is a positive `is_admin` assertion
from the authenticated Slack `users.info` call. The response must identify the
same user and the local workspace. Evidence belongs to the current admission,
must match the exact inbound actor and a nonempty inbound workspace ID, and expires five seconds
after observation. Missing evidence, missing scope, an unavailable lookup,
and expired evidence fail the predicate. The grammar provides no email,
display-name, free-text, or other provider-property comparison.

See [Slack users.info](https://docs.slack.dev/reference/methods/users.info/)
and the [Slack user object](https://docs.slack.dev/reference/objects/user-object/).

## Portable definitions

Preserve the restricted state, provider kind, exact rule structure, and denial
behavior. Rebind each concrete connection, conversation tuple, actor ID, and
role ID using a separately typed local selection. Conversation and actor
selections need the rule's provider and connection scope. A provider property
grant needs explicit confirmation in that scope. A legacy namespace is an
explicit local choice. Keep a rule inactive if one of its conjuncts cannot be
resolved, and validate the completed policy before applying it.
