'use client';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import type { AchievementTableRow } from '@/types/manhour';

export interface AchievementTableProps {
  /** Each row: a name + exactly 4 achievement cells. */
  rows: AchievementTableRow[];
  /** Label for the name column ('部门' / '课' / '月份'). */
  nameHeader: string;
  /** Optional drill-down handler (overview mode). When present, rows become clickable. */
  onRowClick?: (index: number) => void;
  /** Headers for the 4 achievement columns. Defaults to the v18 labels. */
  columnHeaders?: string[];
}

const DEFAULT_COLUMN_HEADERS = ['当月年计', '当月挑战', '累计年计', '累计挑战'];

/**
 * Format a diff value with thousands separator and explicit sign.
 * Positive values are prefixed with '+'; zero and negatives keep their natural sign.
 */
function formatDiff(diff: number): string {
  const sign = diff > 0 ? '+' : '';
  return `${sign}${diff.toLocaleString()}`;
}

/**
 * Achievement status table (v18 达成状况表).
 *
 * Renders a shadcn Table with a name column + 4 achievement columns.
 * Each cell shows the diff value (green when achieved / red when not) followed
 * by a 「达成」/「未达成」 label.
 *
 * When `onRowClick` is provided, rows become clickable with hover highlight
 * and cursor-pointer (used by the overview view for drill-down). Non-clickable
 * rows suppress the default hover to avoid implying interactivity.
 */
export function AchievementTable({
  rows,
  nameHeader,
  onRowClick,
  columnHeaders = DEFAULT_COLUMN_HEADERS,
}: AchievementTableProps): JSX.Element {
  const clickable = typeof onRowClick === 'function';

  return (
    <Table>
      <TableHeader>
        {/* Header row is never interactive — suppress default hover. */}
        <TableRow className="hover:bg-transparent">
          <TableHead>{nameHeader}</TableHead>
          {columnHeaders.map((header) => (
            <TableHead key={header} className="text-right">
              {header}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow
            key={row.name}
            className={cn(
              clickable ? 'cursor-pointer' : 'hover:bg-transparent',
            )}
            onClick={onRowClick ? () => onRowClick(index) : undefined}
          >
            <TableCell className="font-medium">{row.name}</TableCell>
            {row.cells.map((cell, cellIdx) => (
              <TableCell key={cellIdx} className="text-right tabular-nums">
                <span
                  className={cn(
                    'font-semibold',
                    cell.achieved ? 'text-challenge' : 'text-actual',
                  )}
                >
                  {formatDiff(cell.diff)}
                </span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {cell.achieved ? '达成' : '未达成'}
                </span>
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
