import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFileContextMenuItems,
  joinWorkspacePath,
  resolveFileContextMenuAbsolutePath,
} from "./fileContextMenu";
import { m } from "./i18n/messages";

const BASE_TARGET = {
  environmentId: EnvironmentId.make("environment-local"),
  filePath: "src/index.ts",
  workspaceRoot: "/workspace/project",
};

describe("resolveFileContextMenuAbsolutePath", () => {
  it("strips the repository prefix when the repo root is nested in the workspace", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: "/workspace/project/packages/app",
        repositoryRoot: "/workspace/project",
        filePath: "packages/app/src/index.ts",
      }),
    ).toBe("/workspace/project/packages/app/src/index.ts");
  });

  it("returns null for paths outside the workspace when a repository root is set", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: "/workspace/project/packages/app",
        repositoryRoot: "/workspace/project",
        filePath: "other/src/index.ts",
      }),
    ).toBeNull();
  });

  it("joins workspace names literally, never as home or line links", () => {
    for (const filePath of ["~/report.txt", "notes:0", "notes:01"]) {
      expect(resolveFileContextMenuAbsolutePath({ ...BASE_TARGET, filePath })).toBe(
        `/workspace/project/${filePath}`,
      );
    }
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: "C:\\work\\project",
        filePath: "src/index.ts",
      }),
    ).toBe("C:\\work\\project\\src\\index.ts");
  });

  it("keeps a POSIX root's trailing backslash, which names a different folder", () => {
    expect(joinWorkspacePath("/work/repo\\", "report.txt")).toBe("/work/repo\\/report.txt");
    expect(joinWorkspacePath("/work/repo/", "report.txt")).toBe("/work/repo/report.txt");
    expect(joinWorkspacePath("C:\\work\\", "src/a.ts")).toBe("C:\\work\\src\\a.ts");
    expect(joinWorkspacePath("/", "report.txt")).toBe("/report.txt");
  });

  it("rejects absolute paths without a workspace root, matching diff path resolution", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: undefined,
        filePath: "/absolute/src/index.ts",
      }),
    ).toBeNull();
  });
});

describe("buildFileContextMenuItems", () => {
  const capabilities = {
    revealLabel: undefined,
    canOpenDefault: false,
    editorIds: [],
    canDownload: true,
  };
  const ids = (
    target: Parameters<typeof buildFileContextMenuItems>[0]["target"],
    canDownload = true,
  ) =>
    buildFileContextMenuItems({
      target,
      capabilities: { ...capabilities, canDownload },
      resolve: m,
    }).map((item) => item.id);

  it("offers Download for files on a remote machine, even when it is the only item", () => {
    expect(ids(BASE_TARGET)).toEqual(["download"]);
    expect(ids(BASE_TARGET, false)).toEqual([]);
  });

  it("never offers Download for folders", () => {
    expect(ids({ ...BASE_TARGET, isDirectory: true })).toEqual([]);
  });
});
