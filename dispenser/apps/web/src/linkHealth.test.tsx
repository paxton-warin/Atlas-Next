import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  describeLinkCheck,
  describeLinkCheckError,
  LinkCheckNotices,
  type LinkCheckResult,
} from "./linkHealth";

const successful: LinkCheckResult = {
  healthy: true,
  statusCode: 200,
  duration: 42,
  error: null,
  healthStatus: "healthy",
};

describe("manual link check feedback", () => {
  it("shows the HTTP response, duration, and persisted health", () => {
    expect(describeLinkCheck(successful)).toEqual({
      tone: "success",
      message: "Check passed: HTTP 200 · 42 ms. Health: healthy.",
    });
  });

  it("explains why a successful first check is degraded", () => {
    const result = describeLinkCheck({
      ...successful,
      healthStatus: "degraded",
    });
    expect(result.tone).toBe("warning");
    expect(result.message).toContain("Check passed: HTTP 200 · 42 ms.");
    expect(result.message).toContain("Health: degraded.");
    expect(result.message).toContain("consecutive-success threshold");
  });

  it("supports a server response without the added healthStatus field", () => {
    const { healthStatus: _, ...legacy } = successful;
    expect(describeLinkCheck(legacy)).toEqual({
      tone: "success",
      message: "Check passed: HTTP 200 · 42 ms.",
    });
  });

  it("shows rejected HTTP responses without claiming the request crashed", () => {
    const result = describeLinkCheck({
      ...successful,
      healthy: false,
      statusCode: 503,
      healthStatus: "unavailable",
    });
    expect(result.tone).toBe("danger");
    expect(result.message).toContain("Check failed: HTTP 503 · 42 ms.");
    expect(result.message).toContain("Health: unavailable.");
    expect(result.message).toContain("configured expected HTTP statuses");
  });

  it("shows timeout or destination errors when no HTTP response arrived", () => {
    const result = describeLinkCheck({
      healthy: false,
      statusCode: null,
      duration: 10000,
      error: "The operation timed out",
      healthStatus: "degraded",
    });
    expect(result.tone).toBe("danger");
    expect(result.message).toContain("No HTTP response · 10000 ms.");
    expect(result.message).toContain("The operation timed out");
  });

  it("provides visible request errors and a fallback for unknown failures", () => {
    expect(describeLinkCheckError(new Error("Internal server error."))).toEqual(
      {
        tone: "danger",
        message: "Check request failed: Internal server error.",
      },
    );
    expect(describeLinkCheckError(null).message).toBe(
      "Check request failed: Please try again.",
    );
  });

  it("announces feedback and keeps each result associated with its link", () => {
    const html = renderToStaticMarkup(
      <LinkCheckNotices
        results={{
          first: {
            name: "Destination A",
            feedback: describeLinkCheck(successful),
          },
          second: {
            name: "Destination B",
            feedback: describeLinkCheckError(new Error("Request failed.")),
          },
        }}
      />,
    );
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="status"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Destination A:");
    expect(html).toContain("Check passed: HTTP 200");
    expect(html).toContain("Destination B:");
    expect(html).toContain("Check request failed: Request failed.");
  });
});
