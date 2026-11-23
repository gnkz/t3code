import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { canDownloadFromEnvironment, fileDownloadResource } from "./fileDownload";
import type { RemoteOpenResolution } from "./remoteOpen";

describe("canDownloadFromEnvironment", () => {
  it("offers downloads only from another machine the session may read", () => {
    const resolution = (
      mode: RemoteOpenResolution["state"]["mode"],
      isResolved = true,
    ): RemoteOpenResolution => ({
      isResolved,
      state:
        mode === "remote-links" ? { mode, host: { kind: "ssh-alias", host: "devbox" } } : { mode },
    });
    expect(canDownloadFromEnvironment(resolution("remote-links"), true)).toBe(true);
    expect(canDownloadFromEnvironment(resolution("remote-unavailable"), true)).toBe(true);
    expect(canDownloadFromEnvironment(resolution("local-exec"), true)).toBe(false);
    // Unresolved reads as local-exec; it must not flash a remote-only action.
    expect(canDownloadFromEnvironment(resolution("remote-links", false), true)).toBe(false);
    expect(canDownloadFromEnvironment(resolution("remote-links"), false)).toBe(false);
  });
});

describe("fileDownloadResource", () => {
  it("scopes the download to the thread, else the workspace, else offers nothing", () => {
    const threadId = ThreadId.make("thread-1");
    const path = "/home/me/project/report.pdf";
    expect(fileDownloadResource({ path, threadId, workspaceRoot: "/home/me/project" })).toEqual({
      _tag: "media-file",
      threadId,
      path,
      disposition: "attachment",
      hostOnly: true,
    });
    expect(fileDownloadResource({ path, workspaceRoot: "/home/me/project" })).toEqual({
      _tag: "draft-workspace-file",
      cwd: "/home/me/project",
      path,
      disposition: "attachment",
    });
    expect(fileDownloadResource({ path })).toBeNull();
  });
});
