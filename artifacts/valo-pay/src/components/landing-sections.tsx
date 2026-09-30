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
    text: "Open the sandbox without an account. Follow a collection, a Pay by Bank checkout, a credit assessment or a cash plan, all with sample data.",
    detail: "No bank connection needed",
  },
  {
    title: "See how each decision is made",
    text: "Check the source, permissions and review history. Try incomplete evidence and payments whose outcome is unknown, as well as the simple cases.",
    detail: "Evidence before action",
  },
  {
    title: "Scope a pilot around your team",
    text: "Agree the use case, data access, provider support and how you will measure success. Each product needs its own agreement, testing and approval before live use.",
    detail: "A defined path to live use",
  },
];

const boundaries = [
  {
    icon: Wallet,
    title: "Your money stays outside Valo Pay",
    text: "Valo Pay never holds money. Payments in Valo Pay are simulated. In future, any real payment must go through an approved bank or payment provider.",
  },
  {
    icon: Fingerprint,
    title: "Permission is specific to the task",
    text: "Reading accounts, assessing credit and preparing payroll are separate permissions. Permission to read an account is not permission to take money from it.",
  },
  {
    icon: UserRoundCheck,
    title: "Reviews remain visible and accountable",
    text: "A credit result is not a lending decision. A different person must review accounting and payroll drafts. A downloaded file is not a completed payment or accounting entry.",
  },
];

const audiences = [
  {
    icon: Landmark,
    title: "Lenders and cooperatives",
    task: "Start with collections",
    text: "Bring mandates, payment evidence and unresolved collections into one daily routine. Then see how Pay by Bank fits in.",
    link: "/overview",
    action: "Explore Collections",
  },
  {
    icon: UserRoundCheck,
    title: "Credit and risk teams",
    task: "Start with an application",
    text: "Check income evidence, affordability and policy reasons. See how a reviewer, not the person who prepared the assessment, records the review and the explanation for the applicant.",
    link: "/credit-desk",
    action: "Explore Credit Desk",
  },
  {
    icon: Building2,
    title: "Finance teams at small businesses",
    task: "Start with business cash",
    text: "Explore cash forecasts, accounting drafts, VAT evidence and payroll funding for a sample business.",
    link: "/cash-desk",
    action: "Explore Cash Desk",
  },
];

const questions = [
  {
    question: "What can I use today?",
    answer:
      "You can try Collections, Pay by Bank, Credit Desk and Cash Desk, and the Permissions and readiness page, with sample data. They do not connect to your bank, move money, approve a real loan, post to accounting software or file tax.",
  },
  {
    question: "Do I need to sign in or connect a bank?",
    answer:
      "No. Open the sandbox to try sample data without signing in or connecting a bank. Sign in to use your workspace, which is linked to your account and kept for your next visit. Work you do in the sandbox is not copied to your workspace. Do not enter real customer or bank details in the sandbox or in your workspace.",
  },
  {
    question: "Does a credit score mean a loan is approved?",
    answer:
      "No. Credit Desk shows evidence checks, a sample rule score (not validated), an affordability check and policy reasons for a person to review. A credit result is not a lending decision. Credit Desk never approves a loan or pays one out.",
  },
  {
    question: "Are Paystack and Xero already connected?",
    answer:
      "No. Paystack is the preferred first payment provider, and Xero the first accounting software Valo Pay aims to connect to. Neither is connected yet. Pay by Bank, Credit Desk and Cash Desk use sample data only. A provider’s name or a working demo is not a live connection. It does not show which banks are covered, and it gives no permission to make payments or post accounting entries.",
  },
  {
    question: "Can I use Cash Desk without being a lender?",
    answer:
      "Yes. Cash Desk is for business finance teams as well as lenders. Its sample business is kept separate from the sample lenders’ customer records. A pilot covers your business and only the products you choose. It does not have to include Collections.",
  },
  {
    question: "What happens before a pilot goes live?",
    answer:
      "You and the Valo Pay team agree the scope and price, check the data and payment routes, record the permissions needed and complete acceptance checks. Each product has its own requirements, shown on the Permissions and readiness page. You cannot switch on live use from the sandbox.",
  },
];

