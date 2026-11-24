// The browser tab is named after the shop. The name is remembered on this computer so the sign-in page, which cannot ask the
// server yet, and the first moment of a reload show it too.
const KEY = 'pos.shopName';

export function rememberedShopName(store: Pick<Storage, 'getItem'> | null = safeStorage()): string | null {
  try {
    return store?.getItem(KEY)?.trim() || null;
  } catch {
    return null;
  }
}

/** Put the shop's name on the tab (and remember it). An empty name leaves the title as it is. */
export function setShopTitle(
  name: string | null | undefined,
  store: Pick<Storage, 'setItem'> | null = safeStorage(),
  doc: Pick<Document, 'title'> = document,
) {
  const n = name?.trim();
  if (!n) return;
  doc.title = n;
  try {
    store?.setItem(KEY, n);
  } catch {
    /* storage may be blocked: the title still changed */
  }
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
