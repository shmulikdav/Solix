import type { TeamTemplate } from '@solix/shared';

/** Plain-language statement of what a template's routines will actually do —
 *  an interval routine launches a real agent session on a cadence and spends
 *  money on every run, which is easy to miss in a one-click install. */
export function describeRoutineCost(t: TeamTemplate): string {
  const interval = t.routines.filter((r) => (r.trigger ?? 'interval') === 'interval');
  const webhook = t.routines.filter((r) => r.trigger === 'webhook');
  const manual = t.routines.filter((r) => r.trigger === 'manual');
  const parts: string[] = [];
  if (interval.length) {
    const cadences = [...new Set(interval.map((r) => r.cadence ?? '1h'))].join(', ');
    parts.push(
      `${interval.length} runs automatically every ${cadences} — each run starts a real agent session and costs money.`,
    );
  }
  if (webhook.length) parts.push(`${webhook.length} fires only when its webhook URL is called.`);
  if (manual.length) parts.push(`${manual.length} runs only when you trigger it.`);
  return parts.join(' ');
}
