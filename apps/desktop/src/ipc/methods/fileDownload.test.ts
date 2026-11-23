import * as NodeEvents from "node:events";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
  readonly total = 10;
  constructor(...chain: string[]) {
    super();
    this.chain = chain;
  }
  getURL = () => this.chain.at(-1) ?? "";
  getURLChain = () => this.chain;
  getReceivedBytes = () => this.received;
  getTotalBytes = () => this.total;
  getSavePath = () => "/Users/me/Downloads/report.pdf";
}

function makeWindow({ emit = true } = {}) {
  const session = new NodeEvents.EventEmitter();
  const items: FakeDownloadItem[] = [];
  const redirects: string[] = [];
  const webContents = { id: 1, session, downloadURL: (_url: string) => {} };
  const downloadURL = vi.fn((url: string) => {
    const item = new FakeDownloadItem(url, ...redirects);
    items.push(item);
    if (emit) session.emit("will-download", {}, item, webContents);
  });
  webContents.downloadURL = downloadURL;
  const setProgressBar = vi.fn();
  const window = {
    webContents,
    isDestroyed: () => false,
    setProgressBar,
  };
  const run = (url: string, sender = 1) =>
    downloadFile.handler(url, { sender: { id: sender } }).pipe(
      Effect.provideService(ElectronWindow.ElectronWindow, {
        main: Effect.succeedSome(window),
      } as unknown as ElectronWindow.ElectronWindow["Service"]),
    );
  return { session, webContents, items, redirects, downloadURL, setProgressBar, run };
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
