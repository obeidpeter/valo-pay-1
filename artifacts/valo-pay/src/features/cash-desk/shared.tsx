import { formatKobo } from "@/lib/formatters";
import { LockKeyhole } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "wouter";

export const amount = (value: number | null | undefined) =>
  value == null ? "Needs review" : formatKobo(value);
export const saveJson = (name: string, value: unknown) => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export function Section({
  title,
  detail,
  children,
  action,
}: {
  title: string;
  detail?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-2xl border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b p-5">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          {detail && (
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {detail}
            </p>
          )}
        </div>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Metric({
  title,
  value,
  detail,
  accent = false,
}: {
  title: string;
  value: string;
  detail: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border p-5 ${accent ? "border-primary/20 bg-primary/5" : "bg-card"}`}
    >
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      <p className="mt-3 text-xl font-semibold tracking-tight tabular-nums break-words 2xl:text-2xl">
        {value}
      </p>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {detail}
      </p>
    </div>
  );
}

export function Gate({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-sm">
      <LockKeyhole aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        {text}{" "}
        <Link
          href="/connections"
          className="font-medium underline underline-offset-4"
        >
          Review permissions
        </Link>
      </span>
    </p>
  );
}
