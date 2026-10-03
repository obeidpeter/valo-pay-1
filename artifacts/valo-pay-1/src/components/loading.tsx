import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The one way a region says it is waiting for the API: a status line, left
 * aligned in the space the content will take, that names what is coming
 * ("Loading the overview…") and is announced once by assistive technology.
 * The only motion is the small spinner, and it stops under reduced motion.
 * No skeletons: a line of words is simpler, honest about how long it may
 * take, and the same everywhere (Nielsen 1: visibility of system status;
 * Dix: responsiveness and observability; animation sparingly).
 */
export function Loading({ what, className, heading = false }: { what: string; className?: string; heading?: boolean }) {
  const line = <>
    <Loader2 className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
    <span>Loading {what}…</span>
  </>;
  // A page that shows nothing but this line gives it as the page's heading, so the page is never without an h1.
  if (heading) return (
    <h1 className={cn('p-6 text-sm font-normal text-muted-foreground', className)}>
      <span role="status" className="flex items-center gap-2">{line}</span>
    </h1>
  );
  return (
    <p role="status" className={cn('flex items-center gap-2 p-6 text-sm text-muted-foreground', className)}>
      {line}
    </p>
  );
}

/** The same status as the one row of a table that is still empty. */
export function LoadingRow({ colSpan, what }: { colSpan: number; what: string }) {
  return (
    <tr><td colSpan={colSpan} className="p-0"><Loading what={what} /></td></tr>
  );
}
