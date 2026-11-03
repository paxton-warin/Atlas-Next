export type Role = "user" | "admin";
export type UserStatus = "active" | "suspended";
export type LinkHealth =
  "healthy" | "degraded" | "unavailable" | "unknown" | "disabled";
export type AllocationStrategy =
  "balanced_random" | "random" | "weighted_random" | "sequential";
export type ReportCategory =
  "does_not_load" | "error_page" | "very_slow" | "wrong_page" | "other";
export type AppErrorCode =
  | "INVALID_CLIENT_ADDRESS"
  | "EMAIL_NOT_ALLOWED"
  | "MANUAL_VERIFICATION_REQUIRED"
  | "MANUAL_VERIFICATION_CONFLICT"
  | "CHECK_MAIL_REJECTED"
  | "CHECK_MAIL_UNAVAILABLE"
  | "CHECK_MAIL_LIMIT"
  | "VERIFICATION_EXPIRED"
  | "VERIFICATION_INVALID"
  | "VERIFICATION_RATE_LIMITED"
  | "GOOGLE_DRIVE_UNAVAILABLE"
  | "USER_SUSPENDED"
  | "QUOTA_EXCEEDED"
  | "NO_LINK_AVAILABLE"
  | "LINK_UNAVAILABLE"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "VALIDATION_ERROR"
  | "DOCUMENT_ANNOUNCEMENT_CHANGED"
  | import("./hub.js").HubErrorCode;

export interface PublicUser {
  id: string;
  email: string;
  role: Role;
  status: UserStatus;
}
export interface AssignmentView {
  id: string;
  url: string;
  name: string;
  assignedAt: string;
  expiresAt: string | null;
  status: "ready" | "previous" | "removed" | "unavailable";
  available: boolean;
}
export interface LinkInput {
  name: string;
  url: string;
  enabled: boolean;
  capacity: number | null;
  weight: number;
  expiresAt?: string | null;
  notes?: string;
  healthMonitoring: boolean;
}
export interface EmailRuleInput {
  kind: "exact" | "domain" | "regex";
  action: "allow" | "deny";
  pattern: string;
  priority: number;
  enabled: boolean;
  note?: string;
  denialMessage?: string;
}
export const isEmail = (value: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
export const normalizeEmail = (value: string) => value.trim().toLowerCase();

export type ManualVerificationStatus =
  "required" | "pending" | "approved" | "denied" | "not_required";
export interface ManualVerificationRequest {
  id: string;
  userId: string;
  email?: string;
  domain: string;
  name: string;
  schoolName: string;
  additionalInformation: string;
  status: "pending" | "approved" | "denied";
  revision: number;
  submittedAt: string;
  updatedAt: string;
  reviewedAt: string | null;
  reviewNote: string;
}
export interface ManualVerificationState {
  required: boolean;
  status: ManualVerificationStatus;
  domain: string | null;
  request: ManualVerificationRequest | null;
}
export interface ManualVerificationDomain {
  id: string;
  domain: string;
  enabled: boolean;
  schoolCount: number;
  knownEmailCount: number;
}
export interface ManualVerificationSchool {
  id: string;
  domainId: string;
  name: string;
  enabled: boolean;
  emailCount: number;
  createdAt: string;
  updatedAt: string;
}

export * from "./hub.js";

export * from "./backups-v2.js";
