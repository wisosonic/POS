// Tiny stand-in pictures for tests: each starts with the real signature of its kind, which is all the server looks at.
// `tag` makes two pictures of the same kind different, so they get different stored names.
const pad = (tag: string) => Buffer.from(`-${tag}-`.padEnd(40, 'x'), 'latin1');

export const png = (tag = 'a') => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pad(tag)]);
export const jpeg = (tag = 'a') => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), pad(tag)]);
export const gif = (tag = 'a') => Buffer.concat([Buffer.from('GIF89a', 'latin1'), pad(tag)]);
export const webp = (tag = 'a') =>
  Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBPVP8 ', 'latin1'), pad(tag)]);
export const avif = (tag = 'a') => Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypavif', 'latin1'), pad(tag)]);

export const html = () => Buffer.from('<!DOCTYPE html><html><body><script>alert(1)</script></body></html>', 'latin1');
export const svg = () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'latin1');

export const KINDS = { png, jpeg, gif, webp, avif } as const;
