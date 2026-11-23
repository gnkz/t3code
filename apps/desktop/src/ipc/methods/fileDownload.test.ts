import * as NodeEvents from "node:events";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { downloadFile } from "./fileDownload.ts";

const ASSET_URL = "https://remote.example/api/assets/token/report.pdf";

class FakeDownloadItem extends NodeEvents.EventEmitter {
  received = 0;
  cancel = vi.fn(() => {
    this.emit("done", {}, "cancelled");
  });
  readonly chain: readonly string[];
  total = 10;
  contentDisposition = 'attachment; filename="report.pdf"';
  constructor(...chain: string[]) {
    super();
    this.chain = chain;
  }
  getURL = () => this.chain.at(-1) ?? "";
  getURLChain = () => this.chain;
  getReceivedBytes = () => this.received;
  getTotalBytes = () => this.total;
  getSavePath = () => "/Users/me/Downloads/report.pdf";
  getFilename = () => "report.pdf";
  getContentDisposition = () => this.contentDisposition;
  mimeType = "application/octet-stream";
  getMimeType = () => this.mimeType;
  setSaveDialogOptions = vi.fn();
}

function makeWindow({ emit = true } = {}) {
  const session = new NodeEvents.EventEmitter();
  const items: FakeDownloadItem[] = [];
  const redirects: string[] = [];
  const webContents = { id: 1, session, downloadURL: (_url: string) => {} };
  const downloadURL = vi.fn((url: string) => {
    const item = new FakeDownloadItem(url, ...redirects);
    items.push(item);
    if (emit) session.emit("will-download", {}, item, main.webContents);
  });
  webContents.downloadURL = downloadURL;
  const setProgressBar = vi.fn();
  const window = {
    webContents,
    destroyed: false,
    isDestroyed: () => window.destroyed,
    setProgressBar,
  };
  let main: { webContents: { id: number } } = window;
  // macOS keeps the app running with no window; reopening makes a new one on the same session.
  const reopen = () => {
    const reopened = {
      webContents: { ...webContents, id: 2 },
      isDestroyed: () => false,
      setProgressBar: vi.fn(),
    };
    main = reopened;
    return reopened;
  };
  const run = (url: string, sender = 1) =>
    downloadFile.handler(url, { sender: { id: sender } }).pipe(
      Effect.provideService(ElectronWindow.ElectronWindow, {
        main: Effect.sync(() => Option.some(main)),
      } as unknown as ElectronWindow.ElectronWindow["Service"]),
    );
  return {
    session,
    window,
    webContents,
    items,
    redirects,
    downloadURL,
    setProgressBar,
    reopen,
    run,
  };
}

it.effect("downloads only signed asset URLs requested by the app window", () =>
  Effect.gen(function* () {
    const { downloadURL, run } = makeWindow();
    for (const [url, sender] of [
      [ASSET_URL, 2],
      ["file:///api/assets/token/report.pdf", 1],
      ["https://remote.example/api/other/report.pdf", 1],
      ["https://user:secret@remote.example/api/assets/token/report.pdf", 1],
      ["not a url", 1],
    ] as const) {
      assert.deepEqual(yield* run(url, sender), { status: "failed" });
    }
    assert.strictEqual(downloadURL.mock.calls.length, 0);
  }),
);

it.effect("reports where a download was saved and tracks its progress", () =>
  Effect.gen(function* () {
    const { items, setProgressBar, run } = makeWindow();
    const fiber = yield* Effect.forkChild(run(ASSET_URL), { startImmediately: true });
    const [item] = items;
    assert.isDefined(item);
    assert.deepEqual(item.setSaveDialogOptions.mock.calls, [[{ title: "report.pdf" }]]);
    item.received = 5;
    item.emit("updated", {}, "progressing");
    item.emit("done", {}, "completed");
    assert.deepEqual(yield* Fiber.join(fiber), {
      status: "completed",
      path: "/Users/me/Downloads/report.pdf",
    });
    assert.deepEqual(setProgressBar.mock.calls, [[0], [0.5], [-1]]);
  }),
);

it.effect("tells a cancelled Save dialog apart from a failed transfer", () =>
  Effect.gen(function* () {
    const { items, run } = makeWindow();
    const settle = Effect.fnUntraced(function* (finish: (item: FakeDownloadItem) => void) {
      const fiber = yield* Effect.forkChild(run(ASSET_URL), { startImmediately: true });
      const item = items.at(-1);
      assert.isDefined(item);
      finish(item);
      return yield* Fiber.join(fiber);
    });
    assert.deepEqual(yield* settle((item) => item.emit("done", {}, "cancelled")), {
      status: "cancelled",
    });
    assert.deepEqual(yield* settle((item) => item.emit("done", {}, "interrupted")), {
      status: "failed",
    });
    // A dropped connection only pauses the item; it must not wait forever or read as a cancel.
    const dropped = yield* settle((item) => item.emit("updated", {}, "interrupted"));
    assert.deepEqual(dropped, { status: "failed" });
    assert.strictEqual(items.at(-1)?.cancel.mock.calls.length, 1);
  }),
);

