// Product-event triggers keep the index fresh. They run as the app, with no user.
import { indexKeys, type ScanDeps } from './scan';

/** Incremental reindex of one issue. Throws on failure so Forge logs it (and can retry). */
export async function handleProductEvent(deps: ScanDeps, event: any): Promise<{ target: string; indexed: boolean }> {
  const type: string = event?.eventType ?? '';
  if (type.startsWith('avi:jira:')) {
    const key: string | undefined = event?.issue?.key;
    if (!key) throw new Error(`Jira event ${type} had no issue key`);
    const r = await indexKeys(deps, [key]);
    if (r.failed.length) throw new Error(`Reindex of ${key} failed: ${r.failed[0]!.reason}`);
    return { target: key, indexed: true };
  }
  return { target: type, indexed: false };
}
