import { useId, type ReactNode } from 'react';

/**
 * One card for every moment the console has to say "not this": a page that
 * does not exist, a record the lender does not have, a page that stopped
 * working. The same shape each time (the title, what happened, what it
 * means, where to go) so the moment is recognised rather than read from
 * scratch (consistency; Nielsen 9: plain words, the problem stated, a way
 * out). Pass role="alert" when the notice replaces something that was
 * working, so assistive technology announces it.
 */
export function Notice({ title, role, children, actions }: { title: string; role?: 'alert'; children: ReactNode; actions: ReactNode }) {
  const id = useId();
  return (
    <section role={role} aria-labelledby={id} className="max-w-lg rounded-xl border bg-card p-6">
      <h1 id={id} className="text-2xl font-bold tracking-tight">{title}</h1>
      <div className="mt-3 space-y-2 text-sm text-muted-foreground">{children}</div>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row">{actions}</div>
    </section>
  );
}

/** A reference, address or time shown exactly as it is, so it can be read back or seen to be mistyped. */
export function LookedFor({ children }: { children: ReactNode }) {
  return <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs text-foreground">{children}</code>;
}
