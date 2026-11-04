/**
 * A KVNamespace-shaped view over the Coordinator Durable Object's storage.
 *
 * Why: on Nov 3 the cron + webhook used 963 of KV's 1,000 free daily writes.
 * All bot state now lives in the Durable Object; KV is only read, as a
 * fallback for keys written before this change (migrate-on-read):
 *   - get: DO entry wins (a tombstone means deleted); otherwise the legacy
 *     KV value is returned. The next put stores it in the DO.
 *   - list (subscribers only): the first call imports the legacy `sub:` keys
 *     from KV once (keys + metadata, no per-key reads), then lists the DO.
 * Nothing here writes to KV, so a run makes 0 KV writes.
 */
import type { RunLock, StateEntry } from "./coordinator";

type GetType = "text" | "json" | { type?: "text" | "json"; cacheTtl?: number } | undefined;

const typeOf = (t: GetType): "text" | "json" =>
  (typeof t === "string" ? t : t?.type) === "json" ? "json" : "text";

export class DoKV {
  private imported = new Set<string>();

  constructor(
    private readonly lock: RunLock,
    private readonly legacy: KVNamespace | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  private async read(key: string): Promise<{ value: string | null; metadata: unknown }> {
    const entry = await this.lock.stateGet(key, this.now());
    if (entry) return { value: entry.value, metadata: entry.metadata ?? null };
    if (!this.legacy) return { value: null, metadata: null };
    const { value, metadata } = await this.legacy.getWithMetadata(key);
    return { value, metadata: metadata ?? null };
  }

  async get(key: string, type?: GetType): Promise<unknown> {
    const { value } = await this.read(key);
    if (value === null) return null;
    return typeOf(type) === "json" ? JSON.parse(value) : value;
  }

  async getWithMetadata(key: string, type?: GetType): Promise<{ value: unknown; metadata: unknown }> {
    const { value, metadata } = await this.read(key);
    if (value === null) return { value: null, metadata: null };
    return { value: typeOf(type) === "json" ? JSON.parse(value) : value, metadata };
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number; metadata?: unknown }): Promise<void> {
    const entry: StateEntry = { value };
    if (opts?.metadata !== undefined) entry.metadata = opts.metadata;
    if (opts?.expirationTtl) entry.expiresAt = this.now() + opts.expirationTtl * 1000;
    await this.lock.statePut(key, entry);
  }

  async delete(key: string): Promise<void> {
    // Tombstone so the legacy KV copy is not resurrected. Kept 31 days,
    // longer than any legacy TTL (30 days); legacy `sub:` keys have no TTL
    // but are only read via the one-time import, which skips tombstoned keys.
    await this.lock.statePut(key, { value: null, expiresAt: this.now() + 31 * 24 * 3600 * 1000 });
  }

  async list(opts: { prefix?: string; cursor?: string } = {}): Promise<{
    keys: { name: string; metadata: unknown }[];
    list_complete: true;
    cursor?: undefined;
  }> {
    const prefix = opts.prefix ?? "";
    await this.importLegacy(prefix);
    return { keys: await this.lock.stateList(prefix, this.now()), list_complete: true };
  }

  private async importLegacy(prefix: string): Promise<void> {
    if (!this.legacy || this.imported.has(prefix)) return;
    if (!(await this.lock.stateImported(prefix))) {
      const entries: { name: string; entry: StateEntry }[] = [];
      let cursor: string | undefined;
      do {
        const page = await this.legacy.list({ prefix, cursor });
        for (const k of page.keys) {
          const entry: StateEntry = { value: "1" };
          if (k.metadata !== undefined) entry.metadata = k.metadata;
          if (k.expiration) entry.expiresAt = k.expiration * 1000;
          entries.push({ name: k.name, entry });
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      await this.lock.stateImport(prefix, entries);
    }
    this.imported.add(prefix);
  }
}
