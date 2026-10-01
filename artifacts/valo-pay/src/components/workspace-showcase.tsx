import { useRef, useState } from "react";
import { Link } from "wouter";
import {
  ArrowRight,
  ArrowUpRight,
  Building2,
  Check,
  CircleDot,
  FileCheck2,
  Landmark,
  LayoutDashboard,
  ShieldCheck,
} from "lucide-react";
import { BrandMark } from "./brand";

export const publicWorkspaces = [
  {
    name: "Collections",
    icon: LayoutDashboard,
    path: "/overview",
    lead: "Keep every collection in view.",
    description:
      "See mandates, payment matching, exceptions and the daily close in one place.",
    details: ["Mandates and retries", "Reconciliation", "Customer history"],
    preview: "A clear next step for every payment",
    note: "Matched payments stay separate from those that still need review.",
  },
  {
    name: "Pay by Bank",
    icon: Landmark,
    path: "/pay-by-bank",
    lead: "Follow the payment through.",
    description:
      "Try a one-time checkout. See the customer authorise it at their bank, then follow the payment into reconciliation.",
    details: ["Checkout for an exact amount", "Payment confirmed", "Refund review"],
    preview: "Authorisation is only the beginning",
    note: "Returning from a bank screen does not mean a payment has been confirmed.",
  },
  {
    name: "Credit Desk",
    icon: ShieldCheck,
    path: "/credit-desk",
    lead: "Make the evidence clear.",
    description:
      "Check sample financial evidence, a rule score with its reasons and an affordability check before a different person reviews them.",
    details: ["Evidence quality", "Affordability check", "Review by a different person"],
    preview: "Evidence first. A considered decision.",
    note: "The sample rule score is not validated. A credit result is not a lending decision.",
  },
  {
    name: "Cash Desk",
    icon: Building2,
    path: "/cash-desk",
    lead: "Plan the work ahead.",
    description:
      "Explore business cash, forecasts, accounting drafts, VAT evidence and reviewed payroll funding.",
    details: ["Cash and forecast", "Accounting and VAT evidence", "Payroll funding"],
    preview: "See today. Prepare for the next 30 days.",
    note: "Forecasts are planning estimates. Exports do not post entries, file tax or pay employees.",
  },
] as const;

