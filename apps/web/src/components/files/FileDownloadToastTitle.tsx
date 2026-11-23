import { T, Var } from "gt-react";

import { useTheme } from "~/hooks/useTheme";
import { documentChipKindForFileName } from "~/pierre-icons";
import { ContextChip } from "../ContextChip";
import { FileTagChipContent } from "../chat/FileTagChip";

export type FileDownloadToastPhase = "downloading" | "downloaded" | "failed";

/** The chat file chip, display only: no environment, so the icon comes from the name alone. */
function FileDownloadChip({ name }: { name: string }) {
  const { resolvedTheme } = useTheme();
  return (
    <ContextChip kind={documentChipKindForFileName(name) ?? "mention"} dir="ltr">
      <FileTagChipContent path={name} label={name} theme={resolvedTheme} />
    </ContextChip>
  );
}

export function FileDownloadToastTitle({
  phase,
  name,
}: {
  phase: FileDownloadToastPhase;
  name: string;
}) {
  const chip = <FileDownloadChip name={name} />;
  if (phase === "downloading") {
    return (
      <T>
        Downloading <Var>{chip}</Var>
      </T>
    );
  }
  if (phase === "downloaded") {
    return (
      <T>
        Downloaded <Var>{chip}</Var>
      </T>
    );
  }
  return (
    <T>
      Could not download <Var>{chip}</Var>
    </T>
  );
}
