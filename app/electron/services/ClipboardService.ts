import { clipboard, nativeImage } from 'electron';

export type ClipboardWriteOptions = {
  text?: string;
  html?: string;
  imageBase64?: string; // data URL or raw base64 PNG/JPEG
};

class ClipboardServiceImpl {
  write(options: ClipboardWriteOptions): { ok: boolean } {
    if (options.text) clipboard.writeText(options.text);
    if (options.html) clipboard.writeHTML(options.html);
    if (options.imageBase64) {
      let data = options.imageBase64.trim();
      // Support data URLs
      if (data.startsWith('data:image')) {
        const commaIdx = data.indexOf(',');
        if (commaIdx >= 0) data = data.slice(commaIdx + 1);
      }
      const img = nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
      clipboard.writeImage(img);
    }
    return { ok: true };
  }

  readText(): string {
    return clipboard.readText();
  }

  readHTML(): string {
    return clipboard.readHTML();
  }

  readImageBase64(): string | null {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    return img.toPNG().toString('base64');
  }
}

export const ClipboardService = new ClipboardServiceImpl(); 