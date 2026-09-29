import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { ArrowRight, Check, Menu, ShieldCheck, X } from "lucide-react";
import { BrandLockup } from "@/components/brand";
import { LandingFooter, LandingSections } from "@/components/landing-sections";
import {
  LandingWorkspaces,
  WorkspaceShowcase,
} from "@/components/workspace-showcase";
import { Button } from "@/components/ui/button";
import { authEnabled, useSessionUser } from "@/lib/auth";
import { useHashTarget } from "@/lib/use-hash-target";
import "@/public-pages.css";
import "@/landing.css";

const landingTargets = [
  "main",
  "what",
  "how",
  "boundaries",
  "pricing",
  "pilot",
  "product-tour",
  "connected-banking",
  "questions",
];
const sectionLinks = [
  { href: "#what", label: "Workspaces" },
  { href: "#product-tour", label: "Product tour" },
  { href: "#how", label: "How it works" },
  { href: "#pricing", label: "Pricing" },
];

export default function LandingPage() {
  const { userId } = useSessionUser();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  useHashTarget(landingTargets, true);
  useEffect(() => {
    document.title = "Valo Pay · Collections, credit and cash operations";
  }, []);
  const signedIn = authEnabled && Boolean(userId);
  return (
    <div className="public-site landing-site min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
      >
        Skip to main content
      </a>
      <header
        className="public-header lp-header"
        onKeyDown={(event) => {
          if (event.key === "Escape" && menuOpen) {
            setMenuOpen(false);
            menuButton.current?.focus();
          }
        }}
      >
        <div className="public-container lp-header-inner">
          <BrandLockup href="#main" />
          <nav aria-label="Sections" className="lp-header-nav">
            {sectionLinks.map((link) => (
              <a key={link.href} href={link.href}>
                {link.label}
              </a>
            ))}
            <Link href="/help?topic=start">Help</Link>
          </nav>
          <div className="lp-header-actions">
            <Button
              asChild
              variant="outline"
              size="sm"
              className="lp-header-sandbox"
            >
              <Link href="/overview">Open the sandbox</Link>
            </Button>
            {signedIn ? (
              <Button asChild size="sm">
                <Link href="/overview">
                  <span className="lp-workspace-label">
                    Open your workspace
                  </span>
                  <span className="lp-workspace-short" aria-hidden="true">
                    Workspace
                  </span>
                </Link>
              </Button>
            ) : (
              <Button asChild size="sm">
                <Link href="/sign-in">Sign in</Link>
              </Button>
            )}
            <Button
              ref={menuButton}
              variant="outline"
              size="icon"
              className="lp-menu-toggle"
              aria-label={menuOpen ? "Close navigation" : "Open navigation"}
              aria-expanded={menuOpen}
              aria-controls="landing-navigation"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              {menuOpen ? (
                <X aria-hidden="true" />
              ) : (
                <Menu aria-hidden="true" />
              )}
            </Button>
          </div>
          {menuOpen && (
            <nav
              id="landing-navigation"
              aria-label="Mobile sections"
              className="lp-mobile-nav"
            >
              {[
                ...sectionLinks,
                { href: "#boundaries", label: "Availability & boundaries" },
                { href: "#pilot", label: "Discuss a pilot" },
                { href: "#questions", label: "Common questions" },
              ].map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  onClick={() => setMenuOpen(false)}
                >
                  {link.label}
                  <ArrowRight aria-hidden="true" />
                </a>
              ))}
              <Link href="/help?topic=start" onClick={() => setMenuOpen(false)}>Help & glossary<ArrowRight aria-hidden="true" /></Link>
            </nav>
          )}
        </div>
      </header>
      <main id="main" tabIndex={-1} className="focus:outline-none">
        <section className="lp-hero-section" aria-labelledby="hero-title">
          <div className="lp-hero-grid-art" aria-hidden="true" />
          <div className="public-container lp-hero">
            <div className="lp-hero-copy">
              <p className="lp-eyebrow">
                Financial operations for Nigerian lenders and SMEs
              </p>
              <h1 id="hero-title">
                Collections, credit and cash. <br />
                <span>One clear workspace.</span>
              </h1>
              <p className="lp-hero-description">
                We never hold money. Valo Pay brings payment records, credit
                evidence and business cash planning into view—so your team can
                see what happened and decide what comes next.
              </p>
              <div className="lp-hero-actions">
                <Button asChild size="lg" className="lp-primary">
                  <Link href="/overview">
                    Open the sandbox
                    <ArrowRight aria-hidden="true" />
                  </Link>
                </Button>
                <Button asChild size="lg" variant="outline">
                  <a href="#pilot">
                    Discuss a pilot
                    <ArrowRight aria-hidden="true" />
                  </a>
                </Button>
              </div>
              <p className="lp-sandbox-hint">
                Working sample journeys. No sign-in or bank connection needed.
              </p>
              <ul
                className="lp-hero-benefits"
                aria-label="How the workspace supports your team"
              >
                <li>
                  <Check aria-hidden="true" /> Clear evidence
                </li>
                <li>
                  <Check aria-hidden="true" /> Separate permissions
                </li>
                <li>
                  <Check aria-hidden="true" /> Reviewed actions
                </li>
              </ul>
              <a href="#product-tour" className="lp-hero-tour">
                Take a closer look at the workspaces{" "}
                <ArrowRight aria-hidden="true" />
              </a>
            </div>
            <WorkspaceShowcase />
          </div>
          <div className="public-container">
            <div className="lp-current-state">
              <span className="lp-current-state-label">
                <ShieldCheck aria-hidden="true" /> Available today
              </span>
              <p>
                Explore Collections, Pay-by-bank, Credit Desk and Cash Desk with
                sample data.
              </p>
              <a href="#boundaries">
                What needs approval for live use{" "}
                <ArrowRight aria-hidden="true" />
              </a>
            </div>
          </div>
        </section>
        <LandingWorkspaces />
        <LandingSections signedIn={signedIn} />
      </main>
      <LandingFooter />
    </div>
  );
}
