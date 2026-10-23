import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IMAGE_TYPES, STORED_NAME, mimeOfStored, sniffImage, storeImage } from '../../apps/api/src/modules/catalog/images';
import { avif, gif, html, jpeg, png, svg, webp } from '../helpers/images';

// US-15: product pictures are judged by their bytes, never by a name or a claimed type.
describe('what kind of picture are these bytes?', () => {
  it('recognises the five kinds the shop accepts', () => {
    expect(sniffImage(jpeg())).toBe('jpeg');
    expect(sniffImage(png())).toBe('png');
    expect(sniffImage(gif())).toBe('gif');
    expect(sniffImage(webp())).toBe('webp');
    expect(sniffImage(avif())).toBe('avif');
  });

  it('knows both GIF versions', () => {
    expect(sniffImage(Buffer.from('GIF87a-----', 'latin1'))).toBe('gif');
    expect(sniffImage(Buffer.from('GIF89a-----', 'latin1'))).toBe('gif');
    expect(sniffImage(Buffer.from('GIF88a-----', 'latin1'))).toBeNull();
  });

  it('refuses a web page, SVG (it can carry a script), XML, text, and nothing at all', () => {
    for (const bytes of [html(), svg(), Buffer.from('<?xml version="1.0"?><svg/>'), Buffer.from('just some text'), Buffer.alloc(0)]) {
      expect(sniffImage(bytes)).toBeNull();
    }
  });

  it('refuses files that only start like a picture', () => {
    expect(sniffImage(Buffer.from([0xff, 0xd8]))).toBeNull(); // too short to be a JPEG
    expect(sniffImage(Buffer.from('GIF8'))).toBeNull();
    expect(sniffImage(Buffer.from('RIFF....WAVEfmt ', 'latin1'))).toBeNull(); // RIFF, but audio
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull(); // half a PNG signature
    expect(sniffImage(Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypheic'), Buffer.alloc(20)]))).toBeNull(); // HEIC: not for browsers
  });

  it('is decided by the start of the file, so a page with a picture signature later on is still a page', () => {
    expect(sniffImage(Buffer.concat([html(), png()]))).toBeNull();
  });

  it('works on a view into a bigger buffer (as the file reader hands it over)', () => {
    const big = Buffer.concat([Buffer.alloc(100, 1), png(), Buffer.alloc(100, 1)]);
    expect(sniffImage(big.subarray(100, 100 + png().length))).toBe('png');
  });
});

describe('keeping a picture', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pos-images-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('names it from what it is: 24 hex digits and the real extension, whatever the sender called it', () => {
    const a = storeImage(join(dir, 'made', 'later'), webp('one'))!; // the folder is created when needed
    expect(a.file).toMatch(STORED_NAME);
    expect(a.file.endsWith('.webp')).toBe(true);
    expect(a.path).toBe(`/uploads/${a.file}`);
    expect(a.kind).toBe('webp');
    expect(readFileSync(join(dir, 'made', 'later', a.file))).toEqual(webp('one'));
  });

  it('keeps the same picture once, however many times it is stored', () => {
    const first = storeImage(dir, jpeg('same'))!;
    const second = storeImage(dir, jpeg('same'))!;
    expect(second.file).toBe(first.file);
    expect(readdirSync(dir).filter((f) => f === first.file)).toHaveLength(1);
  });

  it('gives different pictures different names, and the kind is part of the name', () => {
    const names = new Set([png('p1'), png('p2'), jpeg('p1'), gif('p1'), avif('p1')].map((b) => storeImage(dir, b)!.file));
    expect(names.size).toBe(5);
  });

  it('stores nothing for something that is not a picture', () => {
    const before = readdirSync(dir).sort();
    expect(storeImage(dir, html())).toBeNull();
    expect(storeImage(dir, svg())).toBeNull();
    expect(storeImage(dir, Buffer.alloc(0))).toBeNull();
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  it('leaves no half-written files behind', () => {
    storeImage(dir, png('clean'));
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('the names it makes are exactly the names the server will serve, and no others', () => {
    for (const kind of Object.keys(IMAGE_TYPES)) {
      const file = `0123456789abcdef01234567.${IMAGE_TYPES[kind as keyof typeof IMAGE_TYPES].ext}`;
      expect(STORED_NAME.test(file), file).toBe(true);
      expect(mimeOfStored(file), file).toBe(IMAGE_TYPES[kind as keyof typeof IMAGE_TYPES].mime);
    }
    for (const bad of [
      'index.html',
      'secret.txt',
      'pos.db',
      '0123456789abcdef01234567.html',
      '0123456789abcdef01234567.svg',
      '0123456789abcdef0123456.png', // one digit short
      '0123456789abcdef012345678.png', // one too many
      '0123456789ABCDEF01234567.png', // capitals: not a name we make
      '../0123456789abcdef01234567.png',
      '0123456789abcdef01234567.png.html',
      '0123456789abcdef01234567.PNG',
    ])
      expect(STORED_NAME.test(bad), bad).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });
});
