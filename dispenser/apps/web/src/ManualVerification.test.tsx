import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ManualVerificationRequest,
  ManualVerificationState,
  PublicUser,
} from "@atlas-link-dispenser/shared";
import {
  ManualVerification,
  ManualVerificationForm,
  requiresManualVerification,
  VerificationHeading,
  verificationDraft,
} from "./ManualVerification";
import {
  KnownEmailAdmin,
  ManualVerificationAdmin,
  SchoolDirectoryList,
  VerificationDomainList,
  VerificationRequestDetails,
  VerificationRequestList,
  VerificationReview,
  readDirectoryFile,
  verificationReviewBody,
} from "./ManualVerificationAdmin";

const user: PublicUser = {
  id: "fixture-user",
  email: "student@school.example",
  role: "user",
  status: "active",
};
const request: ManualVerificationRequest = {
  id: "fixture-request",
  userId: user.id,
  email: user.email,
  domain: "school.example",
  name: "Fixture Student",
  schoolName: "Fixture School",
  additionalInformation: "Please verify this test account.\nSecond line.",
  status: "pending",
  revision: 3,
  submittedAt: "2026-10-16T15:00:00Z",
  updatedAt: "2026-10-16T15:05:00Z",
  reviewedAt: null,
  reviewNote: "",
};
const state: ManualVerificationState = {
  required: true,
  status: "pending",
  domain: "school.example",
  request,
};
const noop = () => {};

