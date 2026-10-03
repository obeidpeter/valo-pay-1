import { Link } from "wouter";

/**
 * The brand mark: the favicon's orange square carrying a white V. One mark,
 * drawn once, used on the landing page, the sign-in pages and the console
 * sidebar, so the product is recognised the same way everywhere (consistency).
 * Decorative beside the wordmark, so it is hidden from assistive technology.
 */
export function BrandMark({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="40" height="40" rx="9" className="fill-brand" />
      <path
        d="M11 12l9 17 9-17"
        fill="none"
        stroke="white"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The lockup pairs the name with its descriptor because the name says "Pay"
 * and the product never touches money; the descriptor is part of the brand,
 * not a tagline (marketing strategy, section 3.1), and the same words as the
 * landing page's title. `compact` shows the mark alone below 640 px, where the
 * console's phone bar has no room for the name; the link's label still says
 * what it is and where it goes: the landing page's own lockups link to the
 * top of that page, every other one back home.
 */
export function BrandLockup({
  href = "/",
  descriptor = true,
  compact = false,
  className = "",
}: {
  href?: string;
  descriptor?: boolean;
  compact?: boolean;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${className}`}
      aria-label={`Valo Pay 1, collections, credit and cash operations. ${href.startsWith("#") ? "Back to top" : "Back to home"}`}
    >
      <BrandMark />
      <span
        className={compact ? "hidden leading-tight sm:block" : "leading-tight"}
      >
        <span className="block text-lg font-bold tracking-tight text-foreground">
          Valo Pay 1
        </span>
        {descriptor && (
          <span className="block text-xs text-muted-foreground">
            Collections, credit and cash operations
          </span>
        )}
      </span>
    </Link>
  );
}
