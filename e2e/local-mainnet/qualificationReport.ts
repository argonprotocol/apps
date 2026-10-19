import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import Path from 'node:path';
import { parseArgs } from 'node:util';
import type { AccountReviewResult } from './LocalMainnetReview.ts';
import type { StartingDatabaseRegistry } from './StartingDatabaseCapture.ts';
import { isStartingDatabaseComplete } from './StartingDatabaseInspection.ts';

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
  registry?.accounts.filter(account => !accounts.some(result => result.label === account.label)).length ?? 0;
const qualified =
  !!registry &&
  registry.coverage.complete &&
  registry.failures.length === 0 &&
  registry.accounts.length === registry.selection.selectedAccounts &&
  registry.accounts.every(account =>
    accounts.some(
      result =>
        result.label === account.label &&
        result.status === 'passed' &&
        result.history &&
        result.history.throughBlock > registry.throughBlock &&
        isStartingDatabaseComplete(result.history, result.history.throughBlock) &&
        result.history.expectedBitcoinFissionIds &&
        result.history.bitcoinFissionIds &&
        result.history.expectedBitcoinFissionIds.every(id => result.history!.bitcoinFissionIds.includes(id)),
    ),
  ) &&
  accounts.length === registry.accounts.length &&
  accounts.length > 0 &&
  accounts.every(account => account.status === 'passed') &&
  ['runtime-build', 'capture', 'review'].every(phase =>
    timings.some(timing => timing.phase === phase && timing.exitCode === 0),
  );

const captureFailures = (registry?.failures ?? []).map((failure, index) => ({
  phase: 'capture',
  scenario: index + 1,
  stage: 'source capture',
  reason: describeFailure(failure.error),
}));
const reviewFailures = accounts
  .filter(account => account.status === 'failed')
  .map((account, index) => ({
    phase: 'review',
    scenario: index + 1,
    stage: account.stage ?? 'candidate review',
    reason: describeFailure(account.error),
    durationMs: account.durationMs,
  }));
const report = {
  qualified,
  selection: registry?.selection,
  captured: registry?.accounts.length ?? 0,
  captureFailures: registry?.failures.length ?? 0,
  incompleteStartingHistories: registry?.accounts.filter(account => !account.history.complete).length ?? 0,
  reviewed: accounts.length,
  passed: accounts.filter(account => account.status === 'passed').length,
  failed: accounts.filter(account => account.status === 'failed').length,
  skipped,
  timings,
  failures: [...captureFailures, ...reviewFailures],
};
writeFileSync(Path.join(directory, 'qualification-report.json'), `${JSON.stringify(report, null, 2)}\n`);
const summaryLines = [
  `## Release qualification: ${qualified ? 'passed' : 'not qualified'}`,
  '',
  `Selected: ${registry?.selection.selectedAccounts ?? 'unknown'}; captured: ${report.captured}; capture failures: ${report.captureFailures}; incomplete starting histories: ${report.incompleteStartingHistories}; reviewed: ${report.reviewed}; passed: ${report.passed}; failed: ${report.failed}; skipped after capture: ${report.skipped}.`,
  '',
  '| Phase | Seconds | Exit code |',
  '| --- | ---: | ---: |',
  ...timings.map(timing => `| ${timing.phase} | ${timing.seconds} | ${timing.exitCode} |`),
  '',
];
if (report.failures.length) {
  summaryLines.push(
    '| Failed phase | Scenario | Stage | Reason |',
    '| --- | ---: | --- | --- |',
    ...report.failures.map(
      failure => `| ${failure.phase} | ${failure.scenario} | ${failure.stage} | ${failure.reason} |`,
    ),
    '',
  );
}
const summary = summaryLines.join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
if (!qualified) process.exitCode = 1;

function describeFailure(error = ''): string {
  // Publish fixed descriptions, never exception text containing account data.
  if (/Account recovery (changed semantic state|database fingerprint changed)/.test(error)) {
    return 'Recovery changed previously published state.';
  }
  if (/checksum mismatch|integrity check|quick check/i.test(error)) {
    return 'Database integrity verification failed.';
  }
  if (/incomplete history|missing Bitcoin history records|missing creation event/i.test(error)) {
    return 'Required history is incomplete.';
  }
  if (/timed out|timeout|stalled/i.test(error)) {
    return 'Operation timed out or stopped progressing.';
  }
  return 'Stage failed; raw details were retained only on the runner.';
}