/** Static public content: no workspace or bank-data request is made on a page visit. */
export function LandingSections({ signedIn }: { signedIn: boolean }) {
  return (
    <>
      <ProductWalkthrough signedIn={signedIn} />

      <section
        id="how"
        className="lp-section lp-process-section"
        aria-labelledby="how-title"
      >
        <div className="public-container">
          <div className="lp-section-intro lp-split-intro">
            <p className="lp-section-kicker">How it works</p>
            <h2 id="how-title">
              Try the workflow.{" "}
              <br />
              Understand the decisions.
            </h2>
            <p>
              Start in a safe place to explore. Then plan live use around the
              work your team really does.
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
            <p className="lp-section-kicker">Limits and live use</p>
            <h2 id="boundaries-title">
              Confidence starts{" "}
              <br />
              with clear boundaries.
            </h2>
            <p>
              See what Valo Pay does today, and where its limits are. Pay by Bank,
              Credit Desk and Cash Desk run on sample data only.
            </p>
            <div className="lp-readiness-note">
              <LockKeyhole aria-hidden="true" />
              <div>
                <strong>Live payments and bank connections are switched off</strong>
                <p>
                  Bank connections, real payments, posting to accounting
                  software, tax filing and payouts each need their own approval
                  before live use.
                </p>
              </div>
            </div>
            <Link href="/connections" className="lp-text-link">
              Open Permissions and readiness
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
            <p className="lp-section-kicker">Pricing</p>
            <h2 id="pricing-title">
              A clear cost for{" "}
              <br />a defined workflow.
            </h2>
            <p>
              The sandbox is free to try. Before any live use, you and the Valo
              Pay team agree the pilot’s scope, set-up and commercial terms.
            </p>
          </div>
          <div className="lp-commercial-grid">
            <div className="lp-pricing-card">
              <div className="lp-licence-price">
                <p>Core collections · proposed starting price</p>
                <p>
                  <span>From</span>
                  <strong>₦150,000.00</strong>
                  <span>a month</span>
                </p>
                <p className="lp-price-scope">
                  Based on fewer than 3,000 qualifying collections a month. This
                  is a guide price, not an offer you can accept online.
                </p>
              </div>
              <div className="lp-fee-example">
                <h3>How the proposed price works</h3>
                <dl>
                  <div>
                    <dt>One-time set-up</dt>
                    <dd>₦1,000,000.00</dd>
                  </div>
                  <div>
                    <dt>Per qualifying direct debit</dt>
                    <dd>0.3%, up to ₦150.00</dd>
                  </div>
                  <div>
                    <dt>Example: a ₦30,000.00 collection</dt>
                    <dd>₦90.00 usage fee</dd>
                  </div>
                </dl>
                <p>
                  The usage fee applies only to direct debits that meet your
                  contract’s definition and have settled. It is charged only
                  after the reversal window closes, and never on a reversed
                  debit. Bank transfers and card payments have no usage fee,
                  even when Valo Pay matches them.
                </p>
                <p>
                  Payment provider charges and VAT are extra where they apply.
                  The example shows the usage fee only. The Valo Pay team
                  confirms volume prices and the full pilot terms in writing.
                </p>
              </div>
            </div>
            <div className="lp-module-pricing">
              <span className="lp-icon-tile">
                <ShieldCheck aria-hidden="true" />
              </span>
              <p className="lp-module-kicker">
                Pay by Bank · Credit Desk · Cash Desk
              </p>
              <h3>Start with the products you need.</h3>
              <p>
                Each of these products has its own scope and price in a pilot.
                The Core collections price does not include them.
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
            <p className="lp-section-kicker">Common questions</p>
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
                    {signedIn ? "Open your workspace" : "Open the sandbox"}
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
                {signedIn ? "Sample data only." : "No sign-in needed. Sample data only."}
              </span>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

export function LandingFooter({ signedIn }: { signedIn: boolean }) {
  const explore = signedIn ? "Explore your workspace" : "Explore the sandbox";
  return (
    <footer className="lp-footer">
      <div className="public-container">
        <div className="lp-footer-main">
          <div className="lp-footer-brand">
            <BrandLockup href="#main" />
            <p>Collections, credit and cash operations.</p>
            <span>
              Sample data only. Live payments and bank connections are switched
              off.
            </span>
          </div>
          <nav aria-label={explore} className="lp-footer-links">
            <h2>{explore}</h2>
            <Link href="/overview">Collections</Link>
            <Link href="/pay-by-bank">Pay by Bank</Link>
            <Link href="/credit-desk">Credit Desk</Link>
            <Link href="/cash-desk">Cash Desk</Link>
            <Link href="/connections">Permissions and readiness</Link>
          </nav>
          <nav aria-label="Discover Valo Pay" className="lp-footer-links">
            <h2>Discover Valo Pay</h2>
            <a href="#what">Products</a>
            <a href="#product-tour">Product tour</a>
            <a href="#how">How it works</a>
            <a href="#pricing">Pricing</a>
            <a href="#questions">Common questions</a>
            <a href="#pilot">Discuss a pilot</a>
          </nav>
          <nav aria-label="Useful information" className="lp-footer-links">
            <h2>Useful information</h2>
            <Link href="/help">Help</Link>
            <a href="#boundaries">Limits and live use</a>
            <a href="https://github.com/obeidpeter/valo-pay#readme">
              How the sandbox works (GitHub)
            </a>
            <a href="https://github.com/obeidpeter/valo-pay/blob/main/docs/connected-banking.md">
              What is built so far (GitHub)
            </a>
            <a href="https://github.com/obeidpeter/valo-pay/blob/main/docs/DATABASE_SECURITY.md">
              Security and data access (GitHub)
            </a>
            {!signedIn && <Link href="/sign-in">Sign in</Link>}
          </nav>
        </div>
        <div className="lp-footer-bottom">
          <p>Valo Pay never holds money.</p>
          <div className="lp-footer-location">
            <span>Built for lenders and businesses in Nigeria.</span>
            <span className="lp-nigerian-flag" aria-hidden="true" />
          </div>
        </div>
      </div>
    </footer>
  );
}
