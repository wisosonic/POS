import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from '../../db/adapter';
import { MAX_IMAGE_BYTES, STORED_NAME, storeImage } from '../catalog/images';
import type { Link } from './service';

// Product pictures come down with the products (docs/12 §19): a product carries the NAME of its picture (`/uploads/<name>`), and the file is
// fetched from HQ by that name. The name is made from the file's own content, so what arrives is checked against it: a file whose content does not
// give that name is not what the product asked for, and is not used. This never throws and never blocks the sync loop: a picture that cannot
// be fetched now is simply asked for again at the next round (a product shows without its picture until then).

export type FetchImagesOptions = { fetchImpl?: typeof fetch; signal?: AbortSignal; max?: number };

/** Fetch the pictures that products name and this branch does not have yet, at most `max` per call. Returns how many arrived. */
export async function fetchMissingImages(db: Database, link: Link, uploadsDir: string, opts: FetchImagesOptions = {}): Promise<number> {
  let rows: { image_path: string }[];
  try {
    rows = await db.all<{ image_path: string }>('SELECT DISTINCT image_path FROM products WHERE image_path IS NOT NULL');
  } catch {
    return 0;
  }
  let got = 0;
  for (const { image_path } of rows) {
    if (got >= (opts.max ?? 100) || opts.signal?.aborted) break;
    const name = image_path.startsWith('/uploads/') ? image_path.slice('/uploads/'.length) : '';
    if (!STORED_NAME.test(name) || existsSync(join(uploadsDir, name))) continue;
    try {
      const res = await (opts.fetchImpl ?? fetch)(`${link.hqUrl}/api/v1/sync/images/${name}`, {
        headers: { 'X-Branch-Token': link.token },
        signal: AbortSignal.any([...(opts.signal ? [opts.signal] : []), AbortSignal.timeout(30_000)]),
      });
      if (!res.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) continue;
      const stored = storeImage(uploadsDir, bytes);
      if (stored && stored.file === name) got++;
    } catch {
      // the network or the disk said no: tried again next round
    }
  }
  return got;
}
