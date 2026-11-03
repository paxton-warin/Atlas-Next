import type { PoolClient } from "pg";
import { AppError } from "./errors.js";

export const SUPPORT_MEDIA_MAX_FILES = 3;
export const SUPPORT_MEDIA_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const SUPPORT_MEDIA_MAX_MESSAGE_BYTES = 20 * 1024 * 1024;
export const SUPPORT_MEDIA_MAX_UPLOADER_BYTES = 100 * 1024 * 1024;
// Base64 expands binary by one third. This includes bounded JSON names/body.
export const SUPPORT_MEDIA_BODY_LIMIT = 29 * 1024 * 1024;
export type SupportMediaInput = {
  name: string;
  mimeType: string;
  data: Buffer;
};
export type SupportMediaMetadata = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
};
const aliases: Record<string, string> = {
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/x-m4a": "audio/mp4",
};
function invalid(message: string, status = 400): never {
  throw new AppError("VALIDATION_ERROR", message, status);
}
function ascii(data: Buffer, start: number, length: number) {
  return data.toString("ascii", start, start + length);
}
function signature(data: Buffer, mime: string) {
  const hex = (value: string) =>
    data.subarray(0, value.length / 2).equals(Buffer.from(value, "hex"));
  const ftyp = data.length >= 16 && ascii(data, 4, 4) === "ftyp";
  switch (mime) {
    case "image/png":
      return hex("89504e470d0a1a0a");
    case "image/jpeg":
      return hex("ffd8ff");
    case "image/gif":
      return ["GIF87a", "GIF89a"].includes(ascii(data, 0, 6));
    case "image/webp":
      return ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 4) === "WEBP";
    case "image/avif":
      return (
        ftyp && /avif|avis/.test(ascii(data, 8, Math.min(data.length - 8, 120)))
      );
    case "video/mp4":
      return (
        ftyp &&
        /isom|iso[2-9]|mp4[12]|avc1|M4V /.test(
          ascii(data, 8, Math.min(data.length - 8, 120)),
        )
      );
    case "audio/mp4":
      return (
        ftyp &&
        /M4[AB] |isom|mp4[12]/.test(
          ascii(data, 8, Math.min(data.length - 8, 120)),
        )
      );
    case "video/webm":
    case "audio/webm":
      return (
        hex("1a45dfa3") && data.subarray(0, 4096).includes(Buffer.from("webm"))
      );
    case "audio/mpeg":
      return (
        ascii(data, 0, 3) === "ID3" ||
        (data.length >= 2 &&
          data[0] === 0xff &&
          (data[1] & 0xe0) === 0xe0 &&
          data[1] !== 0xff)
      );
    case "audio/wav":
      return ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 4) === "WAVE";
    case "audio/ogg":
      return ascii(data, 0, 4) === "OggS";
    default:
      return false;
  }
}
export function parseSupportMedia(value: unknown): SupportMediaInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > SUPPORT_MEDIA_MAX_FILES)
    invalid("Attach up to 3 media files per message.");
  let total = 0;
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      invalid("Invalid media attachment.");
    const { name, mimeType, dataBase64 } = item;
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 180 ||
      /[\x00-\x1f\x7f]/.test(name)
    )
      invalid("Use a media file name of 1 to 180 characters.");
    if (
      typeof mimeType !== "string" ||
      typeof dataBase64 !== "string" ||
      !dataBase64.length
    )
      invalid("Invalid media attachment.");
    if (dataBase64.length > 4 * Math.ceil(SUPPORT_MEDIA_MAX_FILE_BYTES / 3))
      invalid("Each attachment must be 10 MiB or smaller.", 413);
    if (dataBase64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(dataBase64))
      invalid("The attachment could not be decoded. Choose the file again.");
    const data = Buffer.from(dataBase64, "base64");
    if (!data.length || data.toString("base64") !== dataBase64)
      invalid("The attachment could not be decoded. Choose the file again.");
    if (data.length > SUPPORT_MEDIA_MAX_FILE_BYTES)
      invalid("Each attachment must be 10 MiB or smaller.", 413);
    total += data.length;
    if (total > SUPPORT_MEDIA_MAX_MESSAGE_BYTES)
      invalid("Attachments must total 20 MiB or less per message.", 413);
    const requested = mimeType.trim().toLowerCase();
    const mime = aliases[requested] || requested;
    if (!signature(data, mime))
      invalid(
        "Use PNG, JPEG, GIF, WebP, AVIF, MP4, WebM, MP3, WAV, OGG or M4A media files.",
      );
    return {
      name: name.split(/[\\/]/).at(-1)!.trim() || "attachment",
      mimeType: mime,
      data,
    };
  });
}

/** Called inside the message transaction; retries never leave unattached uploads. */
export async function saveSupportMedia(
  c: PoolClient,
  messageId: string,
  uploaderId: string,
  files: SupportMediaInput[],
): Promise<SupportMediaMetadata[]> {
  if (!files.length) return [];
  // Serialize uploads by actor, including uploads to different tickets/branches.
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "support-media:" + uploaderId,
  ]);
  const usage = await c.query(
    "SELECT COALESCE(sum(byte_size),0)::text bytes FROM hub_ticket_attachments WHERE uploader_id=$1",
    [uploaderId],
  );
  if (
    Number(usage.rows[0].bytes) +
      files.reduce((sum, file) => sum + file.data.length, 0) >
    SUPPORT_MEDIA_MAX_UPLOADER_BYTES
  )
    invalid(
      "Your support media allowance is full (100 MiB). Contact Atlas support for help.",
      413,
    );
  const result: SupportMediaMetadata[] = [];
  for (const file of files) {
    const saved = await c.query(
      'INSERT INTO hub_ticket_attachments(message_id,uploader_id,name,mime_type,byte_size,data) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,mime_type AS "mimeType",byte_size AS size',
      [
        messageId,
        uploaderId,
        file.name,
        file.mimeType,
        file.data.length,
        file.data,
      ],
    );
    result.push(saved.rows[0]);
  }
  return result;
}

/** Metadata only: never copy media payloads into ticket polling responses. */
export const SUPPORT_MEDIA_METADATA_SQL = `COALESCE((SELECT json_agg(json_build_object('id',a.id,'name',a.name,'mimeType',a.mime_type,'size',a.byte_size) ORDER BY a.created_at,a.id) FROM hub_ticket_attachments a WHERE a.message_id=m.id),'[]'::json) AS attachments`;
