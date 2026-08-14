import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog"
import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Modal confirmation dialog for writes that must not happen by accident (D-174).
 *
 * This wraps Base UI's `alert-dialog` rather than its `dialog`, and the difference is
 * the whole point: `AlertDialogRoot.Props` omits `modal` and `disablePointerDismissal`,
 * so an alert dialog is always modal, always focus-trapped, and cannot be dismissed by
 * clicking the backdrop or pressing anything other than an explicit choice. A plain
 * dialog would let a stray click outside count as "not now", which for a confirmation
 * step is indistinguishable from cancelling on purpose.
 *
 * Escape still closes it. That is intentional and matches the grid's existing Escape
 * behaviour (revert the typed value), so the two keys do not disagree.
 *
 * Usage here is CONTROLLED - `open` plus `onOpenChange` - with no `Trigger`, because the
 * plan grid opens the dialog from a <td> blur handler rather than from a button. The
 * `Trigger` part is deliberately not re-exported: exporting it would invite a second,
 * uncontrolled usage pattern in a codebase that only needs one.
 *
 * `AlertDialogContent` bundles Portal + Backdrop + Popup because all three are required
 * for a correct overlay and forgetting the Backdrop silently produces a modal you can
 * scroll behind. Callers compose the inside: Title, Description, then their own form and
 * footer.
 */
function AlertDialog(props: AlertDialogPrimitive.Root.Props) {
  return <AlertDialogPrimitive.Root {...props} />
}

function AlertDialogContent({
  className,
  children,
  ...props
}: AlertDialogPrimitive.Popup.Props) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Backdrop
        data-slot="alert-dialog-backdrop"
        className="fixed inset-0 z-50 bg-black/50 transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0"
      />
      <AlertDialogPrimitive.Popup
        data-slot="alert-dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background p-5 text-foreground shadow-lg outline-none",
          "transition-[opacity,transform] duration-150 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
          className
        )}
        {...props}
      >
        {children}
      </AlertDialogPrimitive.Popup>
    </AlertDialogPrimitive.Portal>
  )
}

function AlertDialogTitle({
  className,
  ...props
}: AlertDialogPrimitive.Title.Props) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn("text-base font-semibold", className)}
      {...props}
    />
  )
}

function AlertDialogDescription({
  className,
  ...props
}: AlertDialogPrimitive.Description.Props) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn("mt-1 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

/** Right-aligned action row. Cancel first, confirm last, so the destructive-ish choice
 * is not the one under a hurried pointer. */
function AlertDialogFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn("mt-4 flex items-center justify-end gap-2", className)}
      {...props}
    />
  )
}

export {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
}
