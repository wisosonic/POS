import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Product pictures. A picture is judged by its BYTES, never by its name or by what the sender says it is: the legacy
// folder had a ".png" that was really WebP, a ".jpg" that was AVIF and two saved web pages. Each picture is stored under a
// name made from its own content (`<24 hex digits>.<real extension>`), so the same picture is kept once, a name never
// changes meaning, and the server only ever serves names of that one shape.
// SVG is deliberately not accepted: it can carry scripts.

export const IMAGE_TYPES = {
  jpeg: { ext: 'jpg', mime: 'image/jpeg' },
  png: { ext: 'png', mime: 'image/png' },
  gif: { ext: 'gif', mime: 'image/gif' },
  webp: { ext: 'webp', mime: 'image/webp' },
  avif: { ext: 'avif', mime: 'image/avif' },
} as const;
export type ImageKind = keyof typeof IMAGE_TYPES;

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** The only file names the server will serve from the pictures folder. */
export const STORED_NAME = /^[0-9a-f]{24}\.(jpg|png|gif|webp|avif)$/;
export const mimeOfStored = (file: string): string | null => {
  const ext = file.slice(file.lastIndexOf('.') + 1);
  return Object.values(IMAGE_TYPES).find((t) => t.ext === ext)?.mime ?? null;
};

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** What kind of picture these bytes are, or null if they are not one the shop accepts (a web page, SVG, text, junk). */
export function sniffImage(bytes: Uint8Array): ImageKind | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 32));
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'; // also what ".jfif" files are
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG)) return 'png';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (b.length >= 12 && b.subarray(4, 8).toString('latin1') === 'ftyp' && /^avi[fs]$/.test(b.subarray(8, 12).toString('latin1')))
    return 'avif';
  return null;
}

/**
 * Keep a picture in the pictures folder and say where. The name comes from the content, so storing the same picture
 * again changes nothing. Written to a temporary name first and renamed, so a half-written file is never served.
 * Returns the path to keep on the product (`/uploads/<name>`), or null when the bytes are not an acceptable picture.
 */
export function storeImage(dir: string, bytes: Uint8Array): { path: string; file: string; kind: ImageKind } | null {
  const kind = sniffImage(bytes);
  if (!kind) return null;
  const file = `${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}.${IMAGE_TYPES[kind].ext}`;
  mkdirSync(dir, { recursive: true });
  const target = join(dir, file);
  if (!existsSync(target)) {
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, bytes);
    renameSync(temp, target);
  }
  return { path: `/uploads/${file}`, file, kind };
}
