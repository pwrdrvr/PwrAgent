# Config File Evolution

PwrAgent's desktop config is a user-editable TOML file at
`~/.pwragent/profiles/<profile>/config.toml`. Treat it differently from sqlite
state: there is no schema table, users may hand-edit it, and older app versions
may be opened against the same file after a downgrade.

Use this pattern whenever a config key changes in a way that older clients
cannot read, such as scalar to table-array, renamed fields, or values that need
additional per-entry metadata.

## Goals

- New clients read the newest valid shape they understand.
- Existing users do not lose values when a shape changes.
- Older clients keep working when we can preserve their existing field.
- New config files use the best current names and shapes.
- Conversion is lazy and localized to the setting being saved, not a whole-file
  rewrite on read.

## Reader Pattern

For each evolved setting, keep a small ordered catalog of recognized shapes.
Newest supported shapes should be checked first, then older fallbacks.

The reader should use the first candidate that matches a shape it can parse.
If a candidate key exists but has the wrong shape, ignore that candidate and
try the next recognized shape. Do not throw away the whole section because one
candidate is malformed.

For authorized contact lists, the current reader follows this shape order:

1. Canonical table-array shape, for example
   `[[messaging.telegram.authorized_users]]` with `id` and `display_name`.
2. Interim disambiguated table-array shape when it exists, for example
   `[[messaging.telegram.authorized_user_ids_list]]`.
3. Legacy scalar string-array shape, for example
   `authorized_user_ids = ["111111111"]`.

When a list entry is parsed from an older scalar array, normalize it into the
current in-memory shape with blank metadata fields rather than preserving a
parallel runtime type.

## Writer Pattern

When saving a setting whose shape changed:

1. Normalize and sanitize the new in-memory value before writing.
2. If the legacy scalar field exists and still has the recognized legacy shape,
   keep it and update the subset of data it can represent.
3. Add a marker comment above the legacy key if one is not already present.
4. Write the current shape using the canonical key unless the canonical key
   collides with the legacy scalar key.
5. If the canonical table-array key would collide with a legacy scalar key,
   write the current shape to `<key>_list`.
6. If an existing config already uses an interim `_list` key, continue writing
   that key until a later explicit cleanup. Do not silently move users between
   equivalent shapes on unrelated saves.
7. Delete stale intermediate keys only when they are superseded by the selected
   current key and are not the preserved legacy scalar.

This is why `authorized_user_ids` now writes new data to
`authorized_users`, while `authorized_supergroups` writes to
`authorized_supergroups_list` only when the old scalar
`authorized_supergroups = [...]` already exists.

For a blank or newly-created config, write only the current canonical shape.
There is no older field to preserve, and users of a new config are not expected
to downgrade to clients that predate the new setting shape.

## Legacy Comments

Legacy fields preserved for downgrade compatibility must be marked with a
single-line comment immediately above the key:

```toml
# pwragent-legacy-settings key=authorized_user_ids shape=string-array used_through=1.0.0-alpha.9 kept_for_older_clients
authorized_user_ids = ["111111111"]
```

The marker is `pwragent-legacy-settings`. The comment must include:

- `key=<toml_key>`
- `shape=<recognized_shape_name>`
- `used_through=<last_version_that_used_this_shape>`
- `kept_for_older_clients`

Keep the version and shape data as code constants next to the reader/writer
logic, not only in comments. Comments help humans and tooling inspect a file;
code constants are the catalog the app actually trusts.

If the marker already exists, preserve it rather than inserting duplicates.
Do not rely on the marker to decide whether a shape is readable. Always inspect
the actual TOML value shape.

## Naming

Use clear current names even if the old key name was too narrow. Do not carry a
bad name forward just for continuity.

- Prefer `authorized_users` over `authorized_user_ids` once entries contain more
  than IDs.
- Use `_list` only to disambiguate an evolved array/table-array from an existing
  scalar key with the same TOML name.
- Do not invent stilted names like `authorized_user_id_objects` when the domain
  name can describe the entity.

## Conversion Safety

Config conversion should happen through the normal config writer for the setting
being changed. Avoid eager whole-file migrations on startup unless a future
change truly cannot be represented side-by-side.

Preserve user comments and unrelated keys. Edits should be path-based TOML edits
against the relevant key or table-array, not a parse-and-reprint of the whole
file.

If a current client updates the new field, older preserved fields may receive a
lossy projection of the new value. For example, `authorized_users` entries keep
`display_name`, while the old `authorized_user_ids` array stores only `id`.
The reverse direction is intentionally not guaranteed: changes made by old
clients to legacy fields may not be reflected in a newer field that already
exists.

## Tests Required

For every backwards-incompatible config shape change, add or update tests that
cover:

- Reading the new canonical shape.
- Reading each recognized legacy shape.
- Falling back when an earlier candidate key exists but has the wrong shape.
- Saving a legacy config preserves and updates the old field.
- Saving a legacy config inserts the legacy marker comment exactly once.
- Saving a blank config writes only the current canonical shape.
- Saving does not delete unrelated comments or unrelated keys in the section.
- `_list` is used only when the canonical key collides with an existing legacy
  scalar key, or when an existing supported `_list` shape is already present.

## Current Implementation References

- Config parser/writer:
  `apps/desktop/src/main/settings/desktop-config.ts`
- Settings service tests:
  `apps/desktop/src/main/__tests__/desktop-settings-service.test.ts`
- TOML edit helper:
  `apps/desktop/src/main/settings/toml-editor.ts`
- Runtime/state layout:
  `docs/state-layout.md`