/** Switching this example preview never reads an account or creates a workspace. */
export function WorkspaceShowcase() {
  const [active, setActive] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const item = publicWorkspaces[active]!;
  return (
    <figure
      className="lp-showcase"
      aria-label="Preview of four Valo Pay products, with sample data"
    >
      <div className="lp-showcase-chrome">
        <span>
          <BrandMark /> Product preview
        </span>
        <span className="lp-sample-label">
          <span aria-hidden="true" /> Sample data
        </span>
      </div>
      <div
        className="lp-showcase-tabs"
        role="tablist"
        aria-label="Preview a product"
      >
        {publicWorkspaces.map((workspace, index) => (
          <button
            key={workspace.name}
            ref={(node) => {
              tabs.current[index] = node;
            }}
            type="button"
            role="tab"
            id={`workspace-tab-${index}`}
            aria-selected={active === index}
            tabIndex={active === index ? 0 : -1}
            aria-controls="workspace-preview"
            onClick={() => setActive(index)}
            onKeyDown={(event) => {
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % 4
                  : event.key === "ArrowLeft"
                    ? (index + 3) % 4
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? 3
                        : null;
              if (next !== null) {
                event.preventDefault();
                setActive(next);
                tabs.current[next]?.focus();
              }
            }}
          >
            <workspace.icon aria-hidden="true" />
            <span>{workspace.name}</span>
          </button>
        ))}
      </div>
      <div
        className="lp-showcase-panel"
        role="tabpanel"
        id="workspace-preview"
        aria-labelledby={`workspace-tab-${active}`}
        tabIndex={0}
      >
        <div className="lp-showcase-panel-head">
          <span className="lp-showcase-overline">{item.name}</span>
          <h2>{item.preview}</h2>
        </div>
        {active === 0 && (
          <>
            <div className="lp-showcase-total">
              <div>
                <span>Matched to instalments</span>
                <strong>
                  ₦67,000<span>.00</span>
                </strong>
              </div>
              <span className="lp-preview-status">
                <Check aria-hidden="true" /> 2 matched
              </span>
            </div>
            <ul
              className="lp-showcase-records"
              aria-label="Example payment records"
            >
              <li>
                <span className="lp-person-mark" aria-hidden="true">
                  AO
                </span>
                <span>
                  <strong>Ada Okonkwo</strong>
                  <small>Instalment 1 · Matched</small>
                </span>
                <strong>₦42,000.00</strong>
              </li>
              <li>
                <span className="lp-person-mark" aria-hidden="true">
                  TB
                </span>
                <span>
                  <strong>Túndé Bakare</strong>
                  <small>Instalment 2 · Matched</small>
                </span>
                <strong>₦25,000.00</strong>
              </li>
              <li>
                <span className="lp-person-mark is-review" aria-hidden="true">
                  CO
                </span>
                <span>
                  <strong>Chiamaka Ọbi</strong>
                  <small>Proposed match · Waiting for review</small>
                </span>
                <strong>₦18,000.00</strong>
              </li>
            </ul>
          </>
        )}
        {active === 1 && (
          <>
            <div className="lp-showcase-total">
              <div>
                <span>Sample one-time checkout</span>
                <strong>
                  ₦18,000<span>.00</span>
                </strong>
              </div>
              <span className="lp-preview-status is-pending">
                Waiting for confirmation
              </span>
            </div>
            <ol
              className="lp-payment-stages"
              aria-label="Example payment steps"
            >
              <li>
                <Check aria-hidden="true" />
                <span>
                  <strong>Checkout details</strong>
                  <small>Amount, recipient and instalment are linked.</small>
                </span>
              </li>
              <li>
                <Check aria-hidden="true" />
                <span>
                  <strong>Bank authorisation</strong>
                  <small>The customer authorises this one payment.</small>
                </span>
              </li>
              <li className="is-current">
                <CircleDot aria-hidden="true" />
                <span>
                  <strong>Payment confirmed</strong>
                  <small>Only a confirmed payment can be matched.</small>
                </span>
              </li>
            </ol>
          </>
        )}
        {active === 2 && (
          <>
            <div className="lp-credit-state">
              <span>
                <FileCheck2 aria-hidden="true" />
              </span>
              <div>
                <small>Example assessment</small>
                <strong>Ready for lender review</strong>
                <p>
                  The evidence supports the conversation. The lender makes the
                  decision.
                </p>
              </div>
            </div>
            <dl className="lp-credit-checks">
              <div>
                <dt>Read applicant accounts</dt>
                <dd>Granted separately</dd>
              </div>
              <div>
                <dt>Assess an application</dt>
                <dd>Granted separately</dd>
              </div>
              <div>
                <dt>Evidence and affordability</dt>
                <dd>Checks you can follow</dd>
              </div>
              <div>
                <dt>Final review</dt>
                <dd>By a different person</dd>
              </div>
            </dl>
          </>
        )}
        {active === 3 && (
          <>
            <div className="lp-showcase-total">
              <div>
                <span>Sample available business cash</span>
                <strong>
                  ₦24,200,000<span>.00</span>
                </strong>
              </div>
              <span className="lp-preview-status">Sample business</span>
            </div>
            <div
              className="lp-cash-scenarios"
              aria-label="Example cash scenarios"
            >
              <div>
                <span>Base case · day 30</span>
                <strong>₦30,500,000.00</strong>
                <i aria-hidden="true" style={{ width: "100%" }} />
              </div>
              <div>
                <span>Downside · day 30</span>
                <strong>₦17,580,000.00</strong>
                <i aria-hidden="true" style={{ width: "57.6%" }} />
              </div>
            </div>
            <p className="lp-cash-scenario-note">
              Compare slower receipts with the same committed outgoings.
            </p>
            <div className="lp-cash-tags">
              <span>Accounting drafts</span>
              <span>VAT evidence</span>
              <span>Payroll funding</span>
            </div>
          </>
        )}
        <div className="lp-showcase-panel-foot">
          <p>{item.note}</p>
          <Link href={item.path}>
            Explore {item.name}
            <ArrowUpRight aria-hidden="true" />
          </Link>
        </div>
      </div>
      <figcaption>
        Examples with sample data. Live payments and bank connections are
        switched off.
      </figcaption>
    </figure>
  );
}

export function LandingWorkspaces() {
  return (
    <section
      id="what"
      className="lp-section lp-workspaces-section"
      aria-labelledby="workspaces-title"
    >
      <span
        id="connected-banking"
        className="lp-anchor-alias"
        aria-hidden="true"
      />
      <div className="public-container">
        <div className="lp-section-intro lp-split-intro">
          <p className="lp-section-kicker">Products</p>
          <h2 id="workspaces-title">
            Start with the work{" "}
            <br />
            you need to do.
          </h2>
          <p>
            Follow a collection, check a credit assessment or plan business
            cash. Each product keeps its own records, permissions and review
            steps.
          </p>
        </div>
        <div className="lp-workspace-grid">
          {publicWorkspaces.map((item, index) => (
            <article key={item.name} className="lp-workspace-card">
              <div className="lp-workspace-card-top">
                <span className="lp-icon-tile">
                  <item.icon aria-hidden="true" />
                </span>
                <span>0{index + 1}</span>
              </div>
              <p className="lp-workspace-category">{item.name}</p>
              <h3>{item.lead}</h3>
              <p>{item.description}</p>
              <ul aria-label={`${item.name} features`}>
                {item.details.map((detail) => (
                  <li key={detail}>
                    <Check aria-hidden="true" />
                    {detail}
                  </li>
                ))}
              </ul>
              <Link href={item.path}>
                Explore {item.name}
                <ArrowRight aria-hidden="true" />
              </Link>
            </article>
          ))}
        </div>
        <div className="lp-permission-bridge">
          <ShieldCheck aria-hidden="true" />
          <div>
            <strong>Linked records. Separate permissions.</strong>
            <p>
              Permission to read an account is not permission to take money from
              it, make a lending decision or post an accounting entry.
            </p>
          </div>
          <Link href="/connections">
            Open Permissions and readiness <ArrowUpRight aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}
