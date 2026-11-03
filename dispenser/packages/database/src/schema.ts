import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
};
export const role = pgEnum("role", ["user", "admin"]);
export const userStatus = pgEnum("user_status", ["active", "suspended"]);
export const healthStatus = pgEnum("health_status", [
  "healthy",
  "degraded",
  "unavailable",
  "unknown",
  "disabled",
]);
export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: varchar("email", { length: 320 }).notNull(),
    normalizedEmail: varchar("normalized_email", { length: 320 }).notNull(),
    role: role("role").notNull().default("user"),
    status: userStatus("status").notNull().default("active"),
    adminNotes: text("admin_notes").notNull().default(""),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    suspensionReason: text("suspension_reason"),
    quotaOverride: jsonb("quota_override").$type<Record<
      string,
      number | null
    > | null>(),
    quotaResetAt: timestamp("quota_reset_at", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("users_normalized_email_uq").on(t.normalizedEmail)],
);
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    tokenHash: varchar("token_hash", { length: 128 }).notNull(),
    csrfHash: varchar("csrf_hash", { length: 128 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ip: varchar("ip", { length: 64 }),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("sessions_token_hash_uq").on(t.tokenHash)],
);
export const verifications = pgTable("verifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 320 }).notNull(),
  codeHash: varchar("code_hash", { length: 128 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  status: varchar("status", { length: 32 }).notNull().default("pending"),
  driveFileId: text("google_drive_file_id"),
  drivePermissionId: text("google_drive_permission_id"),
  requestIp: varchar("request_ip", { length: 64 }),
  cleanupStatus: varchar("cleanup_status", { length: 32 })
    .notNull()
    .default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const emailRules = pgTable("email_rules", {
  id: uuid("id").defaultRandom().primaryKey(),
  kind: varchar("kind", { length: 16 }).notNull(),
  action: varchar("action", { length: 8 }).notNull(),
  pattern: text("pattern").notNull(),
  priority: integer("priority").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  note: text("note").notNull().default(""),
  denialMessage: text("denial_message").notNull().default(""),
  ...timestamps,
});
export const deniedEmailLogins = pgTable("denied_email_logins", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 320 }).notNull(),
  matchedRuleId: uuid("matched_rule_id").references(() => emailRules.id, {
    onDelete: "set null",
  }),
  matchedRulePattern: text("matched_rule_pattern"),
  decisionSource: varchar("decision_source", { length: 32 }).notNull(),
  requestIp: varchar("request_ip", { length: 64 }),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const links = pgTable("links", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 160 }).notNull(),
  url: text("url").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  capacity: integer("capacity"),
  weight: integer("weight").notNull().default(1),
  healthStatus: healthStatus("health_status").notNull().default("unknown"),
  healthMonitoring: boolean("health_monitoring").notNull().default(true),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  consecutiveSuccesses: integer("consecutive_successes").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  notes: text("notes").notNull().default(""),
  ...timestamps,
});
export const assignments = pgTable("link_assignments", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  linkId: uuid("link_id")
    .references(() => links.id, { onDelete: "restrict" })
    .notNull(),
  active: boolean("active").notNull().default(true),
  assignedAt: timestamp("assigned_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  replacedAt: timestamp("replaced_at", { withTimezone: true }),
});
export const reports = pgTable("reports", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  assignmentId: uuid("assignment_id")
    .references(() => assignments.id, { onDelete: "cascade" })
    .notNull(),
  linkId: uuid("link_id")
    .references(() => links.id, { onDelete: "restrict" })
    .notNull(),
  category: varchar("category", { length: 32 }).notNull(),
  detail: text("detail").notNull().default(""),
  status: varchar("status", { length: 16 }).notNull().default("open"),
  adminNote: text("admin_note").notNull().default(""),
  ...timestamps,
});
export const appSettings = pgTable("app_settings", {
  key: varchar("key", { length: 100 }).primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: uuid("updated_by").references(() => users.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const auditEvents = pgTable("audit_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  adminId: uuid("admin_id").references(() => users.id, {
    onDelete: "set null",
  }),
  action: varchar("action", { length: 100 }).notNull(),
  targetType: varchar("target_type", { length: 60 }).notNull(),
  targetId: varchar("target_id", { length: 128 }),
  before: jsonb("before"),
  after: jsonb("after"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const googleConnections = pgTable("google_connections", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 320 }).notNull(),
  encryptedTokens: text("encrypted_tokens").notNull(),
  connectedAt: timestamp("connected_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const healthChecks = pgTable("health_checks", {
  id: uuid("id").defaultRandom().primaryKey(),
  linkId: uuid("link_id")
    .references(() => links.id, { onDelete: "cascade" })
    .notNull(),
  healthy: boolean("healthy").notNull(),
  statusCode: integer("status_code"),
  durationMs: integer("duration_ms"),
  error: text("error"),
  checkedAt: timestamp("checked_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// This secret is intentionally outside app_settings and generic settings APIs.
export const checkMailSettings = pgTable("check_mail_settings", {
  id: boolean("id").primaryKey().default(true),
  enabled: boolean("enabled").notNull().default(false),
  encryptedApiKey: text("encrypted_api_key"),
  monthlyLimit: integer("monthly_limit").notNull().default(1000),
  providerRemaining: integer("provider_remaining"),
  providerObservedAt: timestamp("provider_observed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const checkMailAllowlist = pgTable("check_mail_allowlist", {
  id: uuid("id").defaultRandom().primaryKey(),
  kind: varchar("kind", { length: 16 }).notNull(),
  pattern: text("pattern").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  note: text("note").notNull().default(""),
  ...timestamps,
});
export const checkMailAttempts = pgTable("check_mail_attempts", {
  id: uuid("id").primaryKey(),
  emailHash: varchar("email_hash", { length: 64 }).notNull(),
  outcome: varchar("outcome", { length: 16 }).notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});
export const checkMailCache = pgTable("check_mail_cache", {
  emailHash: varchar("email_hash", { length: 64 }).primaryKey(),
  attemptId: uuid("attempt_id")
    .notNull()
    .references(() => checkMailAttempts.id),
  outcome: varchar("outcome", { length: 16 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const manualVerificationDomains = pgTable(
  "manual_verification_domains",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    domain: varchar("domain", { length: 253 }).notNull().unique(),
    enabled: boolean("enabled").notNull().default(false),
    ...timestamps,
  },
);
export const manualVerificationSchools = pgTable(
  "manual_verification_schools",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    domainId: uuid("domain_id")
      .notNull()
      .references(() => manualVerificationDomains.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 200 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("manual_verification_schools_domain_name_uq").on(
      t.domainId,
      t.name,
    ),
  ],
);
export const manualVerificationKnownEmails = pgTable(
  "manual_verification_known_emails",
  {
    schoolId: uuid("school_id")
      .notNull()
      .references(() => manualVerificationSchools.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 320 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.schoolId, t.email] })],
);
export const manualVerificationRequests = pgTable(
  "manual_verification_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    domain: varchar("domain", { length: 253 }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    schoolName: varchar("school_name", { length: 200 }).notNull(),
    additionalInformation: text("additional_information").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    revision: integer("revision").notNull().default(1),
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: uuid("reviewed_by").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewNote: varchar("review_note", { length: 1000 }).notNull().default(""),
  },
);
