import { useEffect, useRef, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/** Supporting evidence is on demand on screen, complete on paper, and never an action or approval. */
export function EvidenceDisclosure({ title, children }: { title: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    let wasOpen: boolean | undefined;
    const before = () => {
      if (ref.current) { wasOpen ??= ref.current.open; ref.current.open = true; }
    };
    const after = () => {
      if (ref.current && wasOpen !== undefined) { ref.current.open = wasOpen; wasOpen = undefined; }
    };
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, []);
  return <details ref={ref} className="group rounded-lg border bg-card">
    <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 py-3 text-sm font-medium transition-colors hover:bg-secondary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
      {title}<ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none" />
    </summary>
    <div className="border-t px-4 py-4">{children}</div>
  </details>;
}
