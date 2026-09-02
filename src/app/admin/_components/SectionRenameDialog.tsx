"use client";

// Confirmation dialog for renaming a 課, extracted from OrgEditor.
//
// Split out for two reasons. OrgEditor had grown past the 800-line ceiling, and this is
// the one block in it that is self-contained: everything it needs arrives as props, and
// nothing else in the editor reads the reason the operator types here. It also keeps the
// reason's lifetime honest - the text lives in this component's state, so closing the
// dialog discards it, which is what "取消" has to mean for an audit annotation.
//
// The rename itself stays in OrgEditor: it owns the drafts and the toast, and a refused
// rename has to leave the typed name in the row underneath for the operator to fix.

import { useState, type ReactElement } from "react";

import { ReasonField } from "./ReasonField";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { SectionDto } from "@/lib/db/types";

/**
 * The rename awaiting confirmation, or in flight.
 *
 * Kept outside OrgEditor's `RowDraft` because a rename is not one of that shape's
 * fields: it is a separate transaction, only ever applies to a 課, and has to survive
 * the dialog being open while the row underneath it stays otherwise editable.
 */
export interface PendingRename {
  section: SectionDto;
  /** Already trimmed - what the dialog shows and what gets submitted. */
  nextName: string;
  status: "confirming" | "saving";
}

const REASON_FIELD_ID = "section-rename-reason";

export function SectionRenameDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: PendingRename;
  onCancel: () => void;
  /** Receives the reason verbatim; blank is legal and stores null (D-184). */
  onConfirm: (reason: string) => void;
}): ReactElement {
  const [reason, setReason] = useState("");
  const saving = pending.status === "saving";

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        // Escape is the only route to false - neither button is a Close part - and it
        // means the same as 取消: close, write nothing, keep what was typed in the row.
        if (!open && !saving) {
          onCancel();
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogTitle>确认修改课名称</AlertDialogTitle>
        <AlertDialogDescription>
          该课的历史考勤数据按「部名 + 课名」匹配,改名后原名会登记为别名。
        </AlertDialogDescription>

        <dl className="mt-3 space-y-1 rounded-md bg-muted/40 px-3 py-2 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">原课名</dt>
            <dd className="font-medium">{pending.section.name}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">新课名</dt>
            <dd className="font-medium text-plan">{pending.nextName}</dd>
          </div>
        </dl>

        <div className="mt-3 space-y-1.5">
          <label htmlFor={REASON_FIELD_ID} className="text-xs text-muted-foreground">
            变更原因（选填）
          </label>
          <ReasonField
            value={reason}
            label="变更原因"
            inputId={REASON_FIELD_ID}
            disabled={saving}
            onChange={setReason}
          />
        </div>

        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          <li>历史考勤会通过别名继续匹配到本课,计划与实绩不会被拆分。</li>
          <li>本次改名会记入主数据修改履历,填写的原因会一并记录。</li>
          <li>若新课名已被本部门其他课或其别名占用,改名会被拒绝,数据不变。</li>
        </ul>

        <AlertDialogFooter>
          <Button variant="outline" disabled={saving} onClick={onCancel}>
            取消
          </Button>
          <Button disabled={saving} onClick={() => onConfirm(reason)}>
            {saving ? "改名中" : "确认改名"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
