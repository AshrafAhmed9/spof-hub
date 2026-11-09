const BOT_PATTERNS: RegExp[] = [
  /\bbot\b/i, // "ASF GitHub Bot", "jira-bot", "build bot"
  /\[bot\]/i, // "dependabot[bot]"
  /\b(hudson|jenkins)\b/i,
  /\bautomation\b/i, // "Automation for Jira"
  /\b(dependabot|renovate|github-actions|travis|circleci)\b/i,
  /service[-_ ]?account/i,
  /\(app\)\s*$/i, // Atlassian app users
  /^app[-_ ]/i,
  /\bapp user\b/i,
];

/** True when a display name or id looks like an automated account. */
export function isBot(name: string | undefined | null): boolean {
  if (!name) return false;
  return BOT_PATTERNS.some((p) => p.test(name));
}
