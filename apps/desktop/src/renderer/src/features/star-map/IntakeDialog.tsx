import {
  type ClipboardEvent,
  type DragEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type {
  CelestialIconId,
  FederationTarget,
  StarMapIntakeCandidate,
  StarMapIntakeCandidateSource,
  StarMapIntakePhase,
} from "@pwragent/shared";
import { MAX_STAR_MAP_INTAKE_IMAGE_UPLOADS } from "../../../../shared/star-map-intake";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  imageDataUrlToBytes,
  normalizeImageFile,
} from "../../lib/image-normalization";
import { CelestialIcon, CloseIcon } from "../../icons";
import {
  formatPastedImageAlt,
  formatPastedImageName,
  getImageFilesFromDataTransfer,
  hasAnyFiles,
  isGifFile,
} from "../composer/composer-image-files";

export type IntakeDialogTarget = {
  instanceId: string;
  label: string;
  icon?: CelestialIconId;
  /** Remote target when the [+] belongs to another instance. */
  federationTarget?: FederationTarget;
};

const PHASE_COPY: Partial<Record<StarMapIntakePhase, string>> = {
  resolving: "Finding the right project…",
  creating: "Creating the thread…",
};

/**
 * Say which question the list answers. "Which project?" over a recency
 * fallback implies a judgment that was never made, and the operator reads
 * the first row as a recommendation it is not.
 */
const CANDIDATE_HINT: Record<StarMapIntakeCandidateSource, string> = {
  resolver: "Closest match first — pick the project:",
  label: "Your request names more than one project:",
  recent: "No project matched. Your most recent, newest first:",
  unresolved: "Could not check the projects. Your most recent, newest first:",
};

/**
 * Fall back rather than index blindly. A remote [+] runs the intake on the
 * peer that owns it, so a peer predating `candidateSource` answers without
 * one — and a bare lookup would render the list with no heading at all,
 * which is worse than the bare "Which project?" this replaced.
 */
function candidateHint(source: StarMapIntakeCandidateSource | undefined) {
  // `||`, not `??`: an empty-string source is as unusable as a missing one,
  // and would otherwise render the unlabelled list this exists to prevent.
  return (source && CANDIDATE_HINT[source]) || "Which project?";
}

type IntakeImageAttachment = {
  bytes: Uint8Array;
  id: string;
  key: string;
  mimeType: string;
  name: string;
  previewUrl: string;
};

function imageFileKey(file: File, mimeType: string): string {
  return [file.name, mimeType, file.size, file.lastModified].join(":");
}

function normalizedImageName(
  originalName: string,
  fallbackName: string,
  mimeType: "image/jpeg" | "image/png",
): string {
  const source = originalName || fallbackName;
  const baseName = source.replace(/\.[^.]*$/u, "") || "pasted-image";
  return `${baseName}.${mimeType === "image/jpeg" ? "jpg" : "png"}`;
}

/**
 * The Star Map [+] intake chat: describe a task in natural language and the
 * owning instance resolves the project (its registry + AGENTS.md
 * preferences), creates the thread, and the new card bubbles into the map.
 */
