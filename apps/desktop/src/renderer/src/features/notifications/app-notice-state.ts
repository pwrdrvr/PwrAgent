import type { AppNoticeToastNotice } from "./AppNoticeToast";
import {
  resolveBackendErrorNotice,
  type BackendErrorSignal,
} from "./backend-error-notice";

export type AppNoticeState = {
  durable: AppNoticeToastNotice[];
  transient: AppNoticeToastNotice[];
};

export type AppNoticeAction =
  | { type: "show"; notice: AppNoticeToastNotice }
  | { type: "backend-error"; signal: BackendErrorSignal }
  | { type: "dismiss"; id: string }
  | { type: "dismiss-prefix"; prefix: string };

export const INITIAL_APP_NOTICE_STATE: AppNoticeState = {
  durable: [],
  transient: [],
};

export function appNoticeReducer(
  state: AppNoticeState,
  action: AppNoticeAction,
): AppNoticeState {
  if (action.type === "show") {
    return showNotice(state, action.notice);
  }

  if (action.type === "backend-error") {
    const current = findRelatedBackendNotice(state, action.signal);
    const notice = resolveBackendErrorNotice(action.signal, current);
    if (!notice) return state;
    const nextState = action.signal.kind === "codex-invalid-id-recovery"
      ? dismissSupersededRecoveryNotices(state, action.signal)
      : state;
    return showNotice(nextState, notice);
  }

  if (action.type === "dismiss") {
    const durable = state.durable.filter((notice) => notice.id !== action.id);
    const transient = state.transient.filter((notice) => notice.id !== action.id);
    if (
      durable.length === state.durable.length
      && transient.length === state.transient.length
    ) return state;
    return { durable, transient };
  }

  const durable = state.durable.filter(
    (notice) => !notice.id.startsWith(action.prefix),
  );
  const transient = state.transient.filter(
    (notice) => !notice.id.startsWith(action.prefix),
  );
  if (
    durable.length === state.durable.length
    && transient.length === state.transient.length
  ) return state;
  return { durable, transient };
}

function dismissSupersededRecoveryNotices(
  state: AppNoticeState,
  signal: Extract<
    BackendErrorSignal,
    { kind: "codex-invalid-id-recovery" }
  >,
): AppNoticeState {
  // Recovery status becomes the live UI for this incident. The persisted
  // turn-failure and recovery audit remain in the thread transcript.
  const supersededIds = new Set([
    `turn-failed:codex:${signal.threadId}:${signal.turnId}`,
    `system-error:codex:${signal.threadId}`,
  ]);
  const durable = state.durable.filter(
    (notice) => !supersededIds.has(notice.id),
  );
  const transient = state.transient.filter(
    (notice) => !supersededIds.has(notice.id),
  );
  if (
    durable.length === state.durable.length
    && transient.length === state.transient.length
  ) return state;
  return { durable, transient };
}

function showNotice(
  state: AppNoticeState,
  notice: AppNoticeToastNotice,
): AppNoticeState {
  if (notice.autoDismiss !== false) {
    return {
      durable: state.durable.filter((entry) => entry.id !== notice.id),
      transient: upsertTransientNotice(state.transient, notice),
    };
  }

  return {
    durable: upsertNotice(state.durable, notice),
    transient: state.transient.filter((entry) => entry.id !== notice.id),
  };
}

function upsertTransientNotice(
  notices: readonly AppNoticeToastNotice[],
  notice: AppNoticeToastNotice,
): AppNoticeToastNotice[] {
  const index = notices.findIndex(
    (entry) =>
      entry.id === notice.id
      || (
        notice.transientSlot !== undefined
        && entry.transientSlot === notice.transientSlot
      ),
  );
  return index >= 0
    ? notices.map((entry, entryIndex) =>
        entryIndex === index ? notice : entry
      )
    : [...notices, notice];
}

function upsertNotice(
  notices: readonly AppNoticeToastNotice[],
  notice: AppNoticeToastNotice,
): AppNoticeToastNotice[] {
  const index = notices.findIndex((entry) => entry.id === notice.id);
  return index >= 0
    ? notices.map((entry, entryIndex) =>
        entryIndex === index ? notice : entry
      )
    : [...notices, notice];
}

function findRelatedBackendNotice(
  state: AppNoticeState,
  signal: BackendErrorSignal,
): AppNoticeToastNotice | undefined {
  const prefixes = signal.kind === "codex-invalid-id-recovery"
    ? [
        `codex-invalid-id-recovery:codex:${signal.threadId}:${signal.turnId}`,
        `turn-failed:codex:${signal.threadId}:`,
      ]
    : signal.kind === "turn-failed"
      ? [`turn-failed:${signal.backend}:${signal.threadId}:${signal.turnId}`]
      : [
          `turn-failed:${signal.backend}:${signal.threadId}:`,
          ...(signal.backend === "codex"
            ? [`codex-invalid-id-recovery:codex:${signal.threadId}:`]
            : []),
        ];
  const notices = [...state.durable, ...state.transient];
  for (let index = notices.length - 1; index >= 0; index -= 1) {
    const notice = notices[index];
    if (notice && prefixes.some((prefix) => notice.id.startsWith(prefix))) {
      return notice;
    }
  }
  return undefined;
}
