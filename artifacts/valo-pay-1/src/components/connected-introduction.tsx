import { Link } from "wouter";
import { ArrowUpRight, Landmark, ShieldCheck, Building2 } from "lucide-react";
const modules = [
  {
    href: "/pay-by-bank",
    icon: Landmark,
    title: "Pay by Bank",
    text: "Create a checkout for one instalment and follow it until the payment is confirmed.",
  },
  {
    href: "/credit-desk",
    icon: ShieldCheck,
    title: "Credit Desk",
    text: "Check an applicant’s evidence, a sample rule score and an affordability check. A credit result is not a lending decision.",
  },
  {
    href: "/cash-desk",
    icon: Building2,
    title: "Cash Desk",
    text: "See a sample business’s cash and forecast, and prepare accounting drafts, VAT schedules and payroll funding.",
  },
];
export function ConnectedIntroduction({
  compact = false,
}: {
  compact?: boolean;
}) {
  return (
    <section
      id={compact ? undefined : "connected-banking"}
      aria-labelledby={
        compact ? "connected-preview-title" : "connected-suite-title"
      }
      className={
        compact ? "rounded-xl border bg-card p-5" : "public-container py-16"
      }
    >
      <div className="flex flex-wrap justify-between gap-4 items-end mb-6">
        <div>
          <h2
            id={compact ? "connected-preview-title" : "connected-suite-title"}
            className={
              compact
                ? "text-lg font-semibold tracking-tight"
                : "text-3xl font-semibold tracking-tight max-w-xl"
            }
          >
            Connected banking
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Try Pay by Bank, Credit Desk and Cash Desk with sample data.
          </p>
        </div>
        <span className="text-xs text-muted-foreground rounded-full border px-3 py-2">
          Sample data only
        </span>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {modules.map((m) => (
          <Link
            key={m.href}
            href={m.href}
            className="group block rounded-xl border bg-background p-5 hover:border-brand/50 transition-colors focus-visible:outline-2 focus-visible:outline-ring"
          >
            <div className="flex justify-between mb-5">
              <span className="p-2.5 rounded-xl bg-brand/10 text-primary">
                <m.icon size={21} aria-hidden="true" />
              </span>
              <ArrowUpRight
                size={16}
                className="text-muted-foreground group-hover:text-primary"
                aria-hidden="true"
              />
            </div>
            <h3 className="font-semibold text-base">{m.title}</h3>
            <p className="text-sm text-muted-foreground leading-relaxed mt-3">
              {m.text}
            </p>
            <span className="inline-block text-xs font-semibold mt-5 text-primary">
              Open {m.title}
            </span>
          </Link>
        ))}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground mt-5">
        Live payments and bank connections are switched off. Using credit
        results or changing accounting software for real would each need its
        own approval. Valo Pay 1 never holds money.{" "}
        <Link href="/connections" className="underline underline-offset-4">
          Open Permissions and readiness
        </Link>
      </p>
    </section>
  );
}
