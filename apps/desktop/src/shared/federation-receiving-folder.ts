export type ReceivingFolderRequest = {
  action: "inspect" | "check" | "browse" | "reveal" | "privacy";
  /** Blank selects the receiver's default Downloads folder. */
  directory?: string;
};

export type ReceivingFolderResponse = {
  directory: string;
  privacySettingsSupported: boolean;
  /** OS privacy authorization is not exposed by the filesystem check. */
  privacyPermission: "unknown";
  access?: { status: "writable" | "failed"; message: string };
  canceled?: boolean;
};
