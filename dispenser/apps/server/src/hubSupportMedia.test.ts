import { describe, expect, it } from "vitest";
import {
  parseSupportMedia,
  saveSupportMedia,
  SUPPORT_MEDIA_BODY_LIMIT,
  SUPPORT_MEDIA_MAX_UPLOADER_BYTES,
} from "./hubSupportMedia.js";
import type { PoolClient } from "pg";
const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
const file = (mimeType = "image/png", data: Buffer = png, name = "screenshot.png") => ({
  name,
  mimeType,
  dataBase64: data.toString("base64"),
});
describe("Support media validation and bounded transaction writes", () => {
  it("keeps no-attachment messages compatible and normalizes path-like names", () => {
    expect(parseSupportMedia(undefined)).toEqual([]);
    expect(parseSupportMedia([])).toEqual([]);
    expect(
      parseSupportMedia([file("image/png", png, "C:\\private\\screen.png")])[0]
        .name,
    ).toBe("screen.png");
    expect(SUPPORT_MEDIA_BODY_LIMIT).toBe(29 * 1024 * 1024);
  });
  it("accepts supported raster, video and audio signatures", () => {
    const formats: [string, Buffer][] = [
      ["image/png", png],
      ["image/jpeg", Buffer.from("ffd8ffe0", "hex")],
      ["image/gif", Buffer.from("GIF89a")],
      ["image/webp", Buffer.from("RIFF0000WEBP")],
      ["image/avif", Buffer.from("0000ftypavif0000")],
      ["video/mp4", Buffer.from("0000ftypisom0000")],
      ["audio/mp4", Buffer.from("0000ftypM4A 0000")],
      [
        "video/webm",
        Buffer.concat([Buffer.from("1a45dfa3", "hex"), Buffer.from("webm")]),
      ],
      ["audio/mpeg", Buffer.from("ID3")],
      ["audio/ogg", Buffer.from("OggS")],
      ["audio/x-wav", Buffer.from("RIFF0000WAVE")],
    ];
    for (const [mime, data] of formats)
      expect(parseSupportMedia([file(mime, data)])[0].data).toEqual(data);
    expect(
      parseSupportMedia([file("audio/x-wav", Buffer.from("RIFF0000WAVE"))])[0]
        .mimeType,
    ).toBe("audio/wav");
  });
  it("rejects SVG, HTML, fake media, malformed base64 and invalid names", () => {
    for (const candidate of [
      file("image/svg+xml", Buffer.from("<svg/>")),
      file("text/html", Buffer.from("<h1>hi</h1>")),
      file("image/png", Buffer.from("<svg/>")),
      { ...file(), dataBase64: "AA==\n" },
      { ...file(), dataBase64: "AB==" },
      { ...file(), dataBase64: "AAAA====" },
      { ...file(), dataBase64: "" },
      file("image/png", png, "bad\nname"),
      file("image/png", png, " "),
      file("image/png", png, "a".repeat(181)),
      null,
    ])
      expect(() => parseSupportMedia([candidate])).toThrow();
    for (const candidate of [null, {}, "bad", [file(), file(), file(), file()]])
      expect(() => parseSupportMedia(candidate)).toThrow();
  });
  it("accepts exact10MiB without regexp stack overflow and bounds20MiB aggregate", () => {
    const ten = Buffer.alloc(10 * 1024 * 1024);
    png.copy(ten);
    expect(
      parseSupportMedia([file("image/png", ten), file("image/png", ten)])
        .length,
    ).toBe(2);
    expect(() =>
      parseSupportMedia([
        file("image/png", ten),
        file("image/png", ten),
        file(),
      ]),
    ).toThrow(/20 MiB/);
    const big = Buffer.alloc(ten.length + 1);
    png.copy(big);
    expect(() => parseSupportMedia([file("image/png", big)])).toThrow(/10 MiB/);
  });
  it("locks aggregate quota before writes and rejects exhausted uploaders", async () => {
    const statements: string[] = [];
    const c = {
      query: async (sql: string) => {
        statements.push(sql);
        return {
          rows: sql.includes("COALESCE(sum")
            ? [{ bytes: String(SUPPORT_MEDIA_MAX_UPLOADER_BYTES) }]
            : [],
        };
      },
    } as unknown as PoolClient;
    await expect(
      saveSupportMedia(c, "1", "actor", parseSupportMedia([file()])),
    ).rejects.toMatchObject({ status: 413 });
    expect(statements[0]).toContain("pg_advisory_xact_lock");
    expect(statements.some((s) => s.startsWith("INSERT"))).toBe(false);
  });
});
