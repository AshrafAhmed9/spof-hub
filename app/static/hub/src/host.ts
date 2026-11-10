import { useEffect, useState } from 'react';
import { isForge } from './api';

export type Host = { product: 'jira' | 'confluence' | 'unknown'; siteUrl: string; /** Set when the page is the Jira issue panel. */ issueKey?: string };

let cached: Promise<Host> | undefined;

/** Which Atlassian product is hosting the page. `?product=confluence` forces it in the local mock. */
export function getHost(): Promise<Host> {
  cached ??= (async (): Promise<Host> => {
    if (!isForge) {
      const p = new URLSearchParams(window.location.search).get('product');
      const key = new URLSearchParams(window.location.search).get('issue') ?? undefined;
      return { product: p === 'confluence' ? 'confluence' : 'jira', siteUrl: 'https://example.atlassian.net', ...(key ? { issueKey: key } : {}) };
    }
    try {
      const { view } = await import('@forge/bridge');
      const ctx = await view.getContext();
      const ext = (ctx as { extension?: { type?: string; issue?: { key?: string } } }).extension;
      const type = String(ext?.type ?? ctx.moduleKey ?? '');
      const product = type.startsWith('confluence') ? 'confluence' : type.startsWith('jira') ? 'jira' : 'unknown';
      const issueKey = type === 'jira:issuePanel' ? ext?.issue?.key : undefined;
      return { product, siteUrl: ctx.siteUrl ?? '', ...(issueKey ? { issueKey } : {}) };
    } catch {
      return { product: 'unknown', siteUrl: '' };
    }
  })();
  return cached;
}

export function useHost(): Host | null {
  const [h, setH] = useState<Host | null>(null);
  useEffect(() => { void getHost().then(setH); }, []);
  return h;
}

const JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

/** Real URL for an item, or null when we cannot build one reliably (pull requests, goals). */
export function itemUrl(itemId: string, siteUrl: string): string | null {
  if (!siteUrl) return null;
  const base = siteUrl.replace(/\/$/, '');
  if (JIRA_KEY.test(itemId)) return `${base}/browse/${itemId}`;
  const page = /^page:(\d+)$/.exec(itemId);
  if (page) return `${base}/wiki/pages/viewpage.action?pageId=${page[1]}`;
  return null;
}

/** Opens in a new tab through the host, because a plain link inside the Forge iframe cannot navigate the parent. */
export async function openExternal(url: string) {
  if (!isForge) { window.open(url, '_blank', 'noopener'); return; }
  const { router } = await import('@forge/bridge');
  await router.open(url);
}
