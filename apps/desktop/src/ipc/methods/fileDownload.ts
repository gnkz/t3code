import {
  DesktopFileDownloadResultSchema,
  type DesktopFileDownloadResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Electron from "electron";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

const FAILED: DesktopFileDownloadResult = { status: "failed" };

/** Only signed environment asset URLs, so this cannot become a general-purpose downloader. */
function isAssetDownloadUrl(url: string): boolean {
  const parsed = URL.parse(url);
  return (
    parsed !== null &&
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.pathname.startsWith("/api/assets/")
  );
}

interface PendingDownload {
  readonly webContentsId: number;
  readonly url: string;
  readonly claim: (item: Electron.DownloadItem) => void;
}

const pendingBySession = new WeakMap<Electron.Session, PendingDownload[]>();
const activeDownloads = new Set<Electron.DownloadItem>();

function pendingDownloads(session: Electron.Session): PendingDownload[] {
  const existing = pendingBySession.get(session);
  if (existing !== undefined) return existing;
  const pending: PendingDownload[] = [];
  pendingBySession.set(session, pending);
  // The renderer's own blob saves pass through here too; those keep Electron's default handling.
  session.on("will-download", (_event, item, webContents) => {
    // getURL() is the last hop of a redirect; the first entry is the URL this module asked for.
    const url = item.getURLChain()[0] ?? item.getURL();
    // Electron passes null when the initiating page is already gone; the signed URL still names it.
    const index = pending.findIndex(
      (entry) =>
        entry.url === url && (webContents === null || entry.webContentsId === webContents.id),
    );
    if (index === -1) return;
    const [entry] = pending.splice(index, 1);
    entry?.claim(item);
  });
  return pending;
}

function showProgress(window: Electron.BrowserWindow) {
  if (window.isDestroyed()) return;
  let received = 0;
  let total = 0;
  let sizeUnknown = false;
  for (const item of activeDownloads) {
    received += item.getReceivedBytes();
    total += item.getTotalBytes();
    sizeUnknown ||= item.getTotalBytes() <= 0;
  }
  // -1 removes the bar; a value above 1 is indeterminate while any size is unknown.
  window.setProgressBar(activeDownloads.size === 0 ? -1 : sizeUnknown ? 2 : received / total);
}

export const downloadFile = makeIpcMethod({
  channel: IpcChannels.DOWNLOAD_FILE_CHANNEL,
  payload: Schema.String,
  result: DesktopFileDownloadResultSchema,
  handler: Effect.fn("desktop.ipc.fileDownload.download")(function* (url, event) {
    const main = yield* (yield* ElectronWindow.ElectronWindow).main;
    if (
      event === undefined ||
      Option.isNone(main) ||
      main.value.webContents.id !== event.sender.id ||
      !isAssetDownloadUrl(url)
    ) {
      return FAILED;
    }
    const window = main.value;
    return yield* Effect.callback<DesktopFileDownloadResult>((resume) => {
      const pending = pendingDownloads(window.webContents.session);
      const entry: PendingDownload = {
        webContentsId: window.webContents.id,
        url,
        claim: (item) => {
          // The window closed before the server answered, so no one is left to choose where it goes.
          if (window.isDestroyed()) {
            item.cancel();
            resume(Effect.succeed({ status: "cancelled" }));
            return;
          }
          let interrupted = false;
          // Electron titles the Save dialog with the URL, which here carries the signed token.
          item.setSaveDialogOptions({ title: item.getFilename() });
          activeDownloads.add(item);
          showProgress(window);
          item.on("updated", (_updatedEvent, state) => {
            // A dropped connection pauses as resumable rather than ending; fail it so the user can retry.
            if (state === "interrupted") {
              interrupted = true;
              item.cancel();
              return;
            }
            showProgress(window);
          });
          item.once("done", (_doneEvent, state) => {
            activeDownloads.delete(item);
            showProgress(window);
            resume(
              Effect.succeed(
                state === "completed"
                  ? { status: "completed", path: item.getSavePath() }
                  : state === "cancelled" && !interrupted
                    ? { status: "cancelled" }
                    : FAILED,
              ),
            );
          });
        },
      };
      pending.push(entry);
      window.webContents.downloadURL(url);
      return Effect.sync(() => {
        const index = pending.indexOf(entry);
        if (index !== -1) pending.splice(index, 1);
      });
    });
  }),
});
