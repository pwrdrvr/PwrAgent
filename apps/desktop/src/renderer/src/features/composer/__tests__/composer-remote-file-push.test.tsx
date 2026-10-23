import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useMemo, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ComposerFilePushProgress,
  FederationHealthStatus,
  PushComposerFileResult,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { navigationQueryFixture } from "../../../test/navigation-query-fixture";
import { Composer as ProductionComposer } from "../Composer";

function Composer(props: ComponentProps<typeof ProductionComposer>) {
  const desktopApi = useMemo<DesktopApi>(() => ({
    ...props.desktopApi,
    getNavigationQueryPage: props.desktopApi?.getNavigationQueryPage
      ?? (async (request) => navigationQueryFixture(request, props)),
  }), [props.desktopApi, props.directories, props.threads]);
  return <ProductionComposer {...props} desktopApi={desktopApi} />;
}

const OWNER_ID = "pwr_owner";
const OWNER_LABEL = "studio-mac / default";
const target = { scope: "remote" as const, instanceId: OWNER_ID };

type Peer = FederationHealthStatus["peers"][number];

function health(peer: Partial<Peer> = {}): FederationHealthStatus {
  return {
    instanceId: "pwr_viewer",
    localLabel: "laptop",
    peers: [{
      id: OWNER_ID,
      label: OWNER_LABEL,
      role: "peer",
      status: "connected",
      capabilities: ["file_push", "turn_control"],
      receiverPermissions: { remoteShells: true, filePush: true },
      ...peer,
    } as Peer],
  } as unknown as FederationHealthStatus;
}

