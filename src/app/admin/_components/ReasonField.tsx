"use client";

// The one optional "why" input, shared by every write surface on /admin.
//
// Exists as a component rather than four inline <Input>s because the length cap has to
// match REASON_MAX_LENGTH exactly: the repository layer rejects anything longer
// (assertSnapshotInput), so a surface with a looser maxLength would let the operator
// type a reason that is silently refused at save time with a message about a field they
// were never told had a limit.
//
// Deliberately does NOT trim or validate. Blank means "not filled" (D-184) and the
// action turns it into null via parseOptionalText - doing it here as well would mean two
// places deciding what an empty reason is.

import type { ReactElement } from "react";

import { Input } from "@/components/ui/input";
import { REASON_MAX_LENGTH } from "@/lib/db/reason";

export function ReasonField({
  value,
  label,
  inputId,
  disabled,
  onChange,
}: {
  value: string;
  /** Accessible name. Used as aria-label unless `inputId` pairs it with a <label>. */
  label: string;
  /** Set only when a visible <label htmlFor> exists, as in the rename dialog. */
  inputId?: string;
  disabled: boolean;
  onChange: (next: string) => void;
}): ReactElement {
  return (
    <Input
      id={inputId}
      value={value}
      disabled={disabled}
      maxLength={REASON_MAX_LENGTH}
      placeholder="选填"
      aria-label={inputId === undefined ? label : undefined}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
