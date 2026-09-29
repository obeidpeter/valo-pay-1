import { Link } from "wouter";
import {
  ArrowRight,
  ArrowUpRight,
  Building2,
  Check,
  ChevronDown,
  Fingerprint,
  Landmark,
  LockKeyhole,
  ShieldCheck,
  UserRoundCheck,
  Wallet,
} from "lucide-react";
import { BrandLockup } from "@/components/brand";
import { Button } from "@/components/ui/button";
import "@/landing-sections.css";
import { PilotEnquiry, ProductWalkthrough } from "./product-walkthrough";

const steps = [
  {
    title: "Start with a sample workflow",
    text: "Open the sandbox without an account. Follow a collection, a pay-by-bank checkout, a credit assessment or a business cash plan using synthetic records.",
    detail: "No bank connection needed",
  },
  {
    title: "See how each decision is made",
    text: "Check the source, permissions and review history. Try incomplete evidence and uncertain payment outcomes, as well as the straightforward cases.",
    detail: "Evidence before action",
  },
  {
    title: "Scope a pilot around your team",
    text: "Agree the use case, data access, provider support and success measures. Live use requires separate agreements, testing and approvals for each capability.",
    detail: "A defined path to live use",
  },
];

const boundaries = [
  {
    icon: Wallet,
    title: "Your money stays outside Valo Pay",
    text: "Valo Pay does not hold funds. The sandbox simulates payments; any future live movement must use an approved bank or payment-provider route.",
  },
  {
    icon: Fingerprint,
    title: "Permission is specific to the task",
    text: "Reading accounts, assessing credit and preparing payroll are separate permissions. Reading data never gives authority to move money.",
  },
  {
    icon: UserRoundCheck,
    title: "Reviews remain visible and accountable",
    text: "Credit results are illustrative, not lending approvals. Accounting and payroll drafts need an independent review. A downloaded file is not a completed payment or accounting entry.",
  },
];

const audiences = [
  {
    icon: Landmark,
    title: "Lenders & cooperatives",
    task: "Start with collections",
    text: "Bring mandates, payment evidence and unresolved collections into one daily routine. Explore how pay-by-bank fits alongside it.",
    link: "/overview",
    action: "Explore collections",
  },
  {
    icon: UserRoundCheck,
    title: "Credit & risk teams",
    task: "Start with an application",
    text: "Inspect income evidence, affordability and policy reasons. See how an independent reviewer records an outcome and an applicant explanation.",
    link: "/credit-desk",
    action: "Explore Credit Desk",
  },
  {
    icon: Building2,
    title: "SME finance teams",
    task: "Start with business cash",
    text: "Explore cash forecasts, accounting drafts, VAT evidence and payroll funding in a separate sample business entity.",
    link: "/cash-desk",
    action: "Explore Cash Desk",
  },
];

const questions = [
  {
    question: "What can I use today?",
    answer:
      "You can explore the collections console, Pay-by-bank, Credit Desk, Cash Desk and Permissions & readiness with synthetic data. These are working sample workflows. They do not connect to your bank, move money, approve a real loan, post to accounting software or file tax.",
  },
  {
    question: "Do I need to sign in or connect a bank?",
    answer:
      "No. Open the sandbox to try sample records without signing in or adding credentials. Sign in for an account-linked workspace on future visits. Your anonymous sample work does not transfer into that workspace. Do not enter real customer or bank data into the synthetic sandbox.",
  },
  {
    question: "Does a credit score mean a loan is approved?",
    answer:
      "No. Credit Desk shows evidence checks, an illustrative rule score, affordability and policy reasons for a human reviewer. Its sample score has not been validated as a prediction of default, and no result authorises lending or disbursement.",
  },
  {
    question: "Are Paystack and Xero already connected?",
    answer:
      "Paystack is the preferred first payment provider, and Xero is the first accounting target. The connected workflows currently use synthetic records. A provider name or a successful demo does not establish a live integration, bank coverage or permission to initiate payments or post entries.",
  },
  {
    question: "Can I use Cash Desk without being a lender?",
    answer:
      "Cash Desk is designed for business finance teams as well as lenders. Its sample SME is a separate legal entity from borrower records. A future pilot is scoped to your business and the capabilities you need; it does not automatically include or require every collections product.",
  },
  {
    question: "What happens before a pilot goes live?",
    answer:
      "The team agrees the scope and price, verifies the data and payment routes, documents the relevant permissions and completes operational acceptance checks. Requirements differ by capability. The Permissions & readiness page shows the release requirements; the sandbox has no shortcut to turn on live operations.",
  },
];

