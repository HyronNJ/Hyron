import type { ReportCategory, WaterLevel } from "@/lib/types";
import { contactFor } from "@/lib/contacts";
import { levelInfo } from "@/lib/community";
export const categories: ReportCategory[] = [
  "Blocked drain",
  "Street flooding",
  "Debris or obstruction",
  "Erosion or road damage",
  "Other",
];
export function emailDraft(input: {
  category: string;
  address: string;
  municipality: string;
  description: string;
  lat: number;
  lng: number;
  hasPhoto: boolean;
  waterLevel?: WaterLevel | null;
}) {
  const contact = contactFor(input.municipality),
    level = levelInfo(input.waterLevel);
  return {
    recipient: contact.email,
    emailSubject: `${input.category} near ${input.address || input.municipality}`,
    emailBody: `Hello ${contact.name},\n\nI would like to report a ${input.category.toLowerCase()} issue at ${input.address || "the location below"}, ${input.municipality}, NJ.\n\n${level ? `What I saw: ${level.label.toLowerCase()}.\n\n` : ""}${input.description}\n\nLocation: ${input.lat.toFixed(5)}, ${input.lng.toFixed(5)}\nMap: https://www.google.com/maps?q=${input.lat.toFixed(5)},${input.lng.toFixed(5)}\n\n${input.hasPhoto ? "I have a photo of this issue and will attach it to this message.\n\n" : ""}Please let me know if another department or road owner should receive this report.\n\nThank you.`,
  };
}
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Use a JPEG photo.");
  if (bytes.length < 8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    throw new Error("This photo is incomplete.");
  }
  const chunks: Uint8Array[] = [bytes.slice(0, 2)];
  let pos = 2;
  let hasImage = false;
  while (pos < bytes.length) {
    if (bytes[pos] !== 0xff) throw new Error("This photo is not a valid JPEG.");
    const marker = bytes[pos + 1];
    if (marker === 0xd9) break;
    if (pos + 3 >= bytes.length) throw new Error("This photo is incomplete.");
    if (marker === 0xda) {
      const scanLength = (bytes[pos + 2] << 8) | bytes[pos + 3];
      if (scanLength < 2 || pos + 2 + scanLength >= bytes.length - 2) {
        throw new Error("This photo is incomplete.");
      }
      hasImage = true;
      chunks.push(bytes.slice(pos));
      break;
    }
    const length = (bytes[pos + 2] << 8) | bytes[pos + 3];
    if (length < 2 || pos + 2 + length > bytes.length) throw new Error("This photo is incomplete.");
    if (!(marker >= 0xe1 && marker <= 0xef) && marker !== 0xfe)
      chunks.push(bytes.slice(pos, pos + 2 + length));
    pos += 2 + length;
  }
  if (!hasImage) throw new Error("This JPEG has no image data.");
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
