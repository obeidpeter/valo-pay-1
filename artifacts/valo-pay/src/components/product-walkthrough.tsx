import { useRef, useState } from "react";
import { Link } from "wouter";
import {
  ArrowRight,
  ArrowUpRight,
  ChartNoAxesCombined,
  CirclePlay,
  CreditCard,
  LayoutDashboard,
  Mail,
  ScanLine,
  UserRoundCheck,
} from "lucide-react";
import { Button } from "./ui/button";

const screens = [
  {
    name: "Collections",
    icon: LayoutDashboard,
    hint: "Review the working day",
    path: "/overview",
    title: "Start with the work that needs attention",
    description:
      "See outstanding instalments, proposed matches and overdue exceptions. Follow the evidence through reconciliation to the daily close.",
    exercise: "Open a sample customer and follow their collection history.",
    boundary: "Records and decisions here use sample data.",
  },
  {
    name: "Pay by Bank",
    icon: CreditCard,
    hint: "Follow a payment",
    path: "/pay-by-bank",
    title: "From checkout to a matched payment",
    description:
      "Create a sample checkout for an instalment. Follow the customer as they authorise it at their bank and come back. Then see whether the payment is confirmed or its outcome is unknown.",
    exercise: "Try an unknown outcome before you confirm the sample payment.",
    boundary:
      "Bank authorisation and provider answers are simulated. No money moves.",
  },
  {
    name: "Credit Desk",
    icon: UserRoundCheck,
    hint: "Understand an assessment",
    path: "/credit-desk",
    title: "Put the evidence beside the recommendation",
    description:
      "Check evidence quality, affordability and what drives the score. See how a different person records the review and the explanation for the applicant.",
    exercise:
      "Grant Read applicant accounts and Assess an application, then compare the sample evidence.",
    boundary:
      "The sample rule score is not validated. No real loan is approved or paid out.",
  },
  {
    name: "Cash Desk",
    icon: ChartNoAxesCombined,
    hint: "Plan business cash",
    path: "/cash-desk",
    title: "See what is available and what comes next",
    description:
      "Explore cash positions and forecast scenarios for a sample business. Then review accounting drafts, VAT evidence and payroll funding.",
    exercise:
      "Grant Read business accounts, then set up the sample Cash Desk.",
    boundary: "No live bank feeds, posting to accounting software, tax filing or payouts.",
  },
];
/** The pilot enquiry address comes from the deployment's configuration; without one the page names no address. */
export const pilotEmail = (): string => String(import.meta.env.VITE_PILOT_EMAIL || "").trim();
export const pilotContact = (): string => `mailto:${pilotEmail()}?subject=${encodeURIComponent("Valo Pay pilot enquiry")}&body=${encodeURIComponent("Hello, I would like to discuss a Valo Pay pilot.\n\nMy organisation and role:\nProduct we are interested in (Collections / Pay by Bank / Credit Desk / Cash Desk):\nThe problem we want to solve:\nCurrent payment provider, banks and business software (names only):\nAbout how many collections, payments or applications a month:\nWhen we would like to start:\n\nPlease do not include customer records, bank details, passwords or other sign-in details.")}`;

