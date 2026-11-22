import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CODEX_SKILL_PROFILE_NAME_LIMIT,
  codexSkillProfileNameError,
  type CodexSkillProfile,
} from "@pwragent/shared/contracts/codex-skill-profiles";
import type { NavigationDirectorySummary, NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { AppServerSkillOrigin, AppServerSkillSummary } from "@pwragent/shared/contracts/normalized-app-server";
import { withSkillOrigins } from "@pwragent/shared/skill-origin";
import type { DesktopApi } from "../../lib/desktop-api";
import { SkillOriginChip } from "../composer/SkillOriginChip";
import { SettingsField, SettingsSection } from "./SettingsLayout";
import { SettingsPathRow } from "./SettingsPathRow";
import { useUnsavedSettingsChanges } from "./UnsavedSettingsChanges";
import { useSettingsDraft } from "./useSettingsDraft";

type SkillCatalog =
  | { state: "loading" }
  | { state: "ready"; skills: AppServerSkillSummary[] }
  | { state: "error"; message: string };

export type SkillProfileDirectory = Pick<NavigationDirectorySummary, "kind" | "label" | "path" | "localAvailability">;
const NO_DIRECTORIES: readonly SkillProfileDirectory[] = [];

function groupSkills(skills: readonly AppServerSkillSummary[]) {
  const groups = new Map<string, { origin?: AppServerSkillOrigin; skills: AppServerSkillSummary[] }>();
  for (const skill of skills) {
    const key = JSON.stringify([skill.origin?.kind, skill.origin?.label]);
    const group = groups.get(key) ?? { origin: skill.origin, skills: [] };
    if (!group.skills.some(({ name }) => name === skill.name)) group.skills.push(skill);
    groups.set(key, group);
  }
  return [...groups].map(([key, group]) => ({ key, ...group }));
}

export function CodexSkillProfilesSettings(props: {
  profiles: readonly CodexSkillProfile[];
  directories?: readonly SkillProfileDirectory[];
  threads?: readonly NavigationThreadSummary[];
  desktopApi?: DesktopApi;
  onSave: (profiles: CodexSkillProfile[]) => Promise<boolean>;
}) {
  const [catalog, setCatalog] = useState<SkillCatalog>({ state: "loading" });
  const [refresh, setRefresh] = useState(0);
  const [editId, setEditId] = useState<string>();
  const [status, setStatus] = useState("");
  const newProfile = useRef<HTMLButtonElement>(null);
  const directories = props.directories ?? NO_DIRECTORIES;
  // Navigation rows can change for unrelated turn activity while Settings is open.
  const directoryKey = JSON.stringify(directories.flatMap((directory) =>
    directory.kind === "directory" && directory.path && !directory.localAvailability
      ? [{ path: directory.path, label: directory.label }]
      : []));
  useEffect(() => {
    let current = true;
    const origins = JSON.parse(directoryKey) as Array<{ path: string; label: string }>;
    const load = async () => {
      setCatalog({ state: "loading" });
      try {
        const response = await props.desktopApi?.listSkills?.({
          backend: "codex",
          cwds: [...new Set(origins.map(({ path }) => path))],
        });
        if (!response) throw new Error("Codex skill discovery is unavailable.");
        const errors = response.data.flatMap((entry) => entry.errors ?? []);
        if (errors.length && !response.data.some((entry) => entry.skills.length > 0)) {
          throw new Error("Codex could not read the skill catalog.");
        }
        const skills = new Map<string, AppServerSkillSummary>();
        for (const entry of response.data) {
          for (const skill of entry.skills) skills.set(skill.path ?? skill.name, skill);
        }
        if (current) setCatalog({
          state: "ready",
          skills: withSkillOrigins([...skills.values()], origins, { bundledSkillRoots: response.bundledSkillRoots }),
        });
      } catch (error) {
        if (current) setCatalog({ state: "error", message: error instanceof Error ? error.message : String(error) });
      }
    };
    void load();
    return () => { current = false; };
  }, [directoryKey, props.desktopApi, refresh]);

  const close = (message?: string) => {
    setEditId(undefined);
    if (message) setStatus(message);
    requestAnimationFrame(() => newProfile.current?.focus());
  };
  const saved = props.profiles.find(({ id }) => id === editId);
  const editor = editId ? (
    <SkillProfileEditor
      key={editId}
      id={editId}
      saved={saved}
      catalog={catalog}
      profiles={props.profiles}
      threads={props.threads}
      onSave={props.onSave}
      onClose={close}
      onRetry={() => setRefresh((value) => value + 1)}
    />
  ) : null;
  const installed = catalog.state === "ready" ? new Set(catalog.skills.map(({ name }) => name)) : undefined;
  return (
    <SettingsSection
      title="Skill profiles"
      sectionId="skill-profiles"
      description="A profile hides the skills it lists from new Codex threads you start with it. Other skills, including ones you install later, keep their Codex setting."
    >
      <div className="settings-paths">
        {!props.profiles.length && !editId ? (
          <p className="settings-empty">No profiles. New threads use your Codex skill settings. Make one to keep skills you don’t need out of a thread’s skill list.</p>
        ) : null}
        {props.profiles.map((profile) => {
          const hidden = profile.hiddenSkills;
          const absent = installed ? hidden.filter((name) => !installed.has(name)).length : 0;
          const details = [
            `Hides ${hidden.length} skills`,
            hidden.slice(0, 3).join(", "),
            hidden.length > 3 ? `+${hidden.length - 3}` : "",
            absent ? `${absent} not installed now` : "",
          ].filter(Boolean).join(" · ");
          return (
            <div key={profile.id}>
              <SettingsPathRow
                title={profile.name}
                path={details}
                selected={false}
                useLabel="Edit"
                disabled={Boolean(editId)}
                onUse={() => setEditId(profile.id)}
              />
              {profile.id === editId ? editor : null}
            </div>
          );
        })}
        {editId && !saved ? editor : null}
      </div>
      <div className="settings-inline-actions">
        <button
          className="button button--secondary"
          type="button"
          ref={newProfile}
          onClick={() => { setStatus(""); setEditId(crypto.randomUUID()); }}
          disabled={Boolean(editId)}
        >
          New profile
        </button>
      </div>
      {status ? <p role="status" className="settings-field__help">{status}</p> : null}
    </SettingsSection>
  );
}

function SkillProfileEditor(props: {
  id: string;
  saved?: CodexSkillProfile;
  catalog: SkillCatalog;
  profiles: readonly CodexSkillProfile[];
  threads?: readonly NavigationThreadSummary[];
  onSave: (profiles: CodexSkillProfile[]) => Promise<boolean>;
  onClose: (message?: string) => void;
  onRetry: () => void;
}) {
  const draft = useSettingsDraft({
    name: props.saved?.name ?? "",
    hidden: JSON.stringify(props.saved?.hiddenSkills ?? []),
  });
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const nameInput = useRef<HTMLInputElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { nameInput.current?.focus(); }, []);
  useEffect(() => {
    if (deleting) keepButton.current?.focus();
  }, [deleting]);
  const hidden = useMemo(() => new Set(JSON.parse(draft.values.hidden) as string[]), [draft.values.hidden]);
  const toggleNames = (names: readonly string[], checked: boolean) => {
    const next = new Set(hidden);
    for (const name of names) {
      if (checked) next.add(name);
      else next.delete(name);
    }
    draft.set("hidden", JSON.stringify([...next]));
  };
  const name = draft.values.name.trim();
  const nameError = codexSkillProfileNameError(name, props.profiles, props.id);
  const canSave = !saving && draft.dirty && !nameError && props.catalog.state !== "loading"
    && (props.catalog.state === "ready" || Boolean(props.saved));
  const persist = useCallback(async (profiles: CodexSkillProfile[], message?: string) => {
    setSaving(true);
    setError(undefined);
    try {
      if (!await props.onSave(profiles)) throw new Error("The profile could not be written.");
      props.onClose(message);
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setSaving(false);
    }
  }, [props.onClose, props.onSave]);
  const save = () => {
    if (!canSave) return Promise.resolve(false);
    const entry = { id: props.id, name, hiddenSkills: [...hidden] };
    return persist(props.saved
      ? props.profiles.map((profile) => profile.id === props.id ? entry : profile)
      : [...props.profiles, entry]);
  };
  useUnsavedSettingsChanges(draft.dirty
    ? { label: "Skill profiles", save, discard: () => props.onClose() }
    : undefined);
  const skills = props.catalog.state === "ready" ? props.catalog.skills : [];
  const installed = new Set(skills.map(({ name }) => name));
  const filter = query.trim().toLowerCase();
  const groups = groupSkills(skills);
  const missing = props.catalog.state === "ready"
    ? [...hidden].filter((name) => !installed.has(name) && name.toLowerCase().includes(filter))
    : [];
  const retainedThreads = props.threads?.filter((thread) =>
    !thread.federation && thread.codexSkillProfile?.profileId === props.id);
  const previewCount = retainedThreads?.length
    && retainedThreads.every((thread) => thread.codexSkillProfile?.hiddenSkills.length === props.saved?.hiddenSkills.length)
    ? retainedThreads.length
    : 0;

  return (
    <form className="settings-fields skill-profile-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <SettingsField label="Name" labelId="codex-skill-profile-name-label"
        error={nameError && draft.dirty ? nameError : undefined}
        control={<input
          className="settings-input"
          aria-labelledby="codex-skill-profile-name-label"
          ref={nameInput}
          disabled={saving}
          value={draft.values.name}
          maxLength={CODEX_SKILL_PROFILE_NAME_LIMIT}
          onChange={(event) => draft.set("name", event.target.value)}
          aria-invalid={Boolean(nameError) && draft.dirty}
        />}
      />
      <p className="settings-field__help">Checked skills are hidden from threads started with this profile. Unchecked skills, and skills installed later, keep their Codex setting.</p>
      {props.catalog.state === "loading" ? (
        <p role="status" className="settings-empty">Reading skills from Codex…</p>
      ) : props.catalog.state === "error" ? (
        <div role="alert" className="settings-row__error">
          <p>Codex didn’t list skills. {props.catalog.message} The {hidden.size} saved names are kept. You can rename or delete the profile now and change skills after it recovers.</p>
          <button type="button" className="button button--secondary" onClick={props.onRetry}>Try again</button>
        </div>
      ) : (
        <>
          <SettingsField label="Filter skills" labelId="codex-skill-profile-filter-label"
            control={<input className="settings-input" aria-labelledby="codex-skill-profile-filter-label" type="search" disabled={saving} value={query} onChange={(event) => setQuery(event.target.value)} />}
          />
          <p className="settings-field__help">{hidden.size} hidden · {installed.size} listed</p>
          <div className="skill-profile-editor__catalog">
            {groups.map(({ key, origin, skills }) => {
              const matches = skills.filter((skill) => [skill.name, skill.description, skill.shortDescription]
                .some((value) => value?.toLowerCase().includes(filter)));
              if (!matches.length) return null;
              const label = origin?.label ?? "Other skills";
              return (
                <div role="group" aria-label={label} key={key}>
                  <div className="skill-profile-editor__group">
                    {origin ? <SkillOriginChip origin={origin} /> : <strong>{label}</strong>}
                    <button className="button button--secondary" type="button" disabled={saving} aria-label={`Hide all ${label}`} onClick={() => toggleNames(skills.map(({ name }) => name), true)}>Hide all</button>
                    <button className="button button--secondary" type="button" disabled={saving} aria-label={`Show all ${label}`} onClick={() => toggleNames(skills.map(({ name }) => name), false)}>Show all</button>
                  </div>
                  {matches.map((skill) => (
                    <label key={skill.name} className="skill-profile-editor__skill">
                      <input type="checkbox" checked={hidden.has(skill.name)} disabled={saving} onChange={(event) => toggleNames([skill.name], event.target.checked)} />
                      <span className="skill-profile-editor__name">{skill.name}</span>
                      {skill.enabled === false ? <span className="settings-field__help">off in Codex</span> : null}
                      <span className="settings-field__help">{skill.shortDescription ?? skill.description}</span>
                    </label>
                  ))}
                </div>
              );
            })}
            {missing.length ? (
              <div role="group" aria-label="Not installed now">
                <strong>Not installed now</strong>
                {missing.map((skill) => (
                  <label key={skill} className="skill-profile-editor__skill">
                    <input type="checkbox" checked disabled={saving} onChange={() => toggleNames([skill], false)} />
                    <span className="skill-profile-editor__name">{skill}</span>
                    <span className="settings-field__help">Codex didn’t list this skill. It stays hidden if it comes back.</span>
                  </label>
                ))}
              </div>
            ) : null}
          </div>
        </>
      )}
      {error ? <p role="alert" className="settings-row__error">Couldn’t save. {error}</p> : null}
      {deleting && props.saved ? (
        <div className="skill-profile-editor__footer" onKeyDown={(event) => {
          if (event.key === "Escape") { event.stopPropagation(); setDeleting(false); }
        }}>
          <p>Delete {props.saved.name}? New threads can’t pick it. {previewCount
            ? `${previewCount} threads shown here keep hiding the same skills.`
            : "Threads started with it keep their saved skill list."}</p>
          <button type="button" className="button button--danger" disabled={saving} onClick={() => {
            void persist(props.profiles.filter(({ id }) => id !== props.id), `Deleted ${props.saved?.name}.`);
          }}>Delete profile</button>
          <button type="button" className="button button--secondary" ref={keepButton} onClick={() => setDeleting(false)}>Keep it</button>
        </div>
      ) : (
        <div className="skill-profile-editor__footer">
          {props.saved ? <button type="button" className="button button--secondary" disabled={saving} onClick={() => setDeleting(true)}>Delete profile</button> : null}
          <span className="settings-field__help">Applies to new threads</span>
          <button type="button" className="button button--secondary" disabled={saving} onClick={() => props.onClose()}>Cancel</button>
          <button type="submit" className="button button--primary" disabled={!canSave}>{saving ? "Saving…" : "Save"}</button>
        </div>
      )}
    </form>
  );
}
