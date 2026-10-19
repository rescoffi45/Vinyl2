export type ExtractedMetadata = {
  title?: string;
  artist?: string;
  album?: string;
  duration?: string;
  art?: string;
};

const IMAGE_SIGNATURES: Array<{ mime: string; bytes: number[] }> = [
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] },
];

function findImageStart(data: Uint8Array, from: number, to: number): { start: number; mime: string } | null {
  for (let i = from; i < to - 3; i++) {
    for (const signature of IMAGE_SIGNATURES) {
      let matches = true;
      for (let j = 0; j < signature.bytes.length; j++) {
        if (data[i + j] !== signature.bytes[j]) { matches = false; break; }
      }
      if (matches) return { start: i, mime: signature.mime };
    }
  }
  return null;
}

function bytesToUrl(bytes: Uint8Array, mime: string): string {
  const copied = new Uint8Array(bytes.length);
  copied.set(bytes);
  return URL.createObjectURL(new Blob([copied], { type: mime }));
}

function decodeText(data: Uint8Array, encoding: number): string {
  try {
    if (encoding === 0 || encoding === 3) return new TextDecoder('iso-8859-1').decode(data).replace(/\0+$/, '').trim();
    if (encoding === 1) return new TextDecoder('utf-16').decode(data).replace(/^\ufeff/, '').replace(/\0+$/, '').trim();
    if (encoding === 2) return new TextDecoder('utf-16be').decode(data).replace(/\0+$/, '').trim();
  } catch { /* ignore */ }
  return new TextDecoder('iso-8859-1').decode(data).replace(/\0+$/, '').trim();
}

function readSyncsafeInt(data: Uint8Array, offset: number): number {
  return ((data[offset] & 0x7f) << 21) | ((data[offset + 1] & 0x7f) << 14) | ((data[offset + 2] & 0x7f) << 7) | (data[offset + 3] & 0x7f);
}

function readPlainInt(data: Uint8Array, offset: number, length: number): number {
  let value = 0;
  for (let i = 0; i < length; i++) value = (value << 8) | data[offset + i];
  return value;
}

export async function extractMetadata(file: File): Promise<ExtractedMetadata> {
  const result: ExtractedMetadata = {};

  if (file.name.toLowerCase().endsWith('.mp3')) {
    await extractId3(file, result);
  }

  if (!result.art) {
    result.art = await lookupItunesArtwork(result.title, result.artist) ?? undefined;
  }

  return result;
}

async function extractId3(file: File, result: ExtractedMetadata): Promise<void> {
  try {
    const header = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (header.length < 10 || String.fromCharCode(...header.slice(0, 3)) !== 'ID3') return;
    const version = header[3];
    if (version < 2 || version > 4) return;

    const tagSize = readSyncsafeInt(header, 6);
    const readSize = Math.min(file.size, tagSize + 10, 32 * 1024 * 1024);
    const data = new Uint8Array(await file.slice(0, readSize).arrayBuffer());

    const isV22 = version === 2;
    const frameIdLength = isV22 ? 3 : 4;
    const headerLength = isV22 ? 6 : 10;
    let offset = 10;
    const tagEnd = data.length;

    while (offset + headerLength <= tagEnd) {
      const frameId = String.fromCharCode(...data.slice(offset, offset + frameIdLength));
      if (!frameId.trim() || frameId.charCodeAt(0) === 0) break;

      let frameSize: number;
      if (isV22) frameSize = readPlainInt(data, offset + 3, 3);
      else if (version === 4) frameSize = readSyncsafeInt(data, offset + 4);
      else frameSize = readPlainInt(data, offset + 4, 4);

      if (frameSize <= 0 || offset + headerLength + frameSize > tagEnd) break;

      const bodyStart = offset + headerLength;
      const bodyEnd = bodyStart + frameSize;
      const body = data.slice(bodyStart, bodyEnd);

      if (frameId === (isV22 ? 'PIC' : 'APIC')) {
        const image = scanForImage(body, 1, body.length);
        if (image) result.art = bytesToUrl(body.slice(image.start), image.mime);
      } else if (frameId === 'TIT2' || (isV22 && frameId === 'TT2')) {
        if (body.length > 1) result.title = decodeText(body.slice(1), body[0]) || result.title;
      } else if (frameId === 'TPE1' || (isV22 && frameId === 'TP1')) {
        if (body.length > 1) result.artist = decodeText(body.slice(1), body[0]).split('/')[0] || result.artist;
      } else if (frameId === 'TALB' || (isV22 && frameId === 'TAL')) {
        if (body.length > 1) result.album = decodeText(body.slice(1), body[0]) || result.album;
      }

      offset += headerLength + frameSize;
    }
  } catch (error) {
    console.warn('Lecture ID3 impossible pour', file.name, error);
  }
}

function scanForImage(body: Uint8Array, from: number, to: number): { start: number; mime: string } | null {
  return findImageStart(body, from, to);
}

async function lookupItunesArtwork(title?: string, artist?: string): Promise<string | null> {
  const searchTerm = [artist, title].filter(Boolean).join(' ');
  if (!searchTerm) return null;
  try {
    const response = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(searchTerm)}&entity=song&limit=5`);
    if (!response.ok) return null;
    const payload = await response.json() as { results?: Array<{ trackName?: string; artistName?: string; artworkUrl100?: string }> };
    const normalize = (value: string) => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
    const targetTitle = title ? normalize(title) : '';
    const targetArtist = artist ? normalize(artist) : '';
    const match = payload.results?.find((item) =>
      item.artworkUrl100 && targetTitle &&
      normalize(item.trackName || '').includes(targetTitle) &&
      (!targetArtist || normalize(item.artistName || '').includes(targetArtist))
    ) ?? payload.results?.find((item) => item.artworkUrl100);
    return match?.artworkUrl100 ? match.artworkUrl100.replace('100x100bb', '600x600bb') : null;
  } catch {
    return null;
  }
}