export function IntakeDialog(props: {
  desktopApi?: DesktopApi;
  target: IntakeDialogTarget;
  onClose: () => void;
  onCreated: (created: {
    instanceId: string;
    backend: string;
    threadId: string;
  }) => void;
  pastedImageMaxPatches?: number;
}) {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<StarMapIntakePhase | "idle">("idle");
  const [error, setError] = useState<string>();
  const [attachmentError, setAttachmentError] = useState<string>();
  const [imageAttachments, setImageAttachments] = useState<
    IntakeImageAttachment[]
  >([]);
  const [preparingImageCount, setPreparingImageCount] = useState(0);
  const [candidates, setCandidates] = useState<{
    entries: StarMapIntakeCandidate[];
    source: StarMapIntakeCandidateSource;
    /**
     * The task the intake already extracted before it asked which project.
     * Sent back with the pick so answering costs a thread creation rather
     * than a second resolution of the same sentence.
     */
    input?: string;
    /**
     * The request that payload was extracted from. The textarea stays live
     * while the operator chooses, so an edit made before they pick has to
     * retire the payload — otherwise their correction is silently replaced by
     * the sentence they corrected.
     */
    requestText?: string;
  }>();
  /**
   * The project the owning instance resolved to, streamed with `creating`.
   * When the resolver is confident it never asks, so this line is the only
   * place the operator sees the pick while it is still worth seeing.
   */
  const [resolvedDirectoryLabel, setResolvedDirectoryLabel] =
    useState<string>();
  const requestIdRef = useRef<string | undefined>(undefined);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewUrlsRef = useRef(new Set<string>());
  const closedRef = useRef(false);
  const busy = phase === "resolving" || phase === "creating";
  const preparingImages = preparingImageCount > 0;
  /**
   * Resolving is abandonable; creating is not. Nothing exists yet while the
   * resolver is thinking, so trapping the operator there buys nothing — and
   * it can think for up to `INTAKE_TURN_TIMEOUT_MS`. Once the launchpad is
   * being materialized a thread is on its way, and a dialog that vanished
   * mid-flight would leave the operator unsure whether it landed.
   */
  const dismissable = phase !== "creating" && !preparingImages;
  const { onClose } = props;
  const close = useCallback(() => {
    closedRef.current = true;
    onClose();
  }, [onClose]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    const previewUrls = previewUrlsRef.current;
    return () => {
      for (const previewUrl of previewUrls) {
        URL.revokeObjectURL(previewUrl);
      }
      previewUrls.clear();
    };
  }, []);

  // Stream progress: the owning instance publishes starMap/intake/status
  // for our requestId (fanned over federation for remote targets).
  useEffect(() => {
    const unsubscribe = props.desktopApi?.onAgentEvent?.((event) => {
      if (event.notification.method !== "starMap/intake/status") return;
      const params = event.notification.params as {
        requestId: string;
        phase: StarMapIntakePhase;
        message?: string;
        directoryLabel?: string;
      };
      if (params.requestId !== requestIdRef.current) return;
      setPhase(params.phase);
      if (params.directoryLabel) {
        setResolvedDirectoryLabel(params.directoryLabel);
      }
      if (params.phase === "failed" && params.message) {
        setError(params.message);
      }
    });
    return () => unsubscribe?.();
  }, [props.desktopApi]);

  const attachTransferredImages = useCallback((dataTransfer: DataTransfer) => {
    const images = getImageFilesFromDataTransfer(dataTransfer);
    if (images.length === 0) return false;

    setAttachmentError(undefined);
    const knownKeys = new Set(
      imageAttachments.map((attachment) => attachment.key),
    );
    const uniqueImages = images.filter(({ file, type }) => {
      const key = imageFileKey(file, type);
      if (knownKeys.has(key)) return false;
      knownKeys.add(key);
      return true;
    });
    const remaining = Math.max(
      0,
      MAX_STAR_MAP_INTAKE_IMAGE_UPLOADS
        - imageAttachments.length
        - preparingImageCount,
    );
    const accepted = uniqueImages.slice(0, remaining);
    if (accepted.length < uniqueImages.length) {
      setAttachmentError(
        `You can attach up to ${MAX_STAR_MAP_INTAKE_IMAGE_UPLOADS} images per task.`,
      );
    }
    if (accepted.length === 0) return true;

    setPreparingImageCount((current) => current + accepted.length);
    void Promise.all(
      accepted.map(async ({ file, type }, index) => {
        const fallbackName = formatPastedImageName(
          type,
          imageAttachments.length + index,
        );
        if (isGifFile(file, type)) {
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (bytes.byteLength === 0) {
            throw new Error("The pasted image was empty.");
          }
          return {
            bytes,
            key: imageFileKey(file, type),
            mimeType: "image/gif",
            name: file.name || fallbackName,
          };
        }

        const normalized = await normalizeImageFile(file, {
          fallback: props.desktopApi?.normalizeImageForUpload,
          maxPatchCount: props.pastedImageMaxPatches,
          sourceMimeType: type,
        });
        const bytes = await imageDataUrlToBytes(
          normalized.dataUrl,
          normalized.mimeType,
        );
        if (bytes.byteLength === 0) {
          throw new Error("The pasted image was empty.");
        }
        void props.desktopApi?.recordImageUploadNormalization?.({
          fileName: file.name || fallbackName,
          original: {
            height: normalized.original.height,
            mimeType: normalized.original.mimeType,
            size: normalized.original.size,
            width: normalized.original.width,
          },
          normalized: {
            height: normalized.height,
            mimeType: normalized.mimeType,
            size: normalized.size,
            width: normalized.width,
          },
          path: normalized.conversionPath,
          resized:
            normalized.original.width !== normalized.width
            || normalized.original.height !== normalized.height,
        });
        return {
          bytes,
          key: imageFileKey(file, type),
          mimeType: normalized.mimeType,
          name: normalizedImageName(
            file.name,
            fallbackName,
            normalized.mimeType,
          ),
        };
      }),
    )
      .then((loaded) => {
        const attachments = loaded.map((image) => {
          const previewBytes = new Uint8Array(image.bytes.byteLength);
          previewBytes.set(image.bytes);
          const previewUrl = URL.createObjectURL(
            new Blob([previewBytes.buffer], { type: image.mimeType }),
          );
          previewUrlsRef.current.add(previewUrl);
          return {
            bytes: image.bytes,
            id: `intake-image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            key: image.key,
            mimeType: image.mimeType,
            name: image.name,
            previewUrl,
          };
        });
        setImageAttachments((current) => {
          const acceptedAttachments = attachments.filter(
            (attachment) =>
              !current.some((candidate) => candidate.key === attachment.key),
          );
          const next = [
            ...current,
            ...acceptedAttachments,
          ].slice(0, MAX_STAR_MAP_INTAKE_IMAGE_UPLOADS);
          const retainedIds = new Set(next.map((attachment) => attachment.id));
          for (const attachment of attachments) {
            if (retainedIds.has(attachment.id)) continue;
            URL.revokeObjectURL(attachment.previewUrl);
            previewUrlsRef.current.delete(attachment.previewUrl);
          }
          return next;
        });
      })
      .catch((readError: unknown) => {
        setAttachmentError(
          readError instanceof Error
            ? readError.message
            : "The pasted image could not be read.",
        );
      })
      .finally(() => {
        setPreparingImageCount((current) =>
          Math.max(0, current - accepted.length),
        );
      });
    return true;
  }, [
    imageAttachments,
    preparingImageCount,
    props.desktopApi,
    props.pastedImageMaxPatches,
  ]);

  const onPaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (attachTransferredImages(event.clipboardData)) {
      event.preventDefault();
    }
  }, [attachTransferredImages]);

  const onDragOver = useCallback((event: DragEvent<HTMLTextAreaElement>) => {
    if (!hasAnyFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const onDrop = useCallback((event: DragEvent<HTMLTextAreaElement>) => {
    if (attachTransferredImages(event.dataTransfer)) {
      event.preventDefault();
    }
  }, [attachTransferredImages]);

  const submit = (directoryKey?: string, input?: string) => {
    const request = text.trim();
    if (
      !request
      || busy
      || preparingImages
      || !props.desktopApi?.dispatchStarMapIntake
    ) return;
    const requestId =
      requestIdRef.current ?? `intake-${Math.random().toString(36).slice(2)}`;
    requestIdRef.current = requestId;
    setError(undefined);
    setAttachmentError(undefined);
    setCandidates(undefined);
    setResolvedDirectoryLabel(undefined);
    setPhase("resolving");
    void props.desktopApi
      .dispatchStarMapIntake({
        requestId,
        request,
        directoryKey,
        ...(directoryKey && input ? { input } : {}),
        federationTarget: props.target.federationTarget,
        ...(imageAttachments.length > 0
          ? {
              imageUploads: imageAttachments.map((attachment) => ({
                bytes: attachment.bytes,
                mimeType: attachment.mimeType,
                name: attachment.name,
              })),
            }
          : {}),
      })
      .then((response) => {
        if (response.requestId !== requestIdRef.current) return;
        if (response.status === "created") {
          // Reaches the map even if the operator walked away mid-resolve:
          // the thread exists, so it still deserves its reveal.
          props.onCreated({
            instanceId: props.target.instanceId,
            backend: response.backend,
            threadId: response.threadId,
          });
          if (closedRef.current) return;
          setPhase("done");
          close();
          return;
        }
        if (closedRef.current) return;
        if (response.status === "needs_disambiguation") {
          setPhase("needs_disambiguation");
          setCandidates({
            entries: response.candidates,
            source: response.candidateSource,
            ...(response.input
              ? { input: response.input, requestText: request }
              : {}),
          });
          return;
        }
        setPhase("failed");
        setError(response.error);
      })
      .catch((err: unknown) => {
        if (closedRef.current) return;
        setPhase("failed");
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  /**
   * One status line, in precedence order. Named branches rather than a
   * chain of ternaries inside JSX: the ordering between an attachment
   * error, a failure, and a phase is the whole meaning of this string.
   */
  const statusMessage = (() => {
    if (attachmentError) return attachmentError;
    if (phase === "failed") return error ?? "";
    if (preparingImages) return "Preparing image…";
    if (phase === "creating" && resolvedDirectoryLabel) {
      return `Creating the thread in ${resolvedDirectoryLabel}…`;
    }
    return PHASE_COPY[phase as StarMapIntakePhase] ?? "";
  })();

  return createPortal(
    <div
      className="star-map-intake"
      role="dialog"
      aria-modal="true"
      aria-label={`New thread on ${props.target.label}`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && dismissable) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <button
        type="button"
        className="star-map-intake__backdrop"
        aria-label="Close intake"
        tabIndex={-1}
        onClick={() => {
          if (dismissable) close();
        }}
      />
      <div className="star-map-intake__panel">
        <div className="star-map-intake__header">
          {props.target.icon ? (
            <CelestialIcon icon={props.target.icon} size={20} />
          ) : null}
          <span className="star-map-intake__target">{props.target.label}</span>
          <button
            type="button"
            className="star-map-intake__close"
            aria-label="Close"
            disabled={!dismissable}
            onClick={close}
          >
            ✕
          </button>
        </div>
        <textarea
          ref={textareaRef}
          className="star-map-intake__input"
          placeholder="Give me a task, tell me the project, and any specifics that don't match your defaults."
          value={text}
          disabled={busy || preparingImages}
          rows={4}
          onChange={(event) => setText(event.target.value)}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onPaste={onPaste}
          onKeyDown={(event) => {
            if (
              event.key === "Enter"
              && (event.metaKey || event.ctrlKey)
            ) {
              event.preventDefault();
              submit();
            }
          }}
        />
        {imageAttachments.length > 0 ? (
          <div
            aria-label="Task images"
            className="star-map-intake__attachments"
          >
            {imageAttachments.map((attachment, index) => (
              <div
                className="star-map-intake__attachment"
                key={attachment.id}
              >
                <img
                  alt={formatPastedImageAlt(attachment, index)}
                  className="star-map-intake__attachment-preview"
                  src={attachment.previewUrl}
                />
                <button
                  aria-label={`Remove ${attachment.name}`}
                  className="star-map-intake__attachment-remove"
                  disabled={busy}
                  onClick={() => {
                    URL.revokeObjectURL(attachment.previewUrl);
                    previewUrlsRef.current.delete(attachment.previewUrl);
                    setImageAttachments((current) =>
                      current.filter(
                        (candidate) => candidate.id !== attachment.id,
                      ),
                    );
                  }}
                  type="button"
                >
                  <CloseIcon aria-hidden="true" size={10} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {candidates ? (
          <div className="star-map-intake__candidates">
            <p className="star-map-intake__hint">
              {candidateHint(candidates.source)}
            </p>
            {candidates.entries.map((candidate) => (
              <button
                key={candidate.directoryKey}
                type="button"
                className="star-map-intake__candidate"
                onClick={() =>
                  submit(
                    candidate.directoryKey,
                    // Only when the request is still the one it was derived
                    // from; an edited request has to be read afresh.
                    candidates.requestText === text.trim()
                      ? candidates.input
                      : undefined,
                  )
                }
              >
                <span className="star-map-intake__candidate-label">
                  {candidate.label}
                </span>
                {candidate.reason ? (
                  <span className="star-map-intake__candidate-reason">
                    {candidate.reason}
                  </span>
                ) : null}
                {candidate.path ? (
                  <span className="star-map-intake__candidate-path">
                    {candidate.path}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
        <div className="star-map-intake__footer">
          <span
            className={`star-map-intake__status${
              busy || preparingImages ? " is-busy" : ""
            }${phase === "failed" || attachmentError ? " is-failed" : ""}`}
            role="status"
          >
            {statusMessage}
          </span>
          <button
            type="button"
            className="button button--secondary"
            disabled={busy || preparingImages || text.trim().length === 0}
            onClick={() => submit()}
          >
            {busy ? "Working…" : preparingImages ? "Preparing…" : "Start thread"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
