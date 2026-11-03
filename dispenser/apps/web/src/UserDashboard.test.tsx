import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssignmentView, PublicUser } from "@atlas-link-dispenser/shared";
import {
  UserDashboard,
  AssignmentHistory,
  describeAssignment,
  visibleAssignments,
} from "./UserDashboard";

describe("Hub account navigation", () => {
  it("keeps one permanent Support destination separate from Notifications and sign out", () => {
    const html = renderToStaticMarkup(
      <UserDashboard
        user={
          {
            id: "user-fixture",
            email: "fixture@example.test",
            role: "user",
          } as PublicUser
        }
        onLogout={() => {}}
        hubEnabled
      />,
    );
    expect(html.match(/aria-label="Support"/g)).toHaveLength(1);
    expect(html.match(/aria-label="Notifications"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Your Hub"');
    expect(html).toContain("Browser data");
    expect(html).toContain("Sessions");
    expect(html).toContain("Sign out");
  });
});

const assignment = (
  status: "ready" | "previous" | "removed" | "unavailable" = "ready",
  available = true,
  overrides: Partial<AssignmentView> = {},
): AssignmentView =>
  ({
    id: `assignment-${status}`,
    name: `Link ${status}`,
    url: available ? `https://${status}.example.test/` : "",
    assignedAt: "2026-10-01T12:00:00.000Z",
    expiresAt: null,
    status,
    available,
    ...overrides,
  }) as AssignmentView;
const markup = (
  assignments: AssignmentView[],
  problem?: { title: string; message: string; retry: boolean },
  copied?: string,
) =>
  renderToStaticMarkup(
    <AssignmentHistory
      assignments={assignments}
      busy={false}
      copied={copied}
      problem={problem}
      onGenerate={() => {}}
      onCopy={() => {}}
      onReport={() => {}}
    />,
  );

const historyHeading = /<h[1-6][^>]*>Link history<\/h[1-6]>/;
const cardCount = (html: string) =>
  (html.match(/class="[^"]*\bassignment-card\b[^"]*"/g) ?? []).length;
const expectNoExplanations = (html: string) => {
  for (const text of [
    "Previously issued links stay here across weeks",
    "applies only to new requests",
    "Previously issued;",
    "still available to use",
    "Your link history is still available below",
    "that request is restored automatically",
    "An administrator removed or replaced this assignment",
    "This link is disabled or has expired",
    "It stays in your history",
  ])
    expect(html).not.toContain(text);
};

describe("latest link and retained link history", () => {
  it("shows a single newest link separately without an empty history section", () => {
    const html = markup([assignment()]);
    expect(html).toMatch(/<h[1-6][^>]*>Latest link<\/h[1-6]>/);
    expect(html).not.toMatch(historyHeading);
    expect(cardCount(html)).toBe(1);
    expect(html).toContain("Generate another link");
    expect(html).toContain("Link ready");
    expectNoExplanations(html);
  });

  it("puts exactly the first API-ordered link above the history heading and the remaining links below", () => {
    const latest = assignment("ready", true, {
      id: "latest",
      name: "Newest assignment",
      assignedAt: "2026-10-16T14:00:00.000Z",
    });
    const older = assignment("previous", true, {
      id: "older",
      name: "Earlier assignment",
      assignedAt: "2026-10-09T14:00:00.000Z",
    });
    const oldest = assignment("previous", true, {
      id: "oldest",
      name: "Oldest assignment",
      assignedAt: "2026-10-02T14:00:00.000Z",
    });
    const html = markup([latest, older, oldest]);
    expect(html.match(/>Latest link<\//g)).toHaveLength(1);
    expect(html.match(/>Link history<\//g)).toHaveLength(1);
    expect(html).toMatch(historyHeading);
    const [latestSection, historySection] = html.split(historyHeading);
    expect(cardCount(latestSection!)).toBe(1);
    expect(cardCount(historySection!)).toBe(2);
    expect(latestSection).toContain(latest.name);
    expect(latestSection).not.toContain(older.name);
    expect(latestSection).not.toContain(oldest.name);
    expect(historySection).not.toContain(latest.name);
    expect(historySection!.indexOf(older.name)).toBeLessThan(
      historySection!.indexOf(oldest.name),
    );
    for (const row of [latest, older, oldest]) {
      expect(html.split(row.name)).toHaveLength(2);
      expect(html).toContain(new Date(row.assignedAt).toLocaleString());
    }
    expectNoExplanations(html);
  });

  it("preserves the API's order when timestamps tie rather than regrouping by availability", () => {
    const first = assignment("unavailable", false, {
      id: "first",
      name: "First API row",
    });
    const second = assignment("ready", true, {
      id: "second",
      name: "Second API row",
    });
    const html = markup([first, second]);
    const [latestSection, historySection] = html.split(historyHeading);
    expect(latestSection).toContain(first.name);
    expect(latestSection).not.toContain(second.name);
    expect(historySection).toContain(second.name);
    expect(cardCount(latestSection!)).toBe(1);
    expect(cardCount(historySection!)).toBe(1);
  });

  it("does not render an empty history heading or card when there are zero links", () => {
    const html = markup([]);
    expect(html).not.toMatch(historyHeading);
    expect(cardCount(html)).toBe(0);
    expect(html).not.toContain("href=");
  });

  it("shows an available latest link with Open, Copy and Report but no status badge", () => {
    const html = markup([assignment()]);
    expect(html).toContain('href="https://ready.example.test/"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Copy");
    expect(html).toContain("Report");
    expect(html).not.toContain("badge");
    expect(html).not.toContain("Ready");
    expect(html).not.toContain("Previous");
  });

  it("treats a single older available link as the latest link without an explanatory previous status", () => {
    const html = markup([assignment("previous")]);
    expect(html).toContain("Latest link");
    expect(html).not.toMatch(historyHeading);
    expect(html).toContain('href="https://previous.example.test/"');
    expect(html).toContain("Copy");
    expect(html).toContain("Report");
    expect(html).not.toContain("badge");
    expect(html).not.toContain("Ready");
    expect(html).not.toContain("Previous");
    expectNoExplanations(html);
  });

  it("keeps available historical links actionable without Ready, Previous or Current badges", () => {
    const html = markup([assignment(), assignment("previous")]);
    expect(html).toMatch(historyHeading);
    expect(html.match(/href=/g)).toHaveLength(2);
    expect(html).not.toContain("badge");
    for (const label of ["Ready", "Previous", "Current"])
      expect(html).not.toContain(label);
    expectNoExplanations(html);
  });

  it("keeps an unavailable latest link visible with only its short status and no Open or Copy", () => {
    const status = "unavailable";
    const html = markup([assignment(status, false)]);
    expect(html).toContain("Latest link");
    expect(html).toContain("Unavailable");
    expect(html).toContain(`Link ${status}`);
    expect(html).not.toContain("href=");
    expect(html).not.toContain(">Copy<");
    expect(html).not.toContain("Open ");
    expect(html).toContain("Report");
    expectNoExplanations(html);
  });

  it("withholds Open and Copy on an unavailable historical row without hiding it", () => {
    const status = "unavailable";
    const html = markup([assignment(), assignment(status, false)]);
    const [, historySection] = html.split(historyHeading);
    expect(historySection).toContain(`Link ${status}`);
    expect(historySection).toContain("Unavailable");
    expect(historySection).not.toContain("href=");
    expect(historySection).not.toContain(">Copy<");
    expect(historySection).not.toContain("Open ");
    expect(historySection).toContain("Report");
    expectNoExplanations(html);
  });

  it("does not expose even a supplied URL or name for an explicitly removed assignment", () => {
    const html = markup([assignment("removed", true)]);
    expect(html).not.toContain("https://removed.example.test/");
    expect(html).not.toContain("Copy");
    expect(html).not.toContain("Removed");
    expect(html).not.toContain("Link removed");
    expect(html).not.toContain("Latest link");
    expect(html).not.toContain("Report");
    expect(html).toContain("Get Your Link");
    expectNoExplanations(html);
  });

  it("promotes the first non-removed row and preserves remaining history order", () => {
    const removed = assignment("removed", true, {
      id: "removed-newest",
      name: "Removed newest hostname.test",
    });
    const previous = assignment("previous", true, {
      id: "previous-1",
      name: "Older usable link",
    });
    const older = assignment("previous", true, {
      id: "previous-2",
      name: "Oldest usable link",
    });
    const html = markup([removed, previous, assignment("removed"), older]);
    const [latestSection, historySection] = html.split(historyHeading);
    expect(latestSection).toContain(previous.name);
    expect(historySection).toContain(older.name);
    expect(cardCount(html)).toBe(2);
    expect(html).not.toContain(removed.name);
    expect(html).not.toContain(removed.url);
    expect(html).not.toContain("Removed");
    expect(visibleAssignments([removed, previous, older])).toEqual([
      previous,
      older,
    ]);
  });

  it("shows Get Your Link without an empty Latest link heading when all rows are removed", () => {
    const html = markup([
      assignment("removed", false),
      assignment("removed", true, { id: "removed-with-stale-url" }),
    ]);
    expect(html).toContain("Get Your Link");
    expect(html).toContain("Get Link");
    expect(html).not.toContain("Latest link");
    expect(html).not.toMatch(historyHeading);
    expect(html).not.toContain("Report");
    expect(html).not.toContain("removed.example.test");
    expect(cardCount(html)).toBe(0);
  });

  it("does not refund or auto-allocate when only removed rows remain and quota is exhausted", () => {
    const html = markup([assignment("removed")], {
      title: "Weekly Limit Reached",
      message: "You've used all of this week's link requests.",
      retry: false,
    });
    expect(html).toContain("Weekly Limit Reached");
    expect(html).not.toContain("Get Link");
    expect(html).not.toContain("Generate another link");
    expect(html).not.toContain("Report");
    expect(cardCount(html)).toBe(0);
  });

  it("fails closed on unavailable flags and empty URLs despite a ready status", () => {
    expect(describeAssignment(assignment("ready", false))).toMatchObject({
      available: false,
      label: "Unavailable",
    });
    const html = markup([assignment("previous", false)]);
    expect(html).toContain("Unavailable");
    expect(html).not.toContain("Copy");
    expect(html).not.toContain("href=");
    expectNoExplanations(html);
  });

  it("renders earlier history alongside the weekly-limit error without clearing actions", () => {
    const html = markup([assignment("ready"), assignment("previous")], {
      title: "Weekly Limit Reached",
      message: "You've used all of this week's link requests.",
      retry: false,
    });
    expect(html).toContain("Weekly Limit Reached");
    expect(html).toContain(
      "You&#x27;ve used all of this week&#x27;s link requests.",
    );
    expect(html).toContain("Latest link");
    expect(html).toMatch(historyHeading);
    expect(html).toContain("Link ready");
    expect(html).toContain("Link previous");
    expect(html.match(/href=/g)).toHaveLength(2);
    expect(html).toContain("Generate another link");
    expectNoExplanations(html);
  });

  it("renders unavailable history alongside allocation errors without losing rows", () => {
    const html = markup(
      [assignment("removed", false), assignment("unavailable", false)],
      { title: "No Links Available", message: "Try again later.", retry: true },
    );
    expect(html).toContain("No Links Available");
    expect(html).toContain("Try again later.");
    expect(html).toContain("Latest link");
    expect(html).not.toMatch(historyHeading);
    expect(html).not.toContain("Link removed");
    expect(html).toContain("Link unavailable");
    expect(html).not.toContain("href=");
    expectNoExplanations(html);
  });

  it("preserves copied feedback for actionable historical links", () => {
    const previous = assignment("previous");
    const html = markup([assignment(), previous], undefined, previous.id);
    const [latestSection, historySection] = html.split(historyHeading);
    expect(latestSection).not.toContain("Copied");
    expect(historySection).toContain("Copied");
    expect(historySection).toContain("Report");
    expect(html.match(/Copied/g)).toHaveLength(1);
  });

  it("supports older ready records without the added status fields", () => {
    const legacy = { ...assignment() } as AssignmentView & {
      status?: string;
      available?: boolean;
    };
    delete (legacy as Partial<AssignmentView>).status;
    delete (legacy as Partial<AssignmentView>).available;
    expect(describeAssignment(legacy)).toMatchObject({
      available: true,
      label: "Ready",
    });
    const html = markup([legacy]);
    expect(html).toContain("Latest link");
    expect(html).not.toContain("badge");
    expect(html).not.toContain("Ready");
    expectNoExplanations(html);
  });
});