const remoteThread = {
  id: "thread-remote",
  title: "Remote thread",
  titleSource: "explicit" as const,
  source: "codex" as const,
  linkedDirectories: [],
  inbox: { inInbox: false },
  federation: {
    instanceLabel: OWNER_LABEL,
    ref: { backend: "codex" as const, threadId: "thread-remote", target },
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function dropFile(name: string) {
  const file = new File(["report"], name, { type: "application/pdf" });
  fireEvent.drop(screen.getByLabelText("Reply"), {
    dataTransfer: {
      files: [],
      items: [{ kind: "file", type: "application/pdf", getAsFile: () => file }],
    },
  });
}

function renderRemoteComposer(api: Partial<DesktopApi>, extra: Partial<ComponentProps<typeof ProductionComposer>> = {}) {
  let progressListener: ((progress: ComposerFilePushProgress) => void) | undefined;
  const readFederationHealth = api.readFederationHealth
    ?? vi.fn(async () => ({ health: health() }));
  const desktopApi: DesktopApi = {
    onAgentEvent: () => () => undefined,
    getPathForFile: (file: File) => `/Users/viewer/Desktop/${file.name}`,
    readFederationHealth,
    onComposerFilePushProgress: (listener) => {
      progressListener = listener;
      return () => {
        progressListener = undefined;
      };
    },
    cancelComposerFilePush: vi.fn(async () => undefined),
    ...api,
  } as DesktopApi;
  render(
    <Composer
      desktopApi={desktopApi}
      disabled={false}
      skills={[]}
      thread={remoteThread}
      {...extra}
    />,
  );
  return {
    desktopApi,
    healthLoaded: async () => {
      await waitFor(() => expect(readFederationHealth).toHaveBeenCalled());
      await act(async () => undefined);
    },
    emitProgress: (progress: ComposerFilePushProgress) => {
      act(() => progressListener?.(progress));
    },
  };
}

afterEach(() => {
  cleanup();
});

describe("Composer file attachments on a remote thread", () => {
  it("copies a dropped file to the owner and attaches the owner's copy", async () => {
    const push = deferred<PushComposerFileResult>();
    const pushComposerFile = vi.fn(() => push.promise);
    const startTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-remote",
      turnId: "turn-1",
    }));
    const { emitProgress, healthLoaded } = renderRemoteComposer({ pushComposerFile, startTurn });
    // Health loads asynchronously; the owner's name comes from it.
    await healthLoaded();

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "Read this" },
    });
    dropFile("report.pdf");

    await waitFor(() => expect(pushComposerFile).toHaveBeenCalledTimes(1));
    const request = (pushComposerFile.mock.calls[0] as unknown as [{ uploadId: string }])[0];
    expect(request).toEqual({
      uploadId: expect.any(String),
      target,
      sourcePath: "/Users/viewer/Desktop/report.pdf",
    });
    expect(
      await screen.findByText(`Copying 1 file to ${OWNER_LABEL}. Send waits until it finishes.`),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    emitProgress({ uploadId: request.uploadId, sentBytes: 512, totalBytes: 1024 });
    expect(screen.getByText("50%")).toBeInTheDocument();

    await act(async () => {
      push.resolve({
        path: "/Users/owner/Downloads/report.pdf",
        sizeBytes: 1024,
        sha256: "abc",
      });
    });

    const remove = await screen.findByRole("button", { name: "Remove report.pdf" });
    expect(screen.queryByText(/Copying 1 file/)).not.toBeInTheDocument();
    fireEvent.focus(remove.parentElement!);
    expect(
      await screen.findByText(`On ${OWNER_LABEL}: /Users/owner/Downloads/report.pdf`),
    ).toBeInTheDocument();
    fireEvent.blur(remove.parentElement!);
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeEnabled();
    fireEvent.click(send);

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.arrayContaining([
            {
              type: "localFile",
              name: "report.pdf",
              path: "/Users/owner/Downloads/report.pdf",
            },
          ]),
        }),
      );
    });
  });

  it("keeps a failed copy in the tray with its reason and retries it", async () => {
    const pushComposerFile = vi.fn()
      .mockRejectedValueOnce(
        new Error("Error invoking remote method 'federation:push-composer-file': Error: Files must be at most 512 MiB."),
      )
      .mockResolvedValueOnce({
        path: "/Users/owner/Downloads/big.bin",
        sizeBytes: 2,
        sha256: "def",
      });
    const { healthLoaded } = renderRemoteComposer({ pushComposerFile });
    await healthLoaded();

    dropFile("big.bin");

    expect(
      await screen.findByText(
        `big.bin did not copy to ${OWNER_LABEL}: Files must be at most 512 MiB. Retry or remove it to send.`,
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("button", { name: "Remove big.bin" })).toBeInTheDocument();
    expect(pushComposerFile).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/did not copy/)).not.toBeInTheDocument();
  });

  it("cancels the transfer when an uploading pill is removed", async () => {
    const pushComposerFile = vi.fn(() => new Promise<PushComposerFileResult>(() => undefined));
    const { desktopApi, healthLoaded } = renderRemoteComposer({ pushComposerFile });
    await healthLoaded();

    dropFile("notes.pdf");
    fireEvent.click(await screen.findByRole("button", { name: "Cancel copying notes.pdf" }));

    const request = (pushComposerFile.mock.calls[0] as unknown as [{ uploadId: string }])[0];
    expect(desktopApi.cancelComposerFilePush).toHaveBeenCalledWith({
      uploadId: request.uploadId,
    });
    expect(screen.queryByText("notes.pdf")).not.toBeInTheDocument();
    expect(screen.queryByText(/Copying/)).not.toBeInTheDocument();
  });

  it("names the owner's setting when it refuses incoming files", async () => {
    const pushComposerFile = vi.fn();
    const onShowNotice = vi.fn();
    const readFederationHealth = vi.fn(async () => ({
      health: health({
        receiverPermissions: { remoteShells: true, filePush: false },
      }),
    }));
    const { healthLoaded } = renderRemoteComposer(
      { pushComposerFile, readFederationHealth },
      { onShowNotice },
    );
    await healthLoaded();

    dropFile("report.pdf");

    expect(onShowNotice).toHaveBeenCalledWith(expect.objectContaining({
      title: `Can't send files to ${OWNER_LABEL}`,
      message: "Turn on Allow file push in that machine's Federation settings.",
    }));
    expect(pushComposerFile).not.toHaveBeenCalled();
  });
});