/** Uses the actual console, loaded only after an explicit choice; no decorative mock data or autoplay. */
export function ProductWalkthrough() {
  const [active, setActive] = useState(0);
  const [started, setStarted] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const loadButton = useRef<HTMLButtonElement>(null);
  const closePreview = () => {
    setStarted(false);
    setLoaded(false);
    requestAnimationFrame(() => loadButton.current?.focus());
  };
  const screen = screens[active]!;
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const [path, hash] = screen.path.split("#");
  const source = `${basePath}${path}${path!.includes("?") ? "&" : "?"}embedded=1${hash ? `#${hash}` : ""}`;
  return (
    <section
      id="product-tour"
      className="lp-section lp-product-tour"
      aria-labelledby="product-tour-title"
    >
      <div className="public-container">
        <div className="lp-section-intro lp-split-intro">
          <p className="lp-section-kicker">Product tour</p>
          <h2 id="product-tour-title">
            Take a closer look.{" "}
            <br />
            Then try it yourself.
          </h2>
          <p>
            Choose a product, see what to expect, then load the real screen.
            Everything here uses sample data.
          </p>
        </div>
        <div
          className="lp-tour-tabs"
          role="group"
          aria-label="Choose a product screen"
        >
          {screens.map((item, index) => (
            <button
              key={item.name}
              className="lp-tour-step"
              aria-pressed={active === index}
              aria-controls="tour-preview"
              onClick={() => {
                if (active !== index) {
                  setStarted(false);
                  setLoaded(false);
                  setActive(index);
                }
              }}
            >
              <item.icon aria-hidden="true" />
              <span>
                <span>
                  {String(index + 1).padStart(2, "0")} · {item.name}
                </span>
                <span>{item.hint}</span>
              </span>
              <ArrowRight aria-hidden="true" />
            </button>
          ))}
        </div>
        <div id="tour-preview" className="lp-tour-shell">
          <div className="lp-tour-toolbar">
            <span>
              <span aria-hidden="true" className="lp-tour-indicator" />{" "}
              {started ? "Interactive preview" : "Product preview"}
            </span>
            <div>
              {started && (
                <Button variant="ghost" size="sm" onClick={closePreview}>
                  Close preview
                </Button>
              )}
              <Button asChild variant="ghost" size="sm">
                <Link href={screen.path}>
                  Open the full page{" "}
                  <ArrowUpRight aria-hidden="true" className="ml-1 h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>
          <div className="lp-tour-copy" aria-live="polite">
            <h3>{screen.title}</h3>
            <p>{screen.description}</p>
          </div>
          <div className="lp-tour-frame">
            {started ? (
              <>
                <p className="lp-tour-load-status" role="status">
                  {loaded
                    ? `${screen.name} preview loaded. Sample data only.`
                    : "Loading preview… You can also open the full page."}
                </p>
                <iframe
                  key={source}
                  src={source}
                  title={`Interactive preview of ${screen.name}, with sample data`}
                  onLoad={() => setLoaded(true)}
                />
              </>
            ) : (
              <div className="lp-tour-placeholder">
                <span className="lp-tour-play">
                  <CirclePlay aria-hidden="true" />
                </span>
                <p>Try this in {screen.name}</p>
                <span>{screen.exercise}</span>
                <Button
                  ref={loadButton}
                  size="lg"
                  onClick={() => setStarted(true)}
                >
                  Load interactive preview{" "}
                  <ArrowRight aria-hidden="true" className="ml-2 h-4 w-4" />
                </Button>
                <span className="lp-tour-start-note">
                  No sign-in needed. The preview opens only when you choose.
                </span>
              </div>
            )}
          </div>
          <div className="lp-tour-footnote">
            <ScanLine aria-hidden="true" />
            <p>
              <strong>{screen.boundary}</strong> Closing the preview keeps your
              sample changes. Work you do in the sandbox is not copied to your
              workspace. On a phone, open the full page for more room.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

export function PilotEnquiry() {
  return (
    <section
      id="pilot"
      className="lp-section lp-pilot"
      aria-labelledby="pilot-title"
    >
      <div className="public-container">
        <div className="lp-pilot-inner">
          <div>
            <p className="lp-section-kicker">Discuss a pilot</p>
            <h2 id="pilot-title">
              Start with one problem{" "}
              <br />
              worth solving.
            </h2>
            <p>
              Tell the Valo Pay team which product matters most to your team:
              Collections, Pay by Bank, Credit Desk or Cash Desk. Name your
              payment provider and business software too, so you can agree
              scope, access and how to measure success.
            </p>
            <p className="lp-pilot-note">
              Please leave customer records, bank details and sign-in details
              out of your enquiry. An enquiry does not switch on a service or
              start billing.
            </p>
          </div>
          <div className="lp-pilot-actions">
            <span className="lp-icon-tile">
              <Mail aria-hidden="true" />
            </span>
            <h3>Let’s talk about your workflow</h3>
            {pilotEmail() ? (
              <>
                <Button asChild size="lg">
                  <a href={pilotContact()}>
                    Email the Valo Pay team{" "}
                    <ArrowRight aria-hidden="true" className="ml-2 h-4 w-4" />
                  </a>
                </Button>
                <a href={`mailto:${pilotEmail()}`}>{pilotEmail()}</a>
                <span>Opens your email app · You choose when to send</span>
              </>
            ) : (
              <span>To discuss a pilot, speak to your contact at Valo Pay. This site has no enquiry email address.</span>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
