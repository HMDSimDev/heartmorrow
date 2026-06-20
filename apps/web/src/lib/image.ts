/**
 * Client-side image downscaling for chat photos. Large images slow vision models
 * dramatically, so we shrink a picture to a small max height in the BROWSER before
 * uploading it — the stored asset (and thus what the vision model receives) is
 * already small, and the UI thumbnail is light. Portraits are NOT downscaled here
 * (they're displayed large); this is only used for text-message attachments.
 */

/** Default max height for a downscaled chat photo (width scales proportionally). */
export const CHAT_IMAGE_MAX_HEIGHT = 512;

/**
 * Return a downscaled copy of `file` whose height is at most `maxHeight` (width
 * scaled to keep the aspect ratio). Re-encodes to JPEG to keep the payload tiny.
 * If the image is already small enough, can't be decoded, or is an animated GIF,
 * the original file is returned unchanged (best-effort, never throws).
 */
export async function downscaleImageFile(file: File, maxHeight = CHAT_IMAGE_MAX_HEIGHT): Promise<File> {
  if (!file.type.startsWith('image/')) return file;
  // Re-drawing an animated GIF would flatten it to a single frame — leave as-is.
  if (file.type === 'image/gif') return file;

  let bitmap: ImageBitmap;
  try {
    // `from-image` applies EXIF orientation so phone photos aren't sideways.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return file; // undecodable here → let the server take the original
  }

  try {
    const { width, height } = bitmap;
    if (!height || height <= maxHeight) return file; // already small enough

    const scale = maxHeight / height;
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) return file;

    const name = `${file.name.replace(/\.[^.]+$/, '')}.jpg`;
    return new File([blob], name, { type: 'image/jpeg' });
  } finally {
    bitmap.close?.();
  }
}
