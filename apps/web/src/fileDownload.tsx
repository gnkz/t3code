import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AssetPreviewTypeValidationError,
  AssetWorkspaceAssetNotFoundError,
  AuthFilesystemReadScope,
  type AssetResource,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { msg } from "gt-react";

import { resolveAssetUrl } from "./assets/assetUrls";
import { FileDownloadToastTitle } from "./components/files/FileDownloadToastTitle";
import { downloadMedia } from "./components/media/mediaContent";
import { toastManager } from "./components/ui/toast";
import { m } from "./i18n/messages";
import { useRemoteOpenResolution, type RemoteOpenResolution } from "./remoteOpen";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { assetEnvironment } from "./state/assets";
import { readPreparedConnection, useEnvironmentScope } from "./state/session";

/** A file on the environment's host. Without a thread or a workspace root there is no asset scope. */
export interface FileDownloadTarget {
  /** Absolute, or relative to the thread's workspace. */
  readonly path: string;
  readonly threadId?: ThreadId | null | undefined;
  readonly workspaceRoot?: string | null | undefined;
}

export function fileDownloadResource(target: FileDownloadTarget): AssetResource | null {
  if (target.threadId) {
    return {
      _tag: "media-file",
      threadId: target.threadId,
      path: target.path,
      disposition: "attachment",
      // Never fall back to a same-path file on the client's own machine.
      hostOnly: true,
    };
  }
  if (target.workspaceRoot) {
    return {
      _tag: "draft-workspace-file",
      cwd: target.workspaceRoot,
      path: target.path,
      disposition: "attachment",
    };
  }
  return null;
}

/** Downloading is for getting a file onto this computer, so the client's own host never offers it. */
export function canDownloadFromEnvironment(
  remoteOpen: RemoteOpenResolution,
  canReadFiles: boolean,
): boolean {
  return remoteOpen.isResolved && remoteOpen.state.mode !== "local-exec" && canReadFiles;
}

const isAssetNotFoundError = Schema.is(AssetWorkspaceAssetNotFoundError);
// Older servers only sign previewable workspace files, even as attachments.
const isPreviewOnlyServerError = Schema.is(AssetPreviewTypeValidationError);

function hostPathBasename(path: string): string {
  return path.split(/[\\/]/).findLast((part) => part.length > 0) ?? path;
}

async function mintDownloadUrl(
  environmentId: EnvironmentId,
  resource: AssetResource,
): Promise<string> {
  const reconnect = () => new Error(m(msg("Reconnect to the environment and try again.")));
  if (readPreparedConnection(environmentId) === null) throw reconnect();
  const result = await executeAtomQuery(
    appAtomRegistry,
    assetEnvironment.createUrl({ environmentId, input: { resource } }),
    { reportFailure: false, refresh: true },
  );
  if (result._tag === "Failure") {
    const cause = squashAtomCommandFailure(result);
    if (isAssetNotFoundError(cause)) {
      throw new Error(m(msg("The file was not found. It may have been moved or deleted.")));
    }
    if (isPreviewOnlyServerError(cause)) {
      throw new Error(m(msg("Update T3 Code on that machine to download this file.")));
    }
    throw cause;
  }
  // Read after minting: a mint that retried on another route must use that route's address.
  const connection = readPreparedConnection(environmentId);
  const url =
    connection === null ? null : resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl);
  if (url === null) throw reconnect();
  return url;
}

/** Desktop streams to disk from the main process; browsers buffer the file, then save it. */
async function saveDownload(url: string, name: string) {
  const downloadFile = window.desktopBridge?.downloadFile;
  if (downloadFile === undefined) {
    // The asset route serves every download as octet-stream; anything else is not the file.
    await downloadMedia(url, name, "application/octet-stream");
    return { status: "saved" as const };
  }
  return downloadFile(url);
}

async function downloadHostFile(
  environmentId: EnvironmentId,
  target: FileDownloadTarget,
): Promise<void> {
  const resource = fileDownloadResource(target);
  if (resource === null) return;
  const name = hostPathBasename(target.path);
  const toastId = toastManager.add({
    type: "info",
    title: <FileDownloadToastTitle phase="downloading" name={name} />,
    timeout: 0,
    data: { hideCopyButton: true },
  });
  const outcome = await mintDownloadUrl(environmentId, resource)
    .then((url) => saveDownload(url, name))
    .catch((cause: unknown) => ({ status: "error" as const, cause }));
  toastManager.close(toastId);
  if (outcome.status === "saved" || outcome.status === "cancelled") return;
  if (outcome.status === "completed") {
    toastManager.add({
      type: "success",
      title: <FileDownloadToastTitle phase="downloaded" name={name} />,
      description: outcome.path,
      data: { hideCopyButton: true },
    });
    return;
  }
  toastManager.add({
    type: "error",
    title: <FileDownloadToastTitle phase="failed" name={name} />,
    description:
      outcome.status === "error"
        ? (thrownErrorMessage(outcome.cause, m) ?? m(msg("Please try again.")))
        : m(
            msg(
              "The download did not finish. Check the connection, or update T3 Code on that machine, then try again.",
            ),
          ),
  });
}

export function useFileDownload(environmentId: EnvironmentId | null) {
  const remoteOpen = useRemoteOpenResolution(environmentId);
  const canReadFiles = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const canDownload =
    environmentId !== null && canDownloadFromEnvironment(remoteOpen, canReadFiles);
  return {
    canDownload,
    download: (target: FileDownloadTarget) => {
      if (environmentId === null || !canDownload) return;
      void downloadHostFile(environmentId, target);
    },
  };
}
