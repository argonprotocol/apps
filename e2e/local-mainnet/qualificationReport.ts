import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import Path from 'node:path';
import { parseArgs } from 'node:util';
import type { AccountReviewResult } from './LocalMainnetReview.ts';
import type { StartingDatabaseRegistry } from './StartingDatabaseCapture.ts';

const { values } = parseArgs({ options: { directory: { type: 'string' } }, strict: true });
if (!values.directory)
  throw new Error('Usage: tsx e2e/local-mainnet/qualificationReport.ts --directory <run-directory>');
const directory = Path.resolve(values.directory);
mkdirSync(directory, { recursive: true });
const registryPath = Path.join(directory, 'capture/starting-databases.json');
const resultsPath = Path.join(directory, 'review/account-results.json');
const timingsPath = Path.join(directory, 'phase-timings.tsv');
const registry = existsSync(registryPath)
  ? (JSON.parse(readFileSync(registryPath, 'utf8')) as StartingDatabaseRegistry)
  : undefined;
const accounts = existsSync(resultsPath)
  ? (JSON.parse(readFileSync(resultsPath, 'utf8')) as AccountReviewResult[])
  : [];
const timings = existsSync(timingsPath)
  ? readFileSync(timingsPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [phase, seconds, exitCode] = line.split('\t');
        return { phase, seconds: Number(seconds), exitCode: Number(exitCode) };
      })
  : [];
const skipped =
  registry?.accounts
    .filter(account => !accounts.some(result => result.label === account.label))
    .map(account => ({
      label: account.label,
      reason: account.history.complete ? 'Candidate review did not complete' : 'Starting history is incomplete',
    })) ?? [];
const qualified =
  !!registry &&
  registry.coverage.complete &&
  registry.failures.length === 0 &&
  registry.accounts.length === registry.selection.selectedAccounts &&
  registry.coverage.completeHistoryAccounts === registry.selection.selectedAccounts &&
  registry.accounts.every(
    account =>
      account.history.complete && accounts.some(result => result.label === account.label && result.status === 'passed'),
  ) &&
  accounts.length === registry.accounts.length &&
  accounts.length > 0 &&
  accounts.every(account => account.status === 'passed') &&
  ['runtime-build', 'capture', 'review'].every(phase =>
    timings.some(timing => timing.phase === phase && timing.exitCode === 0),
  );
const report = {
  qualified,
  selection: registry?.selection,
  captureFailures: registry?.failures ?? [],
  accounts,
  skipped,
  timings,
};
writeFileSync(Path.join(directory, 'qualification-report.json'), `${JSON.stringify(report, null, 2)}\n`);
const summary = [
  `## Release qualification: ${qualified ? 'passed' : 'not qualified'}`,
  '',
  `Selected: ${registry?.selection.selectedAccounts ?? 'unknown'}; captured: ${registry?.accounts.length ?? 0}; reviewed: ${accounts.length}; passed: ${accounts.filter(account => account.status === 'passed').length}; skipped after capture: ${skipped.length}.`,
  '',
  '| Phase | Seconds | Exit code |',
  '| --- | ---: | ---: |',
  ...timings.map(timing => `| ${timing.phase} | ${timing.seconds} | ${timing.exitCode} |`),
  '',
  '| Account | Stage | Result | Detail |',
  '| --- | --- | --- | --- |',
  ...(registry?.failures ?? []).map(
    failure => `| ${failure.label} | Capture | Failed | ${failure.error.replace(/[\r\n|]/g, ' ')} |`,
  ),
  ...accounts.map(
    account =>
      `| ${account.label} | Review | ${account.status} | ${(account.error ?? `${Math.round(account.durationMs / 1000)}s`).replace(/[\r\n|]/g, ' ')} |`,
  ),
  ...skipped.map(account => `| ${account.label} | Review | Skipped | ${account.reason} |`),
  '',
].join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
if (!qualified) process.exitCode = 1;
