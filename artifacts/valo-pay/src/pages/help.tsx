import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "wouter";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  CircleHelp,
  Search,
  ShieldCheck,
} from "lucide-react";
import { BrandLockup } from "@/components/brand";
import { Button } from "@/components/ui/button";
import {
  helpGuides,
  helpTerms,
  matchesHelpSearch,
  safeHelpReturnTo,
  type HelpGuide,
} from "@/lib/help-content";

const linkClass =
  "inline-flex min-h-11 items-center gap-2 rounded-md text-sm font-medium underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring";

/** Intentionally outside WorkspaceProvider: only static content and URL state are read here. */
export default function HelpPage() {
  const [params, setParams] = useSearchParams();
  const query = (params.get("q") || "").slice(0, 160);
  const [draft, setDraft] = useState(query);
  const selected = helpGuides.find((guide) => guide.id === params.get("topic"));
  const glossary = params.get("view") === "glossary";
  const returnTo = safeHelpReturnTo(params.get("returnTo"));
  const detailTitle = useRef<HTMLHeadingElement>(null);
  const resultsTitle = useRef<HTMLHeadingElement>(null);
  const navigationKey = `${selected?.id || ""}:${glossary}:${query}`;
  const previousNavigation = useRef(navigationKey);
  useEffect(() => {
    setDraft(query);
  }, [query]);
  useEffect(() => {
    document.title = `${glossary ? "Terms explained" : selected?.title || "Help & guides"} · Valo Pay`;
  }, [selected?.title, glossary]);
  useEffect(() => {
    if (navigationKey !== previousNavigation.current) {
      (selected && !glossary ? detailTitle : resultsTitle).current?.focus();
    }
    previousNavigation.current = navigationKey;
  }, [navigationKey, selected, glossary]);
  const guideResults = helpGuides.filter((guide) =>
    matchesHelpSearch(
      query,
      guide.title,
      guide.category,
      guide.destination,
      guide.summary,
      guide.needs,
      ...guide.steps,
      guide.result,
      guide.blocked,
      guide.recovery,
      ...helpTerms
        .filter((term) => guide.terms.includes(term.id))
        .map((term) => `${term.term} ${term.formal} ${term.meaning}`),
    ),
  );
  const termResults = helpTerms.filter((term) =>
    matchesHelpSearch(query, term.term, term.formal, term.meaning),
  );
  const hrefFor = (values: Record<string, string | null>) => {
    const next = new URLSearchParams();
    if (query) next.set("q", query);
    if (glossary) next.set("view", "glossary");
    if (returnTo) next.set("returnTo", returnTo);
    for (const [key, value] of Object.entries(values))
      value ? next.set(key, value) : next.delete(key);
    return `/help${next.size ? `?${next}` : ""}`;
  };
  const search = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = new URLSearchParams();
    if (draft.trim()) next.set("q", draft.trim().slice(0, 160));
    if (glossary) next.set("view", "glossary");
    if (returnTo) next.set("returnTo", returnTo);
    setParams(next);
  };
  return (
    <div className="min-h-screen bg-background text-foreground">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-card focus:p-4 focus:ring-2 focus:ring-ring"
      >
        Skip to help
      </a>
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-4 sm:px-8">
          <BrandLockup />
          <nav
            aria-label="Help page navigation"
            className="flex flex-wrap gap-4"
          >
            <Link href={returnTo || "/"} className={linkClass}>
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              {returnTo && returnTo !== "/"
                ? "Return to your page"
                : "Back to home"}
            </Link>
            <Link href="/sign-in" className={linkClass}>
              Sign in
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </nav>
        </div>
      </header>
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto max-w-6xl px-5 py-8 outline-none sm:px-8 sm:py-12"
      >
        <div className="max-w-2xl">
          <p className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            <BookOpen className="h-4 w-4" aria-hidden="true" />
            Valo Pay help
          </p>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Find your next step
          </h1>
          <p className="mt-3 text-base leading-relaxed text-muted-foreground">
            Short guides for everyday work, with the meaning of each result and
            what to do when you are blocked.
          </p>
        </div>
        <form
          role="search"
          aria-label="Search help"
          onSubmit={search}
          className="my-7 flex max-w-3xl flex-col gap-3 sm:flex-row sm:items-end"
        >
          <label
            className="min-w-0 grow text-sm font-medium"
            htmlFor="help-search"
          >
            Search tasks and terms
            <span className="relative mt-2 block">
              <Search
                className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-muted-foreground"
                aria-hidden="true"
              />
              <input
                id="help-search"
                type="search"
                maxLength={160}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Try: import, payment pending, payroll"
                className="min-h-11 w-full rounded-lg border border-input bg-card py-2 pl-10 pr-3 font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </span>
          </label>
          <Button type="submit" className="min-h-11">
            Search help
          </Button>
        </form>
        <p className="mb-7 flex max-w-3xl items-start gap-2 text-sm leading-relaxed text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          These guides do not open a workspace or change your access. Connected
          bank, credit and cash workflows currently use samples; check the
          environment shown in your workspace.
        </p>
        <nav
          aria-label="Help sections"
          className="mb-7 flex flex-wrap gap-2 border-b pb-4"
        >
          <Link
            href={hrefFor({ view: null, topic: null })}
            aria-current={!glossary ? "page" : undefined}
            className={`inline-flex min-h-11 items-center rounded-lg px-4 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${!glossary ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"}`}
          >
            Task guides
          </Link>
          <Link
            href={hrefFor({ view: "glossary", topic: null })}
            aria-current={glossary ? "page" : undefined}
            className={`inline-flex min-h-11 items-center rounded-lg px-4 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${glossary ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"}`}
          >
            Terms explained
          </Link>
          {query && (
            <Link
              href={hrefFor({ q: null, topic: null })}
              className={`${linkClass} px-3`}
            >
              Clear search
            </Link>
          )}
        </nav>
        {selected && !glossary ? (
          <article
            aria-labelledby="help-topic-title"
            className="max-w-3xl space-y-6"
          >
            <Link href={hrefFor({ topic: null })} className={linkClass}>
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              {query ? "Back to search results" : "All task guides"}
            </Link>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {selected.category}
              </p>
              <h2
                id="help-topic-title"
                ref={detailTitle}
                tabIndex={-1}
                className="rounded text-2xl font-bold tracking-tight focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
              >
                {selected.title}
              </h2>
              <p className="mt-3 leading-relaxed text-muted-foreground">
                {selected.summary}
              </p>
            </div>
            <div className="grid gap-4 rounded-xl border bg-card p-5 sm:grid-cols-[9rem_1fr]">
              <p className="text-sm font-semibold">Where to go</p>
              <p className="text-sm leading-relaxed">{selected.destination}</p>
              <p className="text-sm font-semibold">Before you begin</p>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {selected.needs}
              </p>
            </div>
            <section aria-labelledby="help-steps-title">
              <h3 id="help-steps-title" className="mb-4 text-lg font-semibold">
                Follow these steps
              </h3>
              <ol className="space-y-4">
                {selected.steps.map((step, index) => (
                  <li key={step} className="flex gap-3">
                    <span
                      aria-hidden="true"
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-semibold"
                    >
                      {index + 1}
                    </span>
                    <p className="pt-0.5 text-sm leading-relaxed">{step}</p>
                  </li>
                ))}
              </ol>
            </section>
            <section className="rounded-xl border bg-secondary/25 p-5">
              <h3 className="flex items-center gap-2 font-semibold">
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                What happens afterwards
              </h3>
              <p className="mt-2 text-sm leading-relaxed">{selected.result}</p>
            </section>
            <section>
              <h3 className="font-semibold">If you are blocked</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {selected.blocked}
              </p>
            </section>
            <section>
              <h3 className="font-semibold">If you were interrupted</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {selected.recovery}
              </p>
            </section>
            <section aria-labelledby="help-topic-terms">
              <h3 id="help-topic-terms" className="mb-3 font-semibold">
                Terms in this guide
              </h3>
              <dl className="divide-y rounded-xl border bg-card px-4">
                {helpTerms
                  .filter((term) => selected.terms.includes(term.id))
                  .map((term) => (
                    <div key={term.id} className="py-4">
                      <dt className="text-sm font-semibold">
                        {term.term}
                        <span className="mt-1 block text-xs font-normal text-muted-foreground">
                          {term.formal}
                        </span>
                      </dt>
                      <dd className="mt-2 text-sm leading-relaxed text-muted-foreground">
                        {term.meaning}
                      </dd>
                    </div>
                  ))}
              </dl>
            </section>
          </article>
        ) : (
          <>
            {params.get("topic") && !selected && !glossary && (
              <p
                role="status"
                className="mb-5 rounded-lg border bg-secondary/25 p-4 text-sm"
              >
                That guide is not available. Choose a task below or search for
                what you need.
              </p>
            )}
            <div className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
              <h2
                ref={resultsTitle}
                tabIndex={-1}
                className="rounded text-xl font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
              >
                {glossary
                  ? "Terms explained"
                  : query
                    ? "Search results"
                    : "What would you like to do?"}
              </h2>
              <p
                role="status"
                aria-live="polite"
                className="text-sm text-muted-foreground"
              >
                {glossary ? termResults.length : guideResults.length}{" "}
                {glossary
                  ? termResults.length === 1
                    ? "term"
                    : "terms"
                  : guideResults.length === 1
                    ? "guide"
                    : "guides"}
                {query ? ` for “${query}”` : ""}
              </p>
            </div>
            {(glossary ? termResults.length : guideResults.length) === 0 ? (
              <div className="rounded-xl border bg-card p-6">
                <CircleHelp
                  className="mb-3 h-6 w-6 text-muted-foreground"
                  aria-hidden="true"
                />
                <h3 className="font-semibold">
                  No matching {glossary ? "terms" : "guides"}
                </h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  Try a shorter phrase, such as “import” or “payment”, or clear
                  the search to browse everything.
                </p>
                <Link
                  href={hrefFor({ q: null, topic: null })}
                  className={`${linkClass} mt-3`}
                >
                  Show all {glossary ? "terms" : "guides"}
                </Link>
              </div>
            ) : glossary ? (
              <dl className="grid gap-4 md:grid-cols-2">
                {termResults.map((term) => (
                  <div key={term.id} className="rounded-xl border bg-card p-5">
                    <dt className="font-semibold">
                      {term.term}
                      <span className="mt-1 block text-xs font-normal text-muted-foreground">
                        {term.formal}
                      </span>
                    </dt>
                    <dd className="mt-3 text-sm leading-relaxed text-muted-foreground">
                      {term.meaning}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {guideResults.map((guide) => (
                  <GuideCard
                    key={guide.id}
                    guide={guide}
                    href={hrefFor({ topic: guide.id, view: null })}
                  />
                ))}
              </div>
            )}
          </>
        )}
        <aside
          className="mt-10 flex flex-col justify-between gap-4 rounded-xl border bg-card p-5 sm:flex-row sm:items-center"
          aria-label="Choose how to use Valo Pay"
        >
          <div>
            <h2 className="font-semibold">Ready to try a task?</h2>
            <p className="mt-1 max-w-xl text-sm leading-relaxed text-muted-foreground">
              Sign in for your own workspace, or explicitly open a sample
              workspace to rehearse. Reading help has not created one.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-4">
            <Link href="/sign-in" className={linkClass}>
              Sign in
            </Link>
            <Link href="/overview" className={linkClass}>
              Try with sample data
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
        </aside>
      </main>
    </div>
  );
}

function GuideCard({ guide, href }: { guide: HelpGuide; href: string }) {
  return (
    <Link
      href={href}
      className="group flex flex-col rounded-xl border bg-card p-5 transition-colors hover:border-primary/40 hover:bg-secondary/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {guide.category}
      </p>
      <h3 className="mt-3 font-semibold leading-snug">{guide.title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {guide.summary}
      </p>
      <span className="mt-auto flex items-center gap-2 pt-5 text-sm font-medium">
        Read guide
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </span>
    </Link>
  );
}
