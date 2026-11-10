export const DAY = 86_400_000;

// Absence dates are calendar days, not moments. They are stored as midnight UTC so the day a person picked is the day
// the server, the Jira comment and every viewer see, whatever their time zone.
export function toInputDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
export function fromInputDate(s: string): number {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
}
/** Today's calendar date in the viewer's own time zone, as a day value. */
export function todayDay(): number {
  const n = new Date();
  return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
}
export function fmtDate(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(ms));
}
export function fmtDateLong(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(ms));
}
export function fmtTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
}
export function plural(n: number, one: string, many = one + 's'): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}
/** Plain-language share. Exact numbers live only in the Why drawer. */
export function shareWords(share: number): string {
  if (share >= 0.9) return 'almost all';
  if (share >= 0.7) return 'most';
  if (share >= 0.5) return 'about half';
  return 'a large part';
}
export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

// Same recipe as engine/src/plan.ts stableKey; used so a changed cover person gets its own operation key.
function stableKey(input: string): string {
  const run = (seed: number) => {
    let h = seed >>> 0;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  };
  return run(0x811c9dc5) + run(0x9747b28c);
}
export function opKeyFor(planKey: string, itemId: string, personId: string): string {
  return `op_${stableKey(`${planKey}|${itemId}|${personId}`)}`;
}
