import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ComponentProps } from "react";

type Props = {
  confirmingCommit: boolean;
  warnings: string[] | undefined;
  restoreFocus: ComponentProps<typeof DialogContent>["onCloseAutoFocus"];
  onCancel: () => void;
  onCommit: () => void;
};

export function BatchCommitDialog({
  confirmingCommit,
  warnings,
  restoreFocus,
  onCancel,
  onCommit,
}: Props) {
  return (
    <Dialog
      open={confirmingCommit}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent onCloseAutoFocus={restoreFocus}>
        <DialogHeader>
          <DialogTitle>Commit with fallback values?</DialogTitle>
          <DialogDescription>
            The check found values that would be saved from a fallback rather
            than from the file.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          {warnings?.map((warning: string) => (
            <p key={warning}>{warning}</p>
          ))}
          <p>
            Committed records keep these values until a reviewed correction
            changes them.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onCancel()}>
            Review the mapping
          </Button>
          <Button
            onClick={() => {
              onCancel();
              onCommit();
            }}
          >
            Commit anyway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
