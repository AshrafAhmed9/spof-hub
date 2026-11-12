import { useEffect, useRef, type ReactNode } from 'react';
import Button from '@atlaskit/button/new';
import SectionMessage, { SectionMessageAction } from '@atlaskit/section-message';
import Spinner from '@atlaskit/spinner';
import { ApiError } from './api';
import { openExternal } from './host';
import { shortName } from './util';

let arrowNav = false;
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => { arrowNav = ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key); }, true);
  document.addEventListener('pointerdown', () => { arrowNav = false; }, true);
}

/**
 * Moves focus to the page heading when the view changes, so keyboard and screen-reader users land on new content.
 * Skipped while arrowing along the tab list, so the user keeps their place there.
 */
export function useFocusHeading(dep: unknown) {
  const ref = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (arrowNav && document.activeElement?.getAttribute('role') === 'tab') return;
    ref.current?.focus();
  }, [dep]);
  return ref;
}

export function Loading({ label, rows = 4 }: { label: string; rows?: number }) {
  return (
    <div className="card card-pad stack-sm loading-box" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      <div className="row subtle"><Spinner size="small" label="" /> <span aria-hidden="true">{label}</span></div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skel" style={{ width: `${90 - i * 12}%` }} aria-hidden="true" />
      ))}
    </div>
  );
}

/** `unchanged` is the "Nothing was changed." sentence; turn it off where a write may have partly gone through. */
export function ErrorPanel({ error, onRetry, what = 'this', unchanged = true }: { error: unknown; onRetry?: () => void; what?: string; unchanged?: boolean }) {
  const denied = error instanceof ApiError && error.denied;
  const detail = error instanceof Error ? error.message : String(error);
  if (denied) {
    return (
      <SectionMessage appearance="warning" title="You don't have access to this">
        <p>You can't see {what}. If you think you should, ask a project admin to give you access.{unchanged && ' Nothing was changed.'}</p>
      </SectionMessage>
    );
  }
  return (
    <SectionMessage
      appearance="error"
      title={`Couldn't load ${what}`}
      actions={onRetry ? [<SectionMessageAction key="r" onClick={onRetry}>Try again</SectionMessageAction>] : []}
    >
      {unchanged && <p>Nothing was changed.</p>}
      <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: 'pointer' }}>Details</summary>
        <p className="small subtle" style={{ marginTop: 4, overflowWrap: 'anywhere' }}>{detail}</p>
      </details>
    </SectionMessage>
  );
}

export function PartialNotice({ notes, onSetup }: { notes: string[]; onSetup?: () => void }) {
  return (
    <SectionMessage
      appearance="warning"
      title="Some results are missing"
      actions={onSetup ? [<SectionMessageAction key="s" onClick={onSetup}>Open setup check</SectionMessageAction>] : []}
    >
      {notes.length ? (
        <ul style={{ margin: 0, paddingLeft: 20 }}>{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
      ) : (
        <p>Some sources could not be read, so this list may be incomplete.</p>
      )}
    </SectionMessage>
  );
}

export function EmptyState({ title, body, children, headingRef }: { title: string; body: ReactNode; children?: ReactNode; headingRef?: React.Ref<HTMLHeadingElement> }) {
  return (
    <div className="card">
      <div className="empty">
        <h2 ref={headingRef} tabIndex={-1}>{title}</h2>
        <p className="subtle">{body}</p>
        {children ? <div className="row" style={{ justifyContent: 'center' }}>{children}</div> : null}
      </div>
    </div>
  );
}

export function SampleBanner({ onSetup, onLive }: { onSetup: () => void; onLive?: () => void }) {
  return (
    <SectionMessage appearance="information" title="You're looking at example data">
      <p>
        You can preview plans here, but nothing in your site changes.{' '}
        <button type="button" className="linkbtn" onClick={onSetup}>See setup</button>
        {onLive && <>{' '}<button type="button" className="linkbtn" onClick={onLive}>Back to my site</button></>}
      </p>
    </SectionMessage>
  );
}

export function PrimaryButton(p: React.ComponentProps<typeof Button>) {
  return <Button appearance="primary" {...p} />;
}

/** Compact title for hosts that do not render one (Confluence). Not a heading, so each view keeps a single h1. */
export function AppHeader() {
  return (
    <header className="app-header">
      <p className="brand">Depth Chart</p>
      <p className="small subtle">Find work that depends on one person, then plan who covers it.</p>
    </header>
  );
}

/** Horizontal bar for the share one person holds. The text label carries the meaning; color only adds emphasis. */
export function ShareBar({ share, who, label }: { share: number; who: string; label?: string }) {
  const pctText = `${Math.round(share * 100)}%`;
  const level = share >= 0.7 ? 'high' : share >= 0.5 ? 'mid' : 'low';
  return (
    <div className="sharebar">
      <div className="track" role="img" aria-label={`${who} holds ${pctText} of the knowledge${label ? ` ${label}` : ''}`}>
        <div className={`fill ${level}`} style={{ width: `${Math.max(2, Math.min(100, Math.round(share * 100)))}%` }} />
      </div>
      <span className="small num" aria-hidden="true">{pctText} held by {shortName(who)}</span>
    </div>
  );
}

/** Link to the real Jira issue or Confluence page. Opens through the host so it works inside the iframe. */
export function ExternalLink({ url, children, label }: { url: string; children: ReactNode; label: string }) {
  return (
    <a
      className="extlink" href={url} target="_blank" rel="noopener noreferrer" aria-label={label}
      onClick={(ev) => { ev.preventDefault(); void openExternal(url); }}
    >
      {children}<span aria-hidden="true" className="ext-arrow"> ↗</span>
    </a>
  );
}