describe("manual verification access screen", () => {
  it("routes required/pending/denied users away from links but exempts administrators", () => {
    for (const status of ["required", "pending", "denied"] as const)
      expect(requiresManualVerification(user, { ...state, status })).toBe(true);
    expect(
      requiresManualVerification(user, {
        ...state,
        required: false,
        status: "approved",
      }),
    ).toBe(false);
    expect(requiresManualVerification({ ...user, role: "admin" }, state)).toBe(
      false,
    );
    expect(requiresManualVerification(user, undefined)).toBe(false);
  });
  it("starts a single new request with revision zero", () => {
    expect(verificationDraft(null)).toEqual({
      name: "",
      schoolName: "",
      additionalInformation: "",
      revision: 0,
    });
    const html = renderToStaticMarkup(
      <ManualVerificationForm
        draft={verificationDraft(null)}
        submitted={false}
        busy={false}
        onChange={noop}
        onSubmit={noop}
      />,
    );
    expect(html).toContain("Submit request");
    for (const label of ["Name", "School name", "Additional information"])
      expect(html).toContain(label);
    expect(html.match(/required=""/g)).toHaveLength(3);
    expect(html).toContain('maxLength="160"');
    expect(html).toContain('maxLength="200"');
    expect(html).toContain('maxLength="5000"');
  });
  it("restores the same editable saved request after login without a duplicate-creation control", () => {
    const draft = verificationDraft(request);
    expect(draft.revision).toBe(3);
    const html = renderToStaticMarkup(
      <ManualVerification
        user={user}
        initial={state}
        onApproved={noop}
        onLogout={noop}
      />,
    );
    for (const text of [
      "Pending review",
      "Fixture Student",
      "Fixture School",
      "Please verify this test account.",
      "Save changes",
      "Sign out",
      "Check status",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("Submit request");
    expect(html).not.toContain("Get Link");
    expect(html).not.toContain("Latest link");
    expect(html).not.toContain("Generate another link");
  });
  it("keeps a denied request editable and displays the decision note without implying resubmission grants access", () => {
    const html = renderToStaticMarkup(
      <ManualVerification
        user={user}
        initial={{
          ...state,
          status: "denied",
          request: {
            ...request,
            status: "denied",
            reviewNote: "Please clarify your school.",
          },
        }}
        onApproved={noop}
        onLogout={noop}
      />,
    );
    expect(html).toContain("Denied");
    expect(html).toContain("Please clarify your school.");
    expect(html).toContain("Save changes");
    expect(html).not.toContain("Submit request");
  });
  it("renders the initial required state without a fictitious pending badge", () => {
    const html = renderToStaticMarkup(
      <VerificationHeading
        state={{ ...state, status: "required", request: null }}
      />,
    );
    expect(html).toContain("before you can access links");
    expect(html).not.toContain("Pending review");
  });
  it("escapes submitted names, notes and text instead of creating HTML", () => {
    const html = renderToStaticMarkup(
      <VerificationRequestDetails
        request={{
          ...request,
          name: '<img src=x onerror="bad()">',
          additionalInformation: "<script>bad()</script>",
        }}
      />,
    );
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain('class="preserve-text"');
  });
});

describe("manual verification administration", () => {
  it("clearly separates known-email directories from email rules and Check-Mail", () => {
    const html = renderToStaticMarkup(<KnownEmailAdmin />);
    expect(html).toContain("Known emails");
    expect(html).toContain("After email rules pass");
    expect(html).toContain("do not bypass email rules or Check-Mail");
    expect(html).toContain("Add domain");
    expect(html).not.toContain("fcpsschools.net");
  });
  it("supports multiple domains, counts, status changes and removal without exposing directory entries", () => {
    const html = renderToStaticMarkup(
      <VerificationDomainList
        domains={[
          {
            id: "domain-a",
            domain: "school.example",
            enabled: true,
            schoolCount: 2,
            knownEmailCount: 90,
          },
          {
            id: "domain-b",
            domain: "another.example",
            enabled: false,
            schoolCount: 1,
            knownEmailCount: 10,
          },
        ]}
        selected="domain-a"
        busy=""
        onSelect={noop}
        onToggle={noop}
        onRemove={noop}
      />,
    );
    expect(html).toContain("school.example");
    expect(html).toContain("another.example");
    expect(html).toContain('aria-pressed="true"');
    for (const text of [
      "Known emails",
      "Schools",
      "90",
      "Disable",
      "Enable",
      "Remove",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain(user.email);
  });
  it("groups school directories by their selected domain with edit/upload/remove and private aggregate counts", () => {
    const html = renderToStaticMarkup(
      <SchoolDirectoryList
        schools={[
          {
            id: "school-a",
            domainId: "domain-a",
            name: "Fixture School",
            enabled: true,
            emailCount: 18,
            createdAt: request.submittedAt,
            updatedAt: request.updatedAt,
          },
        ]}
        onEdit={noop}
        onUpload={noop}
        onRemove={noop}
      />,
    );
    for (const text of [
      "Fixture School",
      "18",
      "Edit",
      "Upload",
      "Remove",
      "Enabled",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain(user.email);
  });
  it("provides a separate request queue and filters without showing website links", () => {
    const html = renderToStaticMarkup(<ManualVerificationAdmin />);
    expect(html).toContain("Manual verification");
    for (const text of [
      "Pending",
      "Denied",
      "Approved",
      "All requests",
      "Search verification requests",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("Get Link");
    expect(html).not.toContain("Check-Mail");
  });
  it("shows the same request identity once in the queue", () => {
    const html = renderToStaticMarkup(
      <VerificationRequestList requests={[request]} onReview={noop} />,
    );
    expect(html.split(user.email)).toHaveLength(2);
    expect(html).toContain("Fixture School");
    expect(html).toContain("Review");
  });
  it("includes the reviewed revision in both decisions to reject stale approvals", () => {
    expect(verificationReviewBody(request, "approved", "Accepted")).toEqual({
      decision: "approved",
      revision: 3,
      reviewNote: "Accepted",
    });
    expect(verificationReviewBody(request, "denied", "Clarify")).toEqual({
      decision: "denied",
      revision: 3,
      reviewNote: "Clarify",
    });
    const html = renderToStaticMarkup(
      <VerificationReview request={request} onClose={noop} onSaved={noop} />,
    );
    for (const text of [
      "Approve",
      "Deny",
      "Additional information",
      "Review note",
      "Shown to the account holder.",
    ])
      expect(html).toContain(text);
    expect(html).toContain('maxLength="1000"');
  });
  it("accepts plain-text directory files and rejects blank/oversized files before upload", async () => {
    expect(
      await readDirectoryFile(
        new File(["fixture@school.example\n"], "directory.txt"),
      ),
    ).toBe("fixture@school.example\n");
    await expect(
      readDirectoryFile(new File(["  \n"], "empty.txt")),
    ).rejects.toThrow("empty");
    await expect(
      readDirectoryFile(new File([new Uint8Array(1_900_001)], "large.txt")),
    ).rejects.toThrow("1.9 MB");
  });
});
