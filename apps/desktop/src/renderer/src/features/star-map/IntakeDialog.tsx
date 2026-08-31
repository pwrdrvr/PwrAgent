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
  StarMapIntakePhase,
} from "@pwragent/shared";
import { MAX_STAR_MAP_INTAKE_IMAGE_UPLOADS } from "../../../../shared/star-map-intake";
import type { DesktopApi } from "../../lib/desktop-api";
import { CelestialIcon, CloseIcon } from "../../icons";
import {
  formatPastedImageAlt,
  formatPastedImageName,
  getImageFilesFromDataTransfer,
  hasAnyFiles,
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
}) {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<StarMapIntakePhase | "idle">("idle");
  const [error, setError] = useState<string>();
  const [attachmentError, setAttachmentError] = useState<string>();
  const [imageAttachments, setImageAttachments] = useState<
    IntakeImageAttachment[]
  >([]);
  const [preparingImageCount, setPreparingImageCount] = useState(0);
  const [candidates, setCandidates] = useState<StarMapIntakeCandidate[]>();
  const requestIdRef = useRef<string | undefined>(undefined);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewUrlsRef = useRef(new Set<string>());
  const busy = phase === "resolving" || phase === "creating";
  const preparingImages = preparingImageCount > 0;

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
      };
      if (params.requestId !== requestIdRef.current) return;
      setPhase(params.phase);
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
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.byteLength === 0) {
          throw new Error("The pasted image was empty.");
        }
        return {
          bytes,
          file,
          key: imageFileKey(file, type),
          mimeType: type,
          name:
            file.name
            || formatPastedImageName(type, imageAttachments.length + index),
        };
      }),
    )
      .then((loaded) => {
        const attachments = loaded.map((image) => {
          const previewUrl = URL.createObjectURL(image.file);
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
  }, [imageAttachments, preparingImageCount]);

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

  const submit = (directoryKey?: string) => {
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
    setPhase("resolving");
    void props.desktopApi
      .dispatchStarMapIntake({
        requestId,
        request,
        directoryKey,
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
          setPhase("done");
          props.onCreated({
            instanceId: props.target.instanceId,
            backend: response.backend,
            threadId: response.threadId,
          });
          props.onClose();
          return;
        }
        if (response.status === "needs_disambiguation") {
          setPhase("needs_disambiguation");
          setCandidates(response.candidates);
          return;
        }
        setPhase("failed");
        setError(response.error);
      })
      .catch((err: unknown) => {
        setPhase("failed");
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  return createPortal(
    <div
      className="star-map-intake"
      role="dialog"
      aria-modal="true"
      aria-label={`New thread on ${props.target.label}`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy && !preparingImages) {
          event.stopPropagation();
          props.onClose();
        }
      }}
    >
      <button
        type="button"
        className="star-map-intake__backdrop"
        aria-label="Close intake"
        tabIndex={-1}
        onClick={() => {
          if (!busy && !preparingImages) props.onClose();
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
            disabled={busy || preparingImages}
            onClick={props.onClose}
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
            <p className="star-map-intake__hint">Which project?</p>
            {candidates.map((candidate) => (
              <button
                key={candidate.directoryKey}
                type="button"
                className="star-map-intake__candidate"
                onClick={() => submit(candidate.directoryKey)}
              >
                <span className="star-map-intake__candidate-label">
                  {candidate.label}
                </span>
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
            {attachmentError
              ?? (phase === "failed"
                ? error
                : preparingImages
                  ? "Preparing image…"
                  : PHASE_COPY[phase as StarMapIntakePhase] ?? "")}
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
