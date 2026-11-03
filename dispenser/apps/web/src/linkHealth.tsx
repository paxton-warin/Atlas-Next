import { Notice } from "./ui";

export interface LinkCheckResult {
  healthy: boolean;
  statusCode: number | null;
  duration: number;
  error: string | null;
  healthStatus?: string;
}

export interface LinkCheckFeedback {
  tone: "success" | "warning" | "danger";
  message: string;
}

export function describeLinkCheck(result: LinkCheckResult): LinkCheckFeedback {
  const response =
    result.statusCode === null
      ? "No HTTP response"
      : `HTTP ${result.statusCode}`;
  const status = result.healthStatus ? ` Health: ${result.healthStatus}.` : "";
  const details = `${response} · ${result.duration} ms.${status}`;
  if (!result.healthy) {
    return {
      tone: "danger",
      message: `Check failed: ${details} ${result.error || "The response did not match the configured expected HTTP statuses."}`,
    };
  }
  const pending = result.healthStatus === "degraded";
  return {
    tone: pending ? "warning" : "success",
    message: `Check passed: ${details}${pending ? " A successful check can remain degraded until the configured consecutive-success threshold is reached." : ""}`,
  };
}

export function describeLinkCheckError(error: unknown): LinkCheckFeedback {
  return {
    tone: "danger",
    message: `Check request failed: ${error instanceof Error ? error.message : "Please try again."}`,
  };
}

export function LinkCheckNotices({
  results,
}: {
  results: Record<string, { name: string; feedback: LinkCheckFeedback }>;
}) {
  return (
    <div aria-live="polite" aria-atomic="false">
      {Object.entries(results).map(([id, { name, feedback }]) => (
        <Notice key={id} tone={feedback.tone}>
          <strong>{name}:</strong> {feedback.message}
        </Notice>
      ))}
    </div>
  );
}
