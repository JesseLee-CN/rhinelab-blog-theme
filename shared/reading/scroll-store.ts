/**
 * Reader scroll memory: `postId + canonicalPath + content fingerprint` ->
 * anchor / anchor offset / scrollTop, bounded to the most recent 20 records.
 *
 * Only positions are stored (never DOM or body text), and the backing store is
 * injectable so the reader can use `sessionStorage` while tests use a stub.
 */
export type ReaderScrollRecord = {
  postId: string;
  canonicalPath: string;
  fingerprint: string;
  anchorId: string | null;
  anchorOffset: number;
  scrollTop: number;
  updatedAt: number;
};

export type ReaderScrollStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export const SCROLL_STORE_KEY = "rhine.reader.scroll.v1";
export const SCROLL_LIMIT = 20;

function recordKey(postId: string, canonicalPath: string, fingerprint: string): string {
  return `${postId}::${canonicalPath}::${fingerprint}`;
}

function readAll(storage: ReaderScrollStorage | null): ReaderScrollRecord[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(SCROLL_STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is ReaderScrollRecord =>
        typeof entry === "object" &&
        entry !== null &&
        typeof entry.postId === "string" &&
        typeof entry.canonicalPath === "string" &&
        typeof entry.fingerprint === "string" &&
        typeof entry.scrollTop === "number",
    );
  } catch {
    return [];
  }
}

function writeAll(storage: ReaderScrollStorage | null, records: ReaderScrollRecord[]): void {
  if (!storage) return;
  try {
    if (!records.length) {
      storage.removeItem(SCROLL_STORE_KEY);
      return;
    }
    storage.setItem(SCROLL_STORE_KEY, JSON.stringify(records));
  } catch {
    // A full or blocked store only costs the next restore attempt.
  }
}

export function createReaderScrollStore(storage: ReaderScrollStorage | null, limit = SCROLL_LIMIT) {
  return {
    /** Most recent first, capped at `limit` records. */
    list(): ReaderScrollRecord[] {
      return readAll(storage)
        .slice()
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, limit);
    },
    get(postId: string, canonicalPath: string, fingerprint: string): ReaderScrollRecord | null {
      const key = recordKey(postId, canonicalPath, fingerprint);
      return this.list().find((entry) => recordKey(entry.postId, entry.canonicalPath, entry.fingerprint) === key) ?? null;
    },
    save(record: Omit<ReaderScrollRecord, "updatedAt"> & { updatedAt?: number }): void {
      const key = recordKey(record.postId, record.canonicalPath, record.fingerprint);
      const next = this.list().filter((entry) => recordKey(entry.postId, entry.canonicalPath, entry.fingerprint) !== key);
      next.unshift({ ...record, updatedAt: record.updatedAt ?? Date.now() });
      writeAll(storage, next.slice(0, limit));
    },
    clear(): void {
      writeAll(storage, []);
    },
  };
}

export type ReaderScrollStore = ReturnType<typeof createReaderScrollStore>;

/** In-memory store used when `sessionStorage` is unavailable or blocked. */
export function createMemoryScrollStorage(): ReaderScrollStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

/** Resolve the bounded restore offset from a stored record and current layout. */
export function restoreScrollTop(
  record: Pick<ReaderScrollRecord, "anchorId" | "anchorOffset" | "scrollTop">,
  resolveAnchorTop: (anchorId: string) => number | null,
  maxScrollTop: number,
): { scrollTop: number; mode: "anchor" | "offset" | "top" } {
  if (record.anchorId) {
    const anchorTop = resolveAnchorTop(record.anchorId);
    if (anchorTop !== null && Number.isFinite(anchorTop)) {
      return { scrollTop: Math.max(0, Math.min(maxScrollTop, anchorTop - record.anchorOffset)), mode: "anchor" };
    }
  }
  if (Number.isFinite(record.scrollTop) && record.scrollTop > 0) {
    return { scrollTop: Math.max(0, Math.min(maxScrollTop, record.scrollTop)), mode: "offset" };
  }
  return { scrollTop: 0, mode: "top" };
}

/** Anchor id for a position: the topmost element id at or above the offset. */
export function findAnchorId(
  candidates: { id: string; top: number }[],
  scrollTop: number,
  anchorMargin = 16,
): { anchorId: string | null; anchorOffset: number } {
  const sorted = candidates
    .filter((candidate) => candidate.id && Number.isFinite(candidate.top))
    .slice()
    .sort((left, right) => left.top - right.top);
  let chosen: { id: string; top: number } | null = null;
  for (const candidate of sorted) {
    if (candidate.top <= scrollTop + anchorMargin) chosen = candidate;
    else break;
  }
  if (!chosen) return { anchorId: null, anchorOffset: scrollTop };
  return { anchorId: chosen.id, anchorOffset: Math.max(0, scrollTop - chosen.top) };
}