it.effect(
  "claims its own download after a redirect, and leaves every other download to Electron",
  () =>
    Effect.gen(function* () {
      const { session, webContents, items, redirects, run } = makeWindow({ emit: false });
      redirects.push("https://cdn.remote.example/report.pdf");
      const fiber = yield* Effect.forkChild(run(ASSET_URL), { startImmediately: true });
      const blob = new FakeDownloadItem("blob:t3code://app/1234");
      const otherTab = new FakeDownloadItem(ASSET_URL);
      session.emit("will-download", {}, blob, webContents);
      session.emit("will-download", {}, otherTab, { id: 2 });
      session.emit("will-download", {}, new FakeDownloadItem("blob:t3code://app/5678"), null);
      const [own] = items;
      assert.isDefined(own);
      session.emit("will-download", {}, own, webContents);
      assert.deepEqual(
        [blob, otherTab, own].map((item) => item.listenerCount("done")),
        [0, 0, 1],
      );
      own.emit("done", {}, "completed");
      assert.deepEqual(yield* Fiber.join(fiber), {
        status: "completed",
        path: "/Users/me/Downloads/report.pdf",
      });
    }),
);

it.effect("cancels a download that starts after its window has closed", () =>
  Effect.gen(function* () {
    const { session, window, run } = makeWindow({ emit: false });
    const fiber = yield* Effect.forkChild(run(ASSET_URL), { startImmediately: true });
    window.destroyed = true;
    const late = new FakeDownloadItem(ASSET_URL);
    // Electron reports no web contents once the page that asked for the download is gone.
    session.emit("will-download", {}, late, null);
    assert.strictEqual(late.cancel.mock.calls.length, 1);
    assert.strictEqual(late.setSaveDialogOptions.mock.calls.length, 0);
    assert.deepEqual(yield* Fiber.join(fiber), { status: "cancelled" });
  }),
);

it.effect("shows an indeterminate bar while any running download has no known size", () =>
  Effect.gen(function* () {
    const { items, setProgressBar, run } = makeWindow();
    const sized = yield* Effect.forkChild(run(ASSET_URL), { startImmediately: true });
    const unsized = yield* Effect.forkChild(run(`${ASSET_URL}?2`), { startImmediately: true });
    const [known, unknown] = items;
    assert.isDefined(known);
    assert.isDefined(unknown);
    unknown.total = 0;
    unknown.received = 700;
    known.received = 6;
    known.emit("updated", {}, "progressing");
    assert.deepEqual(setProgressBar.mock.calls.at(-1), [2]);
    unknown.emit("done", {}, "completed");
    known.emit("updated", {}, "progressing");
    assert.deepEqual(setProgressBar.mock.calls.at(-1), [0.6]);
    known.emit("done", {}, "completed");
    yield* Fiber.join(sized);
    yield* Fiber.join(unsized);
  }),
);

it.effect("fails a response that is not the asset's attachment before asking where to save", () =>
  Effect.gen(function* () {
    const { session, webContents, items, run } = makeWindow({ emit: false });
    const fiber = yield* Effect.forkChild(run(ASSET_URL), { startImmediately: true });
    const [item] = items;
    assert.isDefined(item);
    // A proxy in front of the server can answer the signed URL with its own login page.
    item.contentDisposition = "";
    item.mimeType = "text/html";
    session.emit("will-download", {}, item, webContents);
    assert.strictEqual(item.cancel.mock.calls.length, 1);
    assert.strictEqual(item.setSaveDialogOptions.mock.calls.length, 0);
    assert.deepEqual(yield* Fiber.join(fiber), { status: "failed" });
  }),
);

it.effect("keeps the progress bar on the window that is open now", () =>
  Effect.gen(function* () {
    const { window, items, reopen, run } = makeWindow();
    const first = yield* Effect.forkChild(run(ASSET_URL), { startImmediately: true });
    window.destroyed = true;
    const reopened = reopen();
    const second = yield* Effect.forkChild(run(`${ASSET_URL}?2`, 2), { startImmediately: true });
    const [earlier, later] = items;
    assert.isDefined(earlier);
    assert.isDefined(later);
    later.emit("done", {}, "completed");
    earlier.received = 10;
    earlier.emit("updated", {}, "progressing");
    assert.deepEqual(reopened.setProgressBar.mock.calls.at(-1), [1]);
    earlier.emit("done", {}, "completed");
    assert.deepEqual(reopened.setProgressBar.mock.calls.at(-1), [-1]);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
  }),
);

it.effect("keeps an octet-stream response whose proxy dropped the attachment header", () =>
  Effect.gen(function* () {
    const { session, webContents, items, run } = makeWindow({ emit: false });
    const fiber = yield* Effect.forkChild(run(ASSET_URL), { startImmediately: true });
    const [item] = items;
    assert.isDefined(item);
    item.contentDisposition = "";
    session.emit("will-download", {}, item, webContents);
    assert.strictEqual(item.cancel.mock.calls.length, 0);
    item.emit("done", {}, "completed");
    assert.deepEqual(yield* Fiber.join(fiber), {
      status: "completed",
      path: "/Users/me/Downloads/report.pdf",
    });
  }),
);
