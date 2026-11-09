import { describe, expect, it } from 'vitest';
import { isBot } from '../src/botFilter';

describe('isBot', () => {
  it.each([
    'ASF GitHub Bot', 'Hudson', 'Jenkins CI', 'jira-bot', 'Automation for Jira',
    'dependabot[bot]', 'github-actions', 'Slack (app)', 'service-account-42',
  ])('flags %s', (n) => expect(isBot(n)).toBe(true));

  it.each(['Priya Nair', 'Abbott Smith', 'Botha Jones', 'Robert Hudsonville', 'Maya Cohen', ''])(
    'keeps %s',
    (n) => expect(isBot(n)).toBe(false),
  );

  it('handles missing names', () => {
    expect(isBot(undefined)).toBe(false);
    expect(isBot(null)).toBe(false);
  });
});
