// Prepares a photo/screenshot of a task for upload: decode, downscale to a readable size, JPEG.
// Keeps uploads small (typically 150–400 KB) so photo tasks are fast and cheap.

export const MAX_IMAGE_SIDE = 1600;

export interface PreparedImage {
  /** data:image/jpeg;base64,… sent to the server (never stored there). */
  dataUrl: string;
  /** blob: URL for the local thumbnail. */
  previewUrl: string;
  bytes: number;
}

export function scaledSize(width: number, height: number, max = MAX_IMAGE_SIDE): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      /* fall back to <img> (older Safari, unusual formats) */
    }
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  await img.decode();
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
}

export async function prepareImage(file: Blob): Promise<PreparedImage> {
  if (!file.type.startsWith('image/')) throw new Error('Please choose an image (photo or screenshot).');
  const img = await decode(file);
  try {
    const { width, height } = scaledSize(img.width, img.height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot process images.');
    ctx.fillStyle = '#ffffff'; // transparent screenshots → white, not black, in JPEG
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img.source, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the image.'))), 'image/jpeg', 0.85),
    );
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Could not read the image.'));
      reader.readAsDataURL(blob);
    });
    return { dataUrl, previewUrl: URL.createObjectURL(blob), bytes: blob.size };
  } finally {
    img.close();
  }
}
