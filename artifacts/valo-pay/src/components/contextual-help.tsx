import { CircleHelp } from "lucide-react";
import { Link } from "wouter";
import { helpGuides, helpHref, helpIndexHref, type HelpTopicId } from "@/lib/help-content";

/**
 * The link to a page's own guide ("Help: {guide title}"), or to the help index ("Help") for a page without one.
 * The destination is public guidance. Task destinations retain all their normal access checks.
 */
export function ContextualHelp({
  topic,
  returnTo,
  className = "",
}: {
  topic: HelpTopicId | null;
  returnTo?: string;
  className?: string;
}) {
  const guide = topic ? helpGuides.find((item) => item.id === topic) : undefined;
  return (
    <Link
      href={guide ? helpHref(guide.id, returnTo) : helpIndexHref(returnTo)}
      className={`inline-flex min-h-11 items-center gap-2 rounded-md text-sm text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring ${className}`}
    >
      <CircleHelp className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{guide ? `Help: ${guide.title}` : "Help"}</span>
    </Link>
  );
}
