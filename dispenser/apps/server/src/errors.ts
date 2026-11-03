import type {
  AppErrorCode,
  BackupV2ErrorCode,
} from "@atlas-link-dispenser/shared";
type ServerErrorCode =
  | AppErrorCode
  | BackupV2ErrorCode
  | "HUB_REQUEST_ABORTED"
  | "HUB_DATABASE_BUSY"
  | "HUB_TRANSACTION_TIMEOUT";
export class AppError extends Error {
  constructor(
    readonly code: ServerErrorCode,
    message: string,
    readonly status = 400,
    readonly details?: {
      checkpointId: string;
      manifestDigest: string;
      rejectedNamespaceVersionIds: string[];
    },
  ) {
    super(message);
  }
}
export const unauthorized = () =>
  new AppError("UNAUTHORIZED", "Sign in to continue.", 401);
export const forbidden = () =>
  new AppError("FORBIDDEN", "You do not have permission to do that.", 403);
