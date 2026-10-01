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
          <DialogTitle>Import with default values?</DialogTitle>
          <DialogDescription>
            Some values are not in the file, so Valo Pay will save default
            values instead.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          {warnings?.map((warning: string) => (
            <p key={warning}>{warning}</p>
          ))}
          <p>
            Imported records keep these values until a reviewed correction
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
            Import anyway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
