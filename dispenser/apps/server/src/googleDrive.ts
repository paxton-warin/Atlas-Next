import { Readable } from "node:stream";
import { google, type drive_v3 } from "googleapis";
import type { Pool } from "pg";
import { config } from "./config.js";
import { decrypt, encrypt } from "./security.js";

export interface VerificationFile {
  fileId: string;
  permissionId: string;
  url: string;
}
export interface DriveVerificationProvider {
  createVerificationFile(
    email: string,
    code: string,
    expiresInMinutes: number,
  ): Promise<VerificationFile>;
  removeVerificationFile(fileId: string): Promise<void>;
  testConnection(): Promise<string>;
}

export class GoogleDriveReconnectRequiredError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "The Google OAuth grant expired or was revoked. Reconnect the Google account, and move an External testing consent screen to In production so its refresh token does not expire after seven days.",
      options,
    );
    this.name = "GoogleDriveReconnectRequiredError";
  }
}

const isInvalidGrant = (error: unknown) => {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    message?: unknown;
    response?: { data?: { error?: unknown } };
  };
  return (
    candidate.response?.data?.error === "invalid_grant" ||
    (typeof candidate.message === "string" &&
      candidate.message.includes("invalid_grant"))
  );
};

export class GoogleDriveVerificationService implements DriveVerificationProvider {
  constructor(private readonly pool: Pool) {}
  private oauth() {
    if (!config.googleClientId || !config.googleClientSecret)
      throw new Error("Google OAuth credentials are not configured");
    return new google.auth.OAuth2(
      config.googleClientId,
      config.googleClientSecret,
      config.googleRedirectUri,
    );
  }
  authorizationUrl(state: string) {
    return this.oauth().generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: true,
      state,
      scope: [
        "https://www.googleapis.com/auth/drive.file",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
    });
  }
  async connect(code: string) {
    const oauth = this.oauth();
    const { tokens } = await oauth.getToken(code);
    oauth.setCredentials(tokens);
    const identity = await google
      .oauth2({ version: "v2", auth: oauth })
      .userinfo.get();
    if (!identity.data.email)
      throw new Error("Google did not provide an account email");
    await this.pool.query("DELETE FROM google_connections");
    await this.pool.query(
      "INSERT INTO google_connections (email, encrypted_tokens) VALUES ($1,$2)",
      [
        identity.data.email,
        encrypt(JSON.stringify(tokens), config.encryptionKey),
      ],
    );
    return identity.data.email;
  }
  async status() {
    const result = await this.pool.query<{ email: string; connected_at: Date }>(
      "SELECT email, connected_at FROM google_connections ORDER BY connected_at DESC LIMIT 1",
    );
    return result.rows[0] ?? null;
  }
  async disconnect() {
    await this.pool.query("DELETE FROM google_connections");
  }
  private async drive(): Promise<drive_v3.Drive> {
    const result = await this.pool.query<{ encrypted_tokens: string }>(
      "SELECT encrypted_tokens FROM google_connections ORDER BY connected_at DESC LIMIT 1",
    );
    if (!result.rows[0])
      throw new Error("Google Drive verification is not connected");
    const oauth = this.oauth();
    const current = JSON.parse(
      decrypt(result.rows[0].encrypted_tokens, config.encryptionKey),
    ) as Record<string, unknown>;
    oauth.setCredentials(current);
    try {
      // Refresh on the backend before each Drive operation. Persisting the
      // resulting credentials synchronously also preserves a rotated refresh
      // token before the API request starts.
      await oauth.getAccessToken();
    } catch (error) {
      if (isInvalidGrant(error))
        throw new GoogleDriveReconnectRequiredError({ cause: error });
      throw error;
    }
    await this.pool.query(
      "UPDATE google_connections SET encrypted_tokens=$1, updated_at=now()",
      [
        encrypt(
          JSON.stringify({ ...current, ...oauth.credentials }),
          config.encryptionKey,
        ),
      ],
    );
    return google.drive({ version: "v3", auth: oauth });
  }
  async createVerificationFile(
    email: string,
    code: string,
    expiresInMinutes: number,
  ) {
    const drive = await this.drive();
    const body = `Atlas Link Dispenser\n\nYour verification code is:\n\n${code}\n\nThis code expires in ${expiresInMinutes} minutes.\n`;
    const file = await drive.files.create({
      requestBody: {
        name: "Atlas Verification Code.txt",
        mimeType: "text/plain",
        appProperties: { atlasLinkDispenser: "verification" },
      },
      media: { mimeType: "text/plain", body: Readable.from(body) },
      fields: "id",
    });
    if (!file.data.id) throw new Error("Google Drive did not return a file ID");
    try {
      const permission = await drive.permissions.create({
        fileId: file.data.id,
        sendNotificationEmail: true,
        emailMessage:
          "Open this file to get your Atlas Link Dispenser verification code.",
        requestBody: { type: "user", role: "reader", emailAddress: email },
        fields: "id",
      });
      if (!permission.data.id)
        throw new Error("Google Drive did not return a permission ID");
      return {
        fileId: file.data.id,
        permissionId: permission.data.id,
        url: `https://drive.google.com/file/d/${encodeURIComponent(file.data.id)}/view`,
      };
    } catch (error) {
      await drive.files.delete({ fileId: file.data.id }).catch(() => undefined);
      throw error;
    }
  }
  async removeVerificationFile(fileId: string) {
    const drive = await this.drive();
    await drive.files.delete({ fileId });
  }
  async testConnection() {
    const drive = await this.drive();
    const file = await drive.files.create({
      requestBody: {
        name: "Atlas Connection Test.txt",
        mimeType: "text/plain",
        appProperties: { atlasLinkDispenser: "connection-test" },
      },
      media: {
        mimeType: "text/plain",
        body: Readable.from("Atlas Link Dispenser connection test."),
      },
      fields: "id",
    });
    if (!file.data.id) throw new Error("Test file creation failed");
    await drive.files.delete({ fileId: file.data.id });
    return "Google Drive connection is working.";
  }
}
