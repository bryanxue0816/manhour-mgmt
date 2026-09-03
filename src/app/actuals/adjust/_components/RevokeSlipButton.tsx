"use client";

// Revokes one stored slip, from the 已有调整单 panel.
//
// A client island rather than a client table: the panel is server-rendered, and shipping
// every slip's reason text to the browser to put a button beside it would trade real payload
// for nothing. Only the button needs interactivity.
//
// Behind a confirmation dialog on purpose. Revoking changes 实绩 on /actuals immediately, and
// there is no un-revoke - `revokeActualAdjustment` sets revokedAt and the repository has no
// path back. The dialog states the 課 and the signed hours, because "撤销" beside a row the
// operator's eye has already left is not enough to identify what is about to change.
//
// No local optimistic state: the action calls revalidatePath for both screens, so the row
// re-renders from the database as 已撤销. An optimistic strike-through would be a second
// claim about what happened, free to disagree with the first.

import { useCallback, useState, type ReactElement } from "react";
import { toast } from "sonner";

import { revokeAdjustment } from "../actions";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

interface RevokeSlipButtonProps {
  readonly id: string;
  readonly sectionName: string;
  /** Already formatted and signed, so the dialog cannot disagree with the table. */
  readonly hoursLabel: string;
  readonly monthLabel: string;
}

export function RevokeSlipButton({
  id,
  sectionName,
  hoursLabel,
  monthLabel,
}: RevokeSlipButtonProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const confirm = useCallback(async (): Promise<void> => {
    setSubmitting(true);
    try {
      const result = await revokeAdjustment({ id });
      if (result.ok) {
        setOpen(false);
        toast.success(`已撤销 ${sectionName} 的 ${hoursLabel} H 调整单`);
        return;
      }
      // Kept open: the message usually says "already revoked, reload", and closing the
      // dialog would hide the only explanation of why nothing changed.
      toast.error(result.message);
    } finally {
      setSubmitting(false);
    }
  }, [hoursLabel, id, sectionName]);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="text-destructive"
        onClick={() => {
          setOpen(true);
        }}
      >
        撤销
      </Button>

      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!submitting) setOpen(next);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>撤销 {sectionName} 的调整单?</AlertDialogTitle>
          <AlertDialogDescription>
            {monthLabel} 该课的 {hoursLabel} H 调整将立即失效,实绩合计随之变动。
            撤销不可恢复,如需改数请撤销后重新登记。原记录会保留在列表中以供审计。
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => {
                setOpen(false);
              }}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={submitting}
              onClick={() => {
                void confirm();
              }}
            >
              {submitting ? "撤销中…" : "确认撤销"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