/** Static public content: no workspace or bank-data request is made on a page visit. */
export function LandingSections({ signedIn }: { signedIn: boolean }) {
  return (
    <>
      <ProductWalkthrough />

      <section
        id="how"
        className="lp-section lp-process-section"
        aria-labelledby="how-title"
      >
        <div className="public-container">
          <div className="lp-section-intro lp-split-intro">
            <p className="lp-section-kicker">
              From a first look to a focused pilot
            </p>
            <h2 id="how-title">
              Try the workflow.{" "}
              <br />
              Understand the decisions.
            </h2>
            <p>
              Start with a safe place to explore. Build a live plan around the
              work your team actually needs to do.
            </p>
          </div>
          <ol className="lp-process-grid">
            {steps.map((step, index) => (
              <li key={step.title}>
                <div className="lp-process-top">
                  <span className="lp-process-number" aria-hidden="true">
                    0{index + 1}
                  </span>
                  {index < 2 && <ArrowRight aria-hidden="true" />}
                </div>
                <h3>
                  <span className="sr-only">Step {index + 1}: </span>
                  {step.title}
                </h3>
                <p>{step.text}</p>
                <span className="lp-process-detail">
                  <Check aria-hidden="true" />
                  {step.detail}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section
        className="lp-section lp-audience-section"
        aria-labelledby="audience-title"
      >
        <div className="public-container">
          <div className="lp-section-intro lp-split-intro">
            <p className="lp-section-kicker">Find your starting point</p>
            <h2 id="audience-title">
              Different teams.{" "}
              <br />A clearer way to work.
            </h2>
            <p>
              You do not need to start with everything. Choose the workflow
              closest to the decisions you make each day.
            </p>
          </div>
          <ul className="lp-audience-grid" role="list">
            {audiences.map((audience) => (
              <li key={audience.title}>
                <span className="lp-icon-tile">
                  <audience.icon aria-hidden="true" />
                </span>
                <div>
                  <p className="lp-audience-task">{audience.task}</p>
                  <h3>{audience.title}</h3>
                  <p>{audience.text}</p>
                </div>
                <Link className="lp-text-link" href={audience.link}>
                  {audience.action}
                  <ArrowUpRight aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section
        id="boundaries"
        className="lp-section lp-trust-section"
        aria-labelledby="boundaries-title"
      >
        <div className="public-container lp-trust-layout">
          <div className="lp-trust-copy">
            <p className="lp-section-kicker">Clear about what is ready</p>
            <h2 id="boundaries-title">
              Confidence starts{" "}
              <br />
              with clear boundaries.
            </h2>
            <p>
              Explore what the software does today, with the limits visible.
              Every new financial workflow currently runs on sample data.
            </p>
            <div className="lp-readiness-note">
              <LockKeyhole aria-hidden="true" />
              <div>
                <strong>Live operations are disabled</strong>
                <p>
                  Bank connections, real payment initiation, accounting posting,
                  tax filing and payouts need separate acceptance.
                </p>
              </div>
            </div>
            <Link href="/connections" className="lp-text-link">
              View permissions & readiness
              <ArrowUpRight aria-hidden="true" />
            </Link>
          </div>
          <dl className="lp-boundary-grid">
            {boundaries.map((item) => (
              <div key={item.title} className="lp-boundary-card">
                <dt>
                  <span className="lp-boundary-icon">
                    <item.icon aria-hidden="true" />
                  </span>
                  {item.title}
                </dt>
                <dd>{item.text}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section
        id="pricing"
        className="lp-section lp-pricing-section"
        aria-labelledby="pricing-title"
      >
        <div className="public-container">
          <div className="lp-section-intro lp-split-intro">
            <p className="lp-section-kicker">Pricing with the scope attached</p>
            <h2 id="pricing-title">
              A clear cost for{" "}
              <br />a defined workflow.
            </h2>
            <p>
              Explore the synthetic sandbox without a paid plan. Pilot scope,
              implementation and commercial terms are agreed separately before
              live use.
            </p>
          </div>
          <div className="lp-commercial-grid">
            <div className="lp-pricing-card">
              <div className="lp-licence-price">
                <p>Core collections · proposed entry pricing</p>
                <p>
                  <span>From</span>
                  <strong>₦150,000</strong>
                  <span>/ month</span>
                </p>
                <p className="lp-price-scope">
                  Planning basis: fewer than 3,000 qualifying collections per
                  month. This is an indicative proposal, not a checkout offer.
                </p>
              </div>
              <div className="lp-fee-example">
                <h3>What the entry proposal includes</h3>
                <dl>
                  <div>
                    <dt>One-time implementation</dt>
                    <dd>₦1,000,000</dd>
                  </div>
                  <div>
                    <dt>Per qualifying direct debit</dt>
                    <dd>0.3%, capped at ₦150</dd>
                  </div>
                  <div>
                    <dt>Example: a ₦30,000 collection</dt>
                    <dd>₦90 usage fee</dd>
                  </div>
                </dl>
                <p>
                  Usage applies to contract-defined, settled and unreversed
                  direct debits after the reversal window. Reconciled transfers
                  and card receipts do not become direct-debit fees.
                </p>
                <p>
                  Provider charges and VAT are additional where applicable. The
                  example is the usage component only; volume tiers and complete
                  pilot terms are confirmed in writing.
                </p>
              </div>
            </div>
            <div className="lp-module-pricing">
              <span className="lp-icon-tile">
                <ShieldCheck aria-hidden="true" />
              </span>
              <p className="lp-module-kicker">
                Pay-by-bank · Credit Desk · Cash Desk
              </p>
              <h3>Start with the capabilities you need.</h3>
              <p>
                New modules are scoped and priced separately for a pilot. The
                collections entry price is not an all-product subscription.
              </p>
              <ul role="list">
                <li>
                  <Check aria-hidden="true" />
                  An agreed use case and evaluation period
                </li>
                <li>
                  <Check aria-hidden="true" />
                  Explicit account, assessment or usage limits
                </li>
                <li>
                  <Check aria-hidden="true" />
                  Provider access and implementation requirements
                </li>
                <li>
                  <Check aria-hidden="true" />
                  Written acceptance criteria and complete charges
                </li>
              </ul>
              <a className="lp-text-link" href="#pilot">
                Discuss scope and pricing
                <ArrowRight aria-hidden="true" />
              </a>
            </div>
          </div>
        </div>
      </section>

      <section
        id="questions"
        className="lp-section lp-faq-section"
        aria-labelledby="questions-title"
      >
        <div className="public-container lp-faq-layout">
          <div className="lp-section-intro">
            <p className="lp-section-kicker">Before you begin</p>
            <h2 id="questions-title">A few useful answers.</h2>
            <p>
              What you can try now, what the sample data means and what comes
              next.
            </p>
          </div>
          <div className="lp-faq-list">
            {questions.map((item) => (
              <details key={item.question}>
                <summary>
                  {item.question}
                  <ChevronDown aria-hidden="true" />
                </summary>
                <p>{item.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <PilotEnquiry />
      <section className="lp-cta-section" aria-labelledby="cta-title">
        <div className="public-container">
          <div className="lp-final-cta">
            <div className="lp-cta-art" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </div>
            <div className="lp-cta-copy">
              <p className="lp-section-kicker">See the work, end to end</p>
              <h2 id="cta-title">
                Make your next decision{" "}
                <br />a clearer one.
              </h2>
              <p>
                Follow a payment. Review an application. Plan the next month of
                business cash. Try it first with sample data.
              </p>
            </div>
            <div className="lp-cta-controls">
              <div className="lp-cta-actions">
                <Button asChild size="lg" className="lp-cta-button">
                  <Link href="/overview">
                    Open the sandbox
                    <ArrowUpRight aria-hidden="true" />
                  </Link>
                </Button>
                {!signedIn && (
                  <Button
                    asChild
                    size="lg"
                    variant="ghost"
                    className="lp-cta-signin"
                  >
                    <Link href="/sign-in">
                      Sign in
                      <ArrowRight aria-hidden="true" />
                    </Link>
                  </Button>
                )}
              </div>
              <span className="lp-cta-note">
                <span aria-hidden="true" />
                No sign-in needed. Sample data only.
              </span>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

export function LandingFooter() {
  return (
    <footer className="lp-footer">
      <div className="public-container">
        <div className="lp-footer-main">
          <div className="lp-footer-brand">
            <BrandLockup href="#main" />
            <p>Collections, credit and cash operations.</p>
            <span>Synthetic sandbox · No live financial operations</span>
          </div>
          <nav aria-label="Product workspaces" className="lp-footer-links">
            <h2>Explore the sandbox</h2>
            <Link href="/overview">Collections</Link>
            <Link href="/pay-by-bank">Pay-by-bank</Link>
            <Link href="/credit-desk">Credit Desk</Link>
            <Link href="/cash-desk">Cash Desk</Link>
            <Link href="/connections">Permissions & readiness</Link>
          </nav>
          <nav aria-label="Product sections" className="lp-footer-links">
            <h2>Discover Valo Pay</h2>
            <a href="#what">Products</a>
            <a href="#product-tour">Product tour</a>
            <a href="#how">How it works</a>
            <a href="#pricing">Pricing</a>
            <a href="#questions">Common questions</a>
            <a href="#pilot">Discuss a pilot</a>
          </nav>
          <nav aria-label="Help and documentation" className="lp-footer-links">
            <h2>Useful information</h2>
            <Link href="/help">Task guides & glossary</Link>
            <a href="#boundaries">Our boundaries</a>
            <a href="https://github.com/obeidpeter/valo-pay#readme">
              How the sandbox works
            </a>
            <a href="https://github.com/obeidpeter/valo-pay/blob/main/docs/connected-banking.md">
              What is implemented
            </a>
            <a href="https://github.com/obeidpeter/valo-pay/blob/main/docs/DATABASE_SECURITY.md">
              Security and data access
            </a>
            <Link href="/sign-in">Sign in</Link>
          </nav>
        </div>
        <div className="lp-footer-bottom">
          <p>Valo Pay · We never hold money.</p>
          <div className="lp-footer-location">
            <span>Built for lenders and businesses in Nigeria.</span>
            <span className="lp-nigerian-flag" aria-hidden="true" />
          </div>
        </div>
      </div>
    </footer>
  );
}
