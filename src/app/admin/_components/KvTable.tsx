/**
 * Read-only column table for flat records (fiscal years, config key/values).
 *
 * Deliberately a thin generic over `columns` + `rows` rather than a full data-grid:
 * the two consumers on /admin differ only in column count and cell rendering, so
 * one shared shell keeps header typography, row rhythm and dividers identical
 * across both blocks. Anything richer (sorting, paging) belongs to a write-capable
 * screen, not here.
 */
import type { ReactElement, ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Horizontal alignment of a column's header and cells. */
export type KvAlign = "left" | "right";

export interface KvColumn<T> {
  /** Stable key, also used as the React key for header and cells. */
  key: string;
  /** Header label shown to the user (Chinese). */
  header: string;
  /** Cell renderer for one row. */
  cell: (row: T) => ReactNode;
  align?: KvAlign;
  /** Extra classes applied to both the header cell and every body cell. */
  className?: string;
}

export interface KvTableProps<T> {
  columns: readonly KvColumn<T>[];
  rows: readonly T[];
  /** Stable React key per row. */
  rowKey: (row: T) => string;
  /** Text shown in place of the body when `rows` is empty. */
  emptyLabel?: string;
}

const ALIGN_CLASS: Record<KvAlign, string> = {
  left: "text-left",
  right: "text-right",
};

export function KvTable<T>({
  columns,
  rows,
  rowKey,
  emptyLabel = "暂无数据",
}: KvTableProps<T>): ReactElement {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-y border-border bg-muted/40">
            {columns.map((column) => (
              <th
                key={column.key}
                className={cn(
                  "py-2 pr-4 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase first:pl-4",
                  ALIGN_CLASS[column.align ?? "left"],
                  column.className,
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className="py-6 pl-4 text-center text-muted-foreground"
              >
                {emptyLabel}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={rowKey(row)} className="border-b border-border/50">
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn(
                      "py-2.5 pr-4 first:pl-4",
                      ALIGN_CLASS[column.align ?? "left"],
                      column.className,
                    )}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
