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
| `rbac-role` | Exact role ID explicitly resolved for the admitted actor on this admission path. Legacy implicit Admin is insufficient. |
| `provider-property` | The supported equality predicate `slack.workspace-admin` with boolean value `true`. |

The canonical validator is `isAgentTrustPolicy` in
`@pwragent/shared/contracts/agent-trust-policy`. It rejects unknown fields,
versions, providers, and predicates, and caps the number of rules and actor
requirements. It never repairs or removes a clause.

## Provider evidence contract

Slack workspace administrator evidence is a positive `is_admin` assertion
from the authenticated Slack `users.info` call. The response must identify the
same user and the local workspace. Evidence belongs to the current admission,
must match the exact inbound actor and workspace, and expires five seconds
after observation. Missing evidence, missing scope, an unavailable lookup,
and expired evidence fail the predicate. The grammar provides no email,
display-name, free-text, or other provider-property comparison.

See [Slack users.info](https://docs.slack.dev/reference/methods/users.info/)
and the [Slack user object](https://docs.slack.dev/reference/objects/user-object/).

## Admission and audit

Local interactive input is checked after existing provider and capability
admission. Each fragment of a grouped reply is checked before preparing its
input or downloading attachments. A matched inbound Automation goes through
the same policy before creating or coalescing a run. Observed-only events can
match actor IDs and verified properties, but never prove an Access Control
role. They remain unable to submit interactive input and receive no denial
reply. Historical replay supplies no live actor evidence and is disabled for
restricted Agents. Local operator runs and scheduled runs have no inbound
messaging actor.

Concrete connections have no evidence issuer in the legacy runtime. These
rules fail closed. Federation messaging cannot supply policy evidence on the
destination profile. Restricted Agents therefore refuse peer messaging turns
and peer reviews, steering and request answers until those paths can preserve
the source authority. Changes apply to new admissions. Work already accepted
into the owner queue runs under its original admission.

Rejections mark the messaging activity log with the `agent-trust` stage,
target thread, platform, conversation, and failure class. They contain no
message, actor label, or verified property value. The lease owner samples at
most one durable trust audit per two minutes across all Agents and providers.
The same limit applies to generic interactive denial responses. At the measured
20,632 WAL bytes per recorded rejection, continuous mismatches could produce
about 14.9 MB/day. Idle profiles write nothing for trust decisions.

## Portable definitions

Preserve the restricted state, provider kind, exact rule structure, and denial
behavior. Rebind each concrete connection, conversation tuple, actor ID, and
role ID using a separately typed local selection. Conversation and actor
selections need the rule's provider and connection scope. A provider property
grant needs explicit confirmation in that scope. A legacy namespace is an
explicit local choice. Keep a rule inactive if one of its conjuncts cannot be
resolved, and validate the completed policy before applying it.
