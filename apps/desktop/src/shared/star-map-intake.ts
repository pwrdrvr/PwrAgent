import type {
  FederationTarget,
  StarMapIntakeRequest,
} from "@pwragent/shared";

export const MAX_STAR_MAP_INTAKE_IMAGE_UPLOADS = 5;

/**
 * Renderer-to-main image upload for Star Map intake. Electron transports the
 * typed array with structured clone; this shape must never be forwarded in a
 * federation JSON-RPC envelope. The main process stages the bytes first and
 * sends only attachment references into backend and federation contracts.
 */
export type StarMapIntakeImageUpload = {
  bytes: Uint8Array;
  mimeType: string;
  name: string;
};

// Deliberately omit backend attachment paths: only the main process may mint
// those after staging renderer bytes under the active PwrAgent profile.
export type StarMapIntakeDispatchRequest = Omit<
  StarMapIntakeRequest,
  "attachments"
> & {
  federationTarget?: FederationTarget;
  imageUploads?: StarMapIntakeImageUpload[];
};
