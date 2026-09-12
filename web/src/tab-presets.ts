export const tabPresets = [
  { id: "atlas", name: "Atlas", title: "Atlas", icon: "/favicon.svg" },
  {
    id: "google",
    name: "Google",
    title: "Google",
    icon: "/tab-icons/google.ico",
  },
  { id: "gmail", name: "Gmail", title: "Gmail", icon: "/tab-icons/gmail.ico" },
  {
    id: "drive",
    name: "Google Drive",
    title: "Google Drive",
    icon: "/tab-icons/drive.png",
  },
  {
    id: "docs",
    name: "Google Docs",
    title: "Google Docs",
    icon: "/tab-icons/docs.ico",
  },
  {
    id: "sheets",
    name: "Google Sheets",
    title: "Google Sheets",
    icon: "/tab-icons/sheets.ico",
  },
  {
    id: "classroom",
    name: "Google Classroom",
    title: "Google Classroom",
    icon: "/tab-icons/classroom.png",
  },
] as const;
export type TabPreset = (typeof tabPresets)[number]["id"] | "custom";
export function validCustomIcon(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 50000 &&
    /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(value)
  );
}
export function tabAppearance(s: {
  tabPreset: TabPreset;
  title: string;
  tabIcon: string;
}) {
  if (s.tabPreset === "custom")
    return {
      title: s.title.trim() || "Atlas",
      icon: validCustomIcon(s.tabIcon) ? s.tabIcon : "/favicon.svg",
    };
  return tabPresets.find((p) => p.id === s.tabPreset) || tabPresets[0];
}

export async function readTabIcon(file: File): Promise<string> {
  if (file.size > 1_000_000) throw Error("Choose an icon smaller than 1 MB.");
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.slice(start, end));
  const raster =
    (bytes[0] === 137 && ascii(1, 4) === "PNG") ||
    (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ||
    (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") ||
    ascii(0, 3) === "GIF" ||
    (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0);
  if (!raster) throw Error("Choose a PNG, JPEG, WebP, GIF, or ICO image.");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (
      !image.naturalWidth ||
      !image.naturalHeight ||
      image.naturalWidth > 4096 ||
      image.naturalHeight > 4096
    )
      throw Error("Choose an image up to 4096 × 4096 pixels.");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw Error("The icon could not be prepared. Try another image.");
    const scale = 64 / Math.max(image.naturalWidth, image.naturalHeight);
    const w = image.naturalWidth * scale,
      h = image.naturalHeight * scale;
    ctx.drawImage(image, (64 - w) / 2, (64 - h) / 2, w, h);
    const data = canvas.toDataURL("image/png");
    if (!validCustomIcon(data)) throw Error("The icon could not be prepared.");
    return data;
  } finally {
    URL.revokeObjectURL(url);
  }
}
