import {
  normalizeEmail,
  type EmailRuleInput,
} from "@atlas-link-dispenser/shared";
import safeRegex from "safe-regex2";
import { AppError } from "./errors.js";
export type EmailRule = EmailRuleInput & {
  id: string;
  note: string;
  denialMessage: string;
};
export function validateRegex(pattern: string) {
  if (!pattern || pattern.length > 180)
    throw new AppError(
      "VALIDATION_ERROR",
      "Regex patterns must be between 1 and 180 characters.",
    );
  try {
    new RegExp(pattern, "i");
  } catch {
    throw new AppError("VALIDATION_ERROR", "The regex pattern is invalid.");
  }
  if (
    /\\[1-9]|\(\?<[=!]|\([^)]*[+*][^)]*\)[+*{]/.test(pattern) ||
    !safeRegex(pattern, { limit: 25 })
  )
    throw new AppError(
      "VALIDATION_ERROR",
      "This regex uses constructs that are unsafe for registration checks.",
    );
}
export function evaluateEmailPolicy(
  email: string,
  rules: EmailRule[],
  defaultMode: "allow" | "deny",
) {
  const normalized = normalizeEmail(email);
  const domain = normalized.slice(normalized.lastIndexOf("@"));
  for (const rule of [...rules]
    .filter((item) => item.enabled)
    .sort((a, b) => b.priority - a.priority)) {
    let matched = false;
    if (rule.kind === "exact")
      matched = normalizeEmail(rule.pattern) === normalized;
    else if (rule.kind === "domain")
      matched = `@${rule.pattern.replace(/^@/, "").toLowerCase()}` === domain;
    else {
      validateRegex(rule.pattern);
      matched = new RegExp(rule.pattern, "i").test(normalized);
    }
    if (matched) return { allowed: rule.action === "allow", rule };
  }
  return { allowed: defaultMode === "allow", rule: null };
}
