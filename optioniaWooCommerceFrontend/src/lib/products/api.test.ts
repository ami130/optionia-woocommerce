import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearSession, setSession } from '@/lib/auth/token-store';
import { listProducts } from './api';

const page = (data: unknown, pagination?: unknown): Response =>
  new Response(JSON.stringify({ data, meta: pagination === undefined ? {} : { pagination } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const sent = (mock: ReturnType<typeof vi.spyOn>) =>
  new URL(String((mock.mock.calls[0] as unknown[])[0]));

const PRODUCT = {
  id: 'ours-uuid',
  externalId: '1042',
  name: 'Custom Hoodie',
  sku: 'HOOD-1',
  type: 'simple',
  priceMinor: 1799,
  status: 'publish',
  permalink: null,
  imageUrl: null,
};

describe('products api', () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearSession();
    setSession({ accessToken: 'access-1', refreshToken: 'refresh-1' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads a page from the documented path', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(page([PRODUCT]));

    const result = await listProducts({ storeId: 'store-1' });

    expect(result.items).toEqual([PRODUCT]);
    expect(sent(fetchMock).pathname).toContain('/v1/products');
    expect(sent(fetchMock).searchParams.get('storeId')).toBe('store-1');
  });

  /**
   * 🔴 The defect this file exists for.
   *
   * `id` and `externalId` are both strings on the same object, so assigning the
   * wrong one type-checks, writes cleanly and returns 200 — then never renders,
   * because the plugin indexes by a WooCommerce id that does not exist. Nothing
   * else in the stack can catch it: Stage 0's ownership check rejects a *foreign*
   * id, but our own row id for the right product is a valid string the API has no
   * grounds to refuse.
   */
  it('keeps our id and WooCommerce’s id distinct', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(page([PRODUCT]));

    const [product] = (await listProducts({ storeId: 'store-1' })).items;

    expect(product.externalId).toBe('1042');
    expect(product.id).toBe('ours-uuid');
    expect(product.id).not.toBe(product.externalId);
  });

  /** An empty search is no search — `search=` would filter on the empty prefix. */
  it('omits an empty search rather than sending one', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(page([]));

    await listProducts({ storeId: 'store-1', search: '   ' });

    expect(sent(fetchMock).searchParams.has('search')).toBe(false);
  });

  it('sends a real search', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(page([]));

    await listProducts({ storeId: 'store-1', search: 'hood' });

    expect(sent(fetchMock).searchParams.get('search')).toBe('hood');
  });

  it('echoes the cursor back verbatim', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(page([]));

    await listProducts({ storeId: 'store-1', cursor: 'opaque==' });

    expect(sent(fetchMock).searchParams.get('cursor')).toBe('opaque==');
  });

  it('reads paging out of meta', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      page([PRODUCT], { cursor: 'next==', hasMore: true, limit: 50 }),
    );

    const result = await listProducts({ storeId: 'store-1' });

    expect(result.cursor).toBe('next==');
    expect(result.hasMore).toBe(true);
  });

  /**
   * A last page carries no cursor. Defaulting `hasMore` to true instead would
   * leave "Load more" on screen forever, refetching the same final page.
   */
  it('treats a missing pagination block as the last page', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(page([PRODUCT]));

    const result = await listProducts({ storeId: 'store-1' });

    expect(result.cursor).toBeNull();
    expect(result.hasMore).toBe(false);
  });
});
