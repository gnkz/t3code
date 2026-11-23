import {
  EDITORS,
  type ContextMenuItem,
  type EditorId,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";

import { resolveDiffPathForWorkspace } from "./diffFileActions";
import { fileDownloadResource, useFileDownload } from "./fileDownload";
import {
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "~/components/preview/fileExplorerLabel";
import { readLocalApi } from "./localApi";
import { serverEnvironment } from "./state/server";
import { shellEnvironment } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import { toastManager } from "./components/ui/toast";
import { useAtomValue } from "@effect/atom-react";
import { msg, useMessages } from "gt-react";

import type { MessageResolver } from "./i18n/messages";

export type FileContextMenuAction =
  | "reveal-in-folder"
  | "open"
  | "download"
  /** Submenu parent; never the activated id. */
  | "open-with"
  | `editor:${EditorId}`;

export interface FileContextMenuTarget {
  readonly environmentId: EnvironmentId | null;
  /** Repo- or workspace-relative file path, as shown in diffs. */
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly repositoryRoot?: string | undefined;
  /** Folders cannot be downloaded; the file tree builds targets for them too. */
  readonly isDirectory?: boolean | undefined;
}

export function resolveFileContextMenuAbsolutePath(target: FileContextMenuTarget): string | null {
  const workspaceFilePath = resolveDiffPathForWorkspace({
    filePath: target.filePath,
    workspaceRoot: target.workspaceRoot,
    repositoryRoot: target.repositoryRoot,
  });
  if (workspaceFilePath === null) return null;
  if (target.workspaceRoot === undefined) {
    return workspaceFilePath.startsWith("/") || /^[a-zA-Z]:/.test(workspaceFilePath)
      ? workspaceFilePath
      : null;
  }
  // Menu targets name workspace files, not chat links: `~/x` and `notes:0` are literal names.
  return joinWorkspacePath(target.workspaceRoot, workspaceFilePath);
}

/**
 * A workspace-relative name joined to its root literally, with no home or line-link meaning. Only
 * the root's own separator is trimmed: on POSIX `/work/repo\` is a different folder from `/work/repo`.
 */
export function joinWorkspacePath(workspaceRoot: string, relativePath: string): string {
  if (relativePath === "") return workspaceRoot;
  const windows = isWindowsAbsolutePath(workspaceRoot);
  const root = workspaceRoot.replace(windows ? /[/\\]+$/ : /\/+$/, "");
  return windows ? `${root}\\${relativePath.replaceAll("/", "\\")}` : `${root}/${relativePath}`;
}

const EDITOR_LABEL_BY_ID = new Map(EDITORS.map((editor) => [editor.id, editor.label]));

export interface FileContextMenuCapabilities {
  readonly revealLabel: string | undefined;
  readonly canOpenDefault: boolean;
  readonly editorIds: ReadonlyArray<EditorId>;
  readonly canDownload: boolean;
}

function canDownloadTarget(
  target: FileContextMenuTarget,
  absolutePath: string | null,
  capabilities: FileContextMenuCapabilities,
): absolutePath is string {
  return (
    capabilities.canDownload &&
    absolutePath !== null &&
    target.isDirectory !== true &&
    fileDownloadResource({ path: absolutePath, workspaceRoot: target.workspaceRoot }) !== null
  );
}

export function buildFileContextMenuItems(input: {
  readonly target: FileContextMenuTarget;
  readonly capabilities: FileContextMenuCapabilities;
  readonly resolve: MessageResolver;
}): readonly ContextMenuItem<FileContextMenuAction>[] {
  const absolutePath = resolveFileContextMenuAbsolutePath(input.target);
  if (absolutePath === null) return [];
  const items: ContextMenuItem<FileContextMenuAction>[] = [];
  if (input.capabilities.canOpenDefault) {
    items.push({
      id: "open",
      label: input.resolve(msg("Open", { $context: "verb, opens a file" })),
      icon: "pencil",
    });
  }
  if (input.capabilities.revealLabel !== undefined) {
    items.push({
      id: "reveal-in-folder",
      label: input.capabilities.revealLabel,
      icon: "folder-tree",
    });
  }
  const editorIds = input.capabilities.editorIds.filter((id) => id !== "file-manager");
  if (editorIds.length > 0) {
    items.push({
      id: "open-with",
      label: input.resolve(msg("Open with")),
      children: editorIds.map((editorId) => ({
        id: `editor:${editorId}` as FileContextMenuAction,
        label: EDITOR_LABEL_BY_ID.get(editorId) ?? editorId,
      })),
    });
  }
  if (canDownloadTarget(input.target, absolutePath, input.capabilities)) {
    items.push({
      id: "download",
      label: input.resolve(msg("Download", { $context: "verb, saves a file to this computer" })),
      icon: "download",
    });
  }
  return items;
}

/** `threadId`, a saved thread's, lets Download use the path older servers already sign. */
export function useFileContextMenu(
  environmentId: EnvironmentId | null,
  threadId?: ThreadId | null,
) {
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const resolve = useMessages();
  const fileDownload = useFileDownload(environmentId);

  const availableEditors = serverConfig?.availableEditors ?? [];
  const capabilities: FileContextMenuCapabilities = {
    // WSL can reveal in Windows Explorer despite reporting Linux; use server wording.
    revealLabel:
      environmentId !== null &&
      serverConfig?.shellRevealInFileManager === true &&
      serverConfig.availableEditors.includes("file-manager")
        ? serverConfig.shellRevealInFileManagerKind === undefined
          ? revealInFileExplorerLabelForOs(serverConfig.environment.platform.os, resolve)
          : revealInFileExplorerLabelForKind(serverConfig.shellRevealInFileManagerKind, resolve)
        : undefined,
    canOpenDefault: availableEditors.includes("file-manager"),
    editorIds: availableEditors,
    canDownload: fileDownload.canDownload,
  };

  const activate = async (
    action: FileContextMenuAction,
    target: FileContextMenuTarget,
  ): Promise<void> => {
    const absolutePath = resolveFileContextMenuAbsolutePath(target);
    if (absolutePath === null || environmentId === null) return;
    if (action === "download") {
      if (canDownloadTarget(target, absolutePath, capabilities)) {
        fileDownload.download({
          path: absolutePath,
          threadId,
          workspaceRoot: target.workspaceRoot,
        });
      }
      return;
    }

    const reveal = action === "reveal-in-folder";
    const editor =
      action === "open" || reveal
        ? ("file-manager" as const)
        : (action.slice("editor:".length) as EditorId);
    if (action !== "open" && !reveal && !capabilities.editorIds.includes(editor)) return;

    const result = await openInEditor({
      environmentId,
      input: { cwd: absolutePath, editor, ...(reveal ? { reveal: true } : {}) },
    });
    if (result._tag !== "Failure") return;
    toastManager.add({
      type: "error",
      title:
        action === "open"
          ? resolve(msg("Could not open file"))
          : reveal
            ? resolve(msg("Unable to reveal file"))
            : resolve(
                msg("Could not open in {editor}", {
                  editor: EDITOR_LABEL_BY_ID.get(editor) ?? editor,
                }),
              ),
      description: absolutePath,
    });
  };

  const show = async (
    target: FileContextMenuTarget,
    position?: { x: number; y: number },
  ): Promise<void> => {
    const api = readLocalApi();
    const items = buildFileContextMenuItems({ target, capabilities, resolve });
    if (items.length === 0 || api === undefined) return;
    const clicked = await api.contextMenu.show(items, position);
    if (clicked === null) return;
    await activate(clicked as FileContextMenuAction, target);
  };

  return {
    buildItems: (target: FileContextMenuTarget) =>
      buildFileContextMenuItems({ target, capabilities, resolve }),
    capabilities,
    activate,
    show,
  };
}

export function useFileContextMenuHandler(
  environmentId: EnvironmentId | null,
  threadId?: ThreadId | null,
) {
  const contextMenu = useFileContextMenu(environmentId, threadId);
  return (target: FileContextMenuTarget, event?: { clientX: number; clientY: number }) => {
    void contextMenu.show(target, event ? { x: event.clientX, y: event.clientY } : undefined);
  };
}
