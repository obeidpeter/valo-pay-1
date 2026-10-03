import type { ReactNode } from "react";

/**
 * A code an auditor may need, such as a checksum or a hash, kept out of the reader's way: a section closed by
 * default, named "Technical details", with one plain sentence saying what the code is for (docs/design/writing.md).
 */
export function TechnicalDetails({ explanation, children, className = "" }: { explanation: string; children: ReactNode; className?: string }) {
  return (
    <details className={`text-xs ${className}`}>
      <summary className="min-h-8 cursor-pointer content-center font-medium">Technical details</summary>
      <p className="mt-2 text-muted-foreground">{explanation}</p>
      <div className="mt-1 space-y-1 break-all font-mono">{children}</div>
    </details>
  );
}
