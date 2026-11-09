// Product-event triggers keep the index fresh. They run as the app, with no user.
import { route } from './api';
import { indexPages, indexKeys, type ScanDeps } from './scan';

/** Incremental reindex of one issue or page. Throws on failure so Forge logs it (and can retry). */
export async function handleProductEvent(deps: ScanDeps, event: any): Promise<{ target: string; indexed: boolean }> {
  const type: string = event?.eventType ?? '';
  if (type.startsWith('avi:jira:')) {
    const key: string | undefined = event?.issue?.key;
    if (!key) throw new Error(`Jira event ${type} had no issue key`);
    const r = await indexKeys(deps, [key]);
    if (r.failed.length) throw new Error(`Reindex of ${key} failed: ${r.failed[0]!.reason}`);
    return { target: key, indexed: true };
  }
  if (type.startsWith('avi:confluence:')) {
    // Payload field names for Confluence events are UNVERIFIED; accept the likely ones.
    const id = String(event?.page?.id ?? event?.content?.id ?? event?.id ?? '');
    if (!id) throw new Error(`Confluence event ${type} had no page id`);
    const c = deps.api.asApp();
    const res = await c.requestConfluence(route`/wiki/api/v2/pages/${id}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Confluence page ${id}: HTTP ${res.status}`);
    const p = await res.json();
    const stub = { id: String(p.id), title: p.title, ownerId: p.ownerId ?? null, authorId: p.authorId ?? null, spaceName: String(p.spaceId ?? ''), createdAt: p.createdAt, status: p.status };
    const failed = await indexPages(deps, [stub]);
    if (failed.length) throw new Error(`Reindex of page ${id} failed: ${failed[0]!.reason}`);
    return { target: `page:${id}`, indexed: true };
  }
  return { target: type, indexed: false };
}
