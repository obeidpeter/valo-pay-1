import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The one way a region says it has nothing to show. Three things, in this
 * order: what would be here (the title), why it is empty here and now, and
 * what to do next when there is something to do. "Nothing yet" and "nothing
 * matches your search or filter" are different situations, so the second
 * is marked as a status: it is the result of what the visitor just did and
 * is announced as such. Left-aligned in the space the content will take,
 * without an illustration: the words are the information (Nielsen 1, 2, 6
 * and 9; Norman: knowledge in the world; Dix: observability).
 */
export type EmptyStateProps = { title: string; children?: ReactNode; action?: ReactNode; filtered?: boolean; className?: string };

export function EmptyState({ title, children, action, filtered = false, className }: EmptyStateProps) {
  return (
    <div role={filtered ? 'status' : undefined} className={cn('p-6', className)}>
      <p className="font-medium">{title}</p>
      {children && <p className="mt-1 max-w-prose text-sm text-muted-foreground">{children}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/** The same, as the one row of a table that has nothing to list. */
export function EmptyRow({ colSpan, ...rest }: { colSpan: number } & EmptyStateProps) {
  return <tr><td colSpan={colSpan} className="p-0"><EmptyState {...rest} /></td></tr>;
}
