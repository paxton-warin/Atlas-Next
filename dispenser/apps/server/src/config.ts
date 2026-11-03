const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const url = (name: string) =>
  new URL(required(name)).toString().replace(/\/$/, "");
export const config = {
  production: process.env.NODE_ENV === "production",
  port: Number(process.env.PORT ?? 3000),
  appUrl: url("APP_URL"),
  databaseUrl: required("DATABASE_URL"),
  redisUrl: required("REDIS_URL"),
  sessionSecret: required("SESSION_SECRET"),
  encryptionKey: required("DATA_ENCRYPTION_KEY"),
  hubEnabled: process.env.ATLAS_HUB_ENABLED === "true",
  backupPublishDisabled: process.env.ATLAS_BACKUP_V2_PUBLISH_DISABLED === "true",
  backupMaintenanceExternal: process.env.ATLAS_BACKUP_MAINTENANCE_EXTERNAL === "true",
  hubServiceSecret: process.env.ATLAS_HUB_SERVICE_SECRET?.trim() ?? "",
  hubCoordinatorOrigin: process.env.ATLAS_COORDINATOR_ORIGIN?.trim() ?? "",
  hubCoordinatorOriginKey: process.env.ATLAS_COORDINATOR_ORIGIN_KEY?.trim() ?? "",
  bootstrapEmail: required("BOOTSTRAP_ADMIN_EMAIL").toLowerCase(),
  bootstrapToken: required("BOOTSTRAP_TOKEN"),
  // Only immediate reverse-proxy peers belong here. The edge must reduce the
  // upstream forwarding chain to one verified viewer address first.
  trustedProxyCidrs: (process.env.TRUSTED_PROXY_CIDRS ?? "loopback")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  googleClientId: process.env.GOOGLE_CLIENT_ID?.trim() ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "",
  googleRedirectUri:
    process.env.GOOGLE_REDIRECT_URI?.trim() ||
    `${url("APP_URL")}/api/admin/google/callback`,
};
if (config.hubServiceSecret && config.hubServiceSecret.length < 32)
  throw new Error("ATLAS_HUB_SERVICE_SECRET must be at least 32 characters");
if (config.sessionSecret.length < 32 || config.bootstrapToken.length < 24)
  throw new Error(
    "SESSION_SECRET and BOOTSTRAP_TOKEN must be strong random values",
  );
if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
  throw new Error("PORT is invalid");
