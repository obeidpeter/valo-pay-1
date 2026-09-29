import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import axe from "axe-core";
import { ContextualHelp } from "@/components/contextual-help";
import { helpGuides, helpHref, helpIndexHref, helpTerms, safeHelpReturnTo } from "@/lib/help-content";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";

let api: FakeApi;
beforeEach(() => {
  api = installFakeApi();
});
afterEach(() => {
  api.uninstall();
});

describe("public task help", () => {
  it("lets a visitor read every task without creating or querying a workspace", async () => {
    for (const guide of helpGuides) {
      const page = renderApp(`/help?topic=${guide.id}`);
      expect(
        await screen.findByRole("heading", { name: guide.title, level: 2 }),
      ).toBeTruthy();
      expect(
        screen.getByRole("heading", { name: "If you are blocked" }),
      ).toBeTruthy();
      expect(
        screen.getByRole("heading", { name: "If you were interrupted" }),
      ).toBeTruthy();
      expect(screen.getByText(guide.result)).toBeTruthy();
      page.unmount();
    }
    expect(api.calls).toEqual([]);
  });

  it("supports a direct topic, returning to its search and browser back without losing the query", async () => {
    const user = userEvent.setup();
    renderApp("/help?q=payment&topic=payment-status&returnTo=%2Fpay-by-bank");
    await screen.findByRole("heading", {
      name: "Understand payment status without paying twice",
    });
    expect(
      screen
        .getByRole("searchbox", { name: "Search tasks and terms" })
        .getAttribute("value"),
    ).toBe("payment");
    expect(
      screen
        .getByRole("link", { name: "Back to your page" })
        .getAttribute("href"),
    ).toBe("/pay-by-bank");
    await user.click(
      screen.getByRole("link", { name: "Back to search results" }),
    );
    const results = await screen.findByRole("heading", {
      name: "Search results",
    });
    expect(document.activeElement).toBe(results);
    expect(new URLSearchParams(window.location.search).get("q")).toBe(
      "payment",
    );
    expect(
      screen.queryByRole("heading", { name: "If you are blocked" }),
    ).toBeNull();
    window.history.back();
    const restored = await screen.findByRole("heading", {
      name: "Understand payment status without paying twice",
      level: 2,
    });
    await waitFor(() => expect(document.activeElement).toBe(restored));
    expect(new URLSearchParams(window.location.search).get("topic")).toBe(
      "payment-status",
    );
    expect(api.calls).toEqual([]);
  });

  it("keeps the search, section and return page in its links where URLSearchParams has no size", async () => {
    // Safari 16, Chrome and Edge before 113 and Firefox before 112, all in the build's target, have no size.
    const size = Object.getOwnPropertyDescriptor(URLSearchParams.prototype, "size");
    delete (URLSearchParams.prototype as { size?: number }).size;
    try {
      expect(new URLSearchParams("q=payment").size).toBeUndefined();
      const user = userEvent.setup();
      renderApp("/help?q=payment&returnTo=%2Fpay-by-bank");
      const guide = await screen.findByRole("link", {
        name: /Understand payment status without paying twice/,
      });
      expect(guide.getAttribute("href")).toBe(
        "/help?q=payment&returnTo=%2Fpay-by-bank&topic=payment-status",
      );
      expect(
        screen.getByRole("link", { name: "Terms explained" }).getAttribute("href"),
      ).toBe("/help?q=payment&returnTo=%2Fpay-by-bank&view=glossary");
      expect(
        screen.getByRole("link", { name: "Clear search" }).getAttribute("href"),
      ).toBe("/help?returnTo=%2Fpay-by-bank");
      await user.click(guide);
      await screen.findByRole("heading", {
        name: "Understand payment status without paying twice",
        level: 2,
      });
      expect(
        screen
          .getByRole("link", { name: "Back to search results" })
          .getAttribute("href"),
      ).toBe("/help?q=payment&returnTo=%2Fpay-by-bank");
    } finally {
      if (size) Object.defineProperty(URLSearchParams.prototype, "size", size);
    }
    expect(api.calls).toEqual([]);
  });

  it("finds a guide through a specialist term and offers an actionable empty search state", async () => {
    const user = userEvent.setup();
    renderApp("/help");
    const input = await screen.findByRole("searchbox", {
      name: "Search tasks and terms",
    });
    await user.type(input, "kobo");
    await user.click(screen.getByRole("button", { name: "Search help" }));
    expect(
      await screen.findByRole("link", {
        name: /Import your first payment file/,
      }),
    ).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("q")).toBe("kobo");
    expect(screen.getByRole("status").textContent).toBe("1 guide for “kobo”");
    await user.clear(input);
    await user.type(input, "zzznosuchtask");
    await user.keyboard("{Enter}");
    expect(
      await screen.findByRole("heading", { name: "No matching guides" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("link", { name: "Show all guides" }));
    expect(
      await screen.findByRole("link", {
        name: /Prepare a reviewed payroll file/,
      }),
    ).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("");
    expect(api.calls).toEqual([]);
  });

  it("finds task guides using common payment states and workflow names", async () => {
    const user = userEvent.setup();
    renderApp("/help");
    const input = await screen.findByRole("searchbox", {
      name: "Search tasks and terms",
    });
    const cases = [
      ["pending", /Understand payment status without paying twice/],
      ["payment pending", /Understand payment status without paying twice/],
      ["mandate", /Suspend, resume, cancel or reissue a mandate/],
      ["reconciliation", /Match a payment to an instalment/],
      ["payroll", /Prepare a reviewed payroll file/],
    ] as const;
    for (const [query, title] of cases) {
      await user.clear(input);
      await user.type(input, query);
      await user.keyboard("{Enter}");
      expect(await screen.findByRole("link", { name: title })).toBeTruthy();
    }
    expect(api.calls).toEqual([]);
  });

  it("searches the glossary using formal language without confusing reading with debit authority", async () => {
    const user = userEvent.setup();
    renderApp("/help?view=glossary&q=account-read");
    await screen.findByRole("heading", { name: "Terms explained", level: 2 });
    // The headword is the permission's name on screen; the old formal term is a search word the page does not show.
    expect(screen.getByText("Read applicant accounts")).toBeTruthy();
    expect(screen.queryByText("Account-read consent")).toBeNull();
    expect(
      screen.getByText(/Permission to read an account is not permission to take money from it/),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Terms explained" })
        .getAttribute("aria-current"),
    ).toBe("page");
    await user.click(screen.getByRole("link", { name: "Clear search" }));
    expect(screen.getByText("Imported")).toBeTruthy();
    expect(screen.getByText(/Exporting the file pays no one/)).toBeTruthy();
    expect(api.calls).toEqual([]);
  });

  it("names every Terms explained entry by its word on screen and still finds it by an old name", async () => {
    // Every guide's terms are entries in Terms explained.
    const ids = new Set(helpTerms.map((term) => term.id));
    for (const guide of helpGuides) for (const id of guide.terms) expect(ids.has(id), `${guide.id}: ${id}`).toBe(true);
    renderApp("/help?view=glossary&q=Tenant");
    await screen.findByRole("heading", { name: "Terms explained", level: 2 });
    expect(screen.getByText("Organisation")).toBeTruthy();
    expect(screen.queryByText("Tenant")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("1 term for “Tenant”");
    await waitFor(() => expect(document.title).toBe("Terms explained · Help · Valo Pay"));
    expect(api.calls).toEqual([]);
  });

  it("finds the page once called Operations by its old name", async () => {
    renderApp("/help?view=glossary&q=Operations");
    await screen.findByRole("heading", { name: "Terms explained", level: 2 });
    expect(screen.getByText("Request history")).toBeTruthy();
    expect(screen.getByText(/It was called Operations\./)).toBeTruthy();
    expect(api.calls).toEqual([]);
  });

  it("recovers an unknown topic and never turns an untrusted return address into a link", async () => {
    renderApp(
      "/help?topic=missing&returnTo=https%3A%2F%2Fexample.test%2Fsecret",
    );
    expect(await screen.findByText(/That guide is not available/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Back to home" }).getAttribute("href"),
    ).toBe("/");
    expect(
      screen.queryByRole("link", { name: "Back to your page" }),
    ).toBeNull();
    expect(
      Array.from(document.querySelectorAll("a")).some((link) =>
        link.href.startsWith("https://example.test"),
      ),
    ).toBe(false);
    expect(api.calls).toEqual([]);
  });

  it("keeps financial distinctions and independent review visible in the relevant guides", async () => {
    const user = userEvent.setup();
    renderApp("/help?topic=close");
    await screen.findByRole("heading", {
      name: "Prepare a daily close for a different reviewer",
    });
    expect(
      screen.getByText(/Switching demo roles is not a second person/),
    ).toBeTruthy();
    expect(
      screen.getByText(/It does not resolve exceptions, move money/),
    ).toBeTruthy();
    await user.click(screen.getByRole("link", { name: "All task guides" }));
    await user.click(
      screen.getByRole("link", {
        name: /Prepare an accounting draft for review/,
      }),
    );
    expect(
      screen.getByText(/Nothing was posted to accounting software/),
    ).toBeTruthy();
    expect(
      screen.getByText(/previous approval does not cover a changed draft/),
    ).toBeTruthy();
    expect(api.calls).toEqual([]);
  });

  it("has labelled keyboard-search controls, landmarks and no structural accessibility violations", async () => {
    const user = userEvent.setup();
    renderApp("/help");
    await screen.findByRole("heading", { name: "Help", level: 1 });
    const input = within(
      screen.getByRole("search", { name: "Search help" }),
    ).getByRole("searchbox", { name: "Search tasks and terms" });
    input.focus();
    await user.keyboard("payroll{Enter}");
    expect(
      await screen.findByRole("link", {
        name: /Prepare a reviewed payroll file/,
      }),
    ).toBeTruthy();
    const result = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
    expect(api.calls).toEqual([]);
  });
});

describe("contextual help links", () => {
  it("returns someone reading sign-up help to sign-up without opening a workspace", async () => {
    const user = userEvent.setup();
    renderApp("/sign-up");
    await user.click(
      await screen.findByRole("link", {
        name: "Help: Sign in or accept an invitation",
      }),
    );
    await screen.findByRole("heading", {
      name: "Sign in or accept an invitation",
      level: 2,
    });
    const back = screen.getByRole("link", { name: "Back to your page" });
    expect(back.getAttribute("href")).toBe("/sign-up");
    await user.click(back);
    expect(
      await screen.findByRole("heading", {
        name: "Create your workspace",
        level: 1,
      }),
    ).toBeTruthy();
    expect(api.calls).toEqual([]);
  });

  it("returns someone reading a Cash Desk section's help to that section", async () => {
    const user = userEvent.setup();
    renderApp("/cash-desk?view=payroll");
    await user.click(
      await screen.findByRole("link", {
        name: "Help: Prepare a reviewed payroll file",
      }),
    );
    await screen.findByRole("heading", {
      name: "Prepare a reviewed payroll file",
      level: 2,
    });
    const back = screen.getByRole("link", { name: "Back to your page" });
    expect(back.getAttribute("href")).toBe("/cash-desk?view=payroll");
    await user.click(back);
    expect(
      (
        await screen.findByRole("button", { name: "Payroll funding" })
      ).getAttribute("aria-current"),
    ).toBe("page");
    expect(api.calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it.each([
    [
      "/mandates",
      "Suspend, resume, cancel or reissue a mandate",
      "Mandates",
      /Nothing is sent to a bank or provider/,
    ],
    [
      "/policies",
      "Review retry policies and message templates",
      "Policies and templates",
      /Applying a policy to a mandate is a separate step on Mandates/,
    ],
  ])(
    "keeps %s guidance separate from account-read permission withdrawal",
    async (route, title, destination, consequence) => {
      const user = userEvent.setup();
      renderApp(route as string);
      await user.click(
        await screen.findByRole("link", { name: `Help: ${title}` }),
      );
      await screen.findByRole("heading", { name: title as string, level: 2 });
      expect(
        screen.getByText(destination as string, { exact: true }),
      ).toBeTruthy();
      expect(screen.getByText(consequence as RegExp)).toBeTruthy();
      expect(api.calls.filter((call) => call.method === "POST")).toEqual([]);
    },
  );

  it.each([
    ["/customers", "Help: Find a customer and their history"],
    ["/collections", "Help: Track instalments and collection attempts"],
    ["/reports", "Help: Read reports and run a daily close"],
    ["/audit", "Help: Search and check the audit log"],
    ["/evidence", "Help: Record go-live evidence and commercial terms"],
    ["/team", "Help: Invite team members and manage their access"],
    ["/lifecycle", "Help: Choose how long files are kept and delete old ones"],
    ["/settings", "Help: Change settings, the emergency stop and your demo role"],
    ["/operations", "Help: Check a request that was not confirmed"],
  ])("links %s to the guide about that page", async (route, name) => {
    renderApp(route);
    const link = await screen.findByRole("link", { name });
    expect(link.getAttribute("href")).toContain(`returnTo=${encodeURIComponent(route)}`);
  });

  it.each(["/pilot", "/sources", "/presentation"])("links %s, which has no guide of its own, to the help index", async (route) => {
    const user = userEvent.setup();
    renderApp(route);
    const main = await screen.findByRole("main");
    const link = await within(main).findByRole("link", { name: "Help" });
    expect(link.getAttribute("href")).toBe(helpIndexHref(route));
    await user.click(link);
    await screen.findByRole("heading", { name: "Help", level: 1 });
    await waitFor(() => expect(document.title).toBe("Help · Valo Pay"));
    expect(screen.getByRole("link", { name: "Back to your page" }).getAttribute("href")).toBe(route);
  });

  it("opens the precise task with a safe static return page", () => {
    render(<ContextualHelp topic="imports" returnTo="/imports" />);
    const link = screen.getByRole("link", {
      name: "Help: Import your first payment file",
    });
    expect(link.getAttribute("href")).toBe(
      "/help?topic=imports&returnTo=%2Fimports",
    );
    expect(api.calls).toEqual([]);
  });

  it("does not carry external destinations, record queries, tokens or arbitrary paths into help", () => {
    for (const value of [
      "https://example.test",
      "//example.test",
      "javascript:alert(1)",
      "/imports?batch=private-record",
      "/team-invite#secret",
      "/cases/private-id",
      "/\\example.test",
      "/overview/../sign-in",
      "/overview\n",
      "/cash-desk?view=unknown",
      "/cash-desk?view=payroll&record=private-id",
    ]) {
      expect(safeHelpReturnTo(value)).toBeNull();
      expect(helpHref("recovery", value)).toBe("/help?topic=recovery");
    }
    for (const value of ["https://example.test", "/cases/private-id"]) expect(helpIndexHref(value)).toBe("/help");
    expect(safeHelpReturnTo("/cash-desk")).toBe("/cash-desk");
    expect(safeHelpReturnTo("/cash-desk?view=payroll")).toBe(
      "/cash-desk?view=payroll",
    );
  });
});
