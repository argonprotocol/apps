import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import type { ChildProcess } from 'node:child_process';

const MAX_LINES = 600;
const DEFAULT_TAIL_LINES = 120;

export type AppLogsMode = 'inherit' | 'quiet';

export class AppProcessOutput {
  public readonly logFilePath?: string;
  private readonly lines: string[] = [];
  private lastOutputAtMs: number | null = null;
  private lastOutputLine?: string;
  private pendingStdout = '';
  private pendingStderr = '';
  private stream?: WriteStream;

  constructor(
    private readonly logsMode: AppLogsMode,
    sessionName: string,
  ) {
    this.logFilePath = logsMode === 'quiet' ? AppProcessOutput.createLogPath(sessionName) : undefined;
    this.stream = this.logFilePath ? AppProcessOutput.createStream(this.logFilePath) : undefined;
  }

  public attach(child: ChildProcess): void {
    if (this.logsMode !== 'quiet') return;
    this.attachStream(child.stdout, 'stdout');
    this.attachStream(child.stderr, 'stderr');
  }

  public printTail(reason: string, lineLimit = DEFAULT_TAIL_LINES): void {
    if (this.logsMode !== 'quiet') return;
    const tail = this.collectTail(lineLimit);
    if (tail.length === 0) return;
    console.error(`[E2E] Recent app output (${reason}):`);
    if (this.logFilePath) console.error(`[E2E] Full app output log: ${this.logFilePath}`);
    for (const line of tail) console.error(`[E2E] ${line}`);
  }

  public summarizeStartup(): { lastOutputAgeMs: number | null; lastOutputLine: string | null; stage: string } {
    const tail = this.collectTail(20);
    const joinedTail = tail.join('\n');
    const lastOutputLine = this.lastOutputLine ?? tail.at(-1) ?? null;
    const lastOutputAgeMs = this.lastOutputAtMs == null ? null : Date.now() - this.lastOutputAtMs;

    let stage = 'no-app-output';
    if (lastOutputLine?.includes('Waiting for bootstrap archive client')) {
      stage = 'ethereum-bootstrap-archive';
    } else if (
      lastOutputLine?.includes('Still waiting for finalized beacon execution') ||
      lastOutputLine?.includes('Waiting for finalized beacon execution block >=')
    ) {
      stage = 'ethereum-bootstrap-finality';
    } else if (lastOutputLine?.includes('Requesting beacon bootstrap transaction')) {
      stage = 'ethereum-bootstrap-tx-build';
    } else if (
      lastOutputLine?.includes('Submitting beacon bootstrap sudo transaction') ||
      lastOutputLine?.includes('Waiting for beacon bootstrap transaction to enter a block')
    ) {
      stage = 'ethereum-bootstrap-submit';
    } else if (lastOutputLine?.includes('deploying the local Ethereum gateway fixture')) {
      stage = 'ethereum-gateway-deploy';
    } else if (lastOutputLine?.includes('configuring the local Ethereum gateway on Argon')) {
      stage = 'ethereum-chain-config';
    } else if (lastOutputLine?.includes('syncing the Ethereum gateway council to Argon')) {
      stage = 'ethereum-council-sync';
    } else if (lastOutputLine?.includes('activating the upstream Ethereum relay')) {
      stage = 'ethereum-relayer-start';
    } else if (joinedTail.includes('bootstrapping the Ethereum verifier on Argon')) {
      stage = 'ethereum-bootstrap';
    } else if (joinedTail.includes('[tauri-dev] Starting Tauri dev')) {
      stage = 'tauri-dev-start';
    } else if (joinedTail.includes('[tauri-dev] Enabling e2e features')) {
      stage = 'tauri-dev-e2e';
    } else if (joinedTail.includes('Failed to finish local Ethereum setup')) {
      stage = 'ethereum-setup-error';
    } else if (joinedTail.includes('Failed to start:')) {
      stage = 'startup-error';
    } else if (tail.length > 0) {
      stage = 'startup-in-progress';
    }

    return { lastOutputAgeMs, lastOutputLine, stage };
  }

  public close(): void {
    if (!this.stream) return;
    this.flushPending();
    this.stream.end();
    this.stream = undefined;
  }

  private attachStream(stream: NodeJS.ReadableStream | null, source: 'stdout' | 'stderr'): void {
    if (!stream) return;
    if (typeof (stream as { setEncoding?: (encoding: string) => void }).setEncoding === 'function') {
      (stream as { setEncoding: (encoding: string) => void }).setEncoding('utf8');
    }
    stream.on('data', chunk => this.append(source, String(chunk ?? '')));
  }

  private append(source: 'stdout' | 'stderr', rawChunk: string): void {
    if (!rawChunk) return;
    const normalizedChunk = rawChunk.replace(/\r\n?/g, '\n');
    const previous = source === 'stdout' ? this.pendingStdout : this.pendingStderr;
    const lines = `${previous}${normalizedChunk}`.split('\n');
    const trailing = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) this.push(`[${source}] ${line}`);
    }
    if (source === 'stdout') this.pendingStdout = trailing;
    else this.pendingStderr = trailing;
  }

  private push(line: string): void {
    this.lines.push(line);
    this.lastOutputAtMs = Date.now();
    this.lastOutputLine = line;
    this.stream?.write(`${line}\n`);
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
  }

  private collectTail(lineLimit: number): string[] {
    const lines = [...this.lines];
    if (this.pendingStdout.trim()) lines.push(`[stdout] ${this.pendingStdout.trimEnd()}`);
    if (this.pendingStderr.trim()) lines.push(`[stderr] ${this.pendingStderr.trimEnd()}`);
    return lines.length <= lineLimit ? lines : lines.slice(-lineLimit);
  }

  private flushPending(): void {
    if (this.pendingStdout.trim()) {
      this.push(`[stdout] ${this.pendingStdout.trimEnd()}`);
      this.pendingStdout = '';
    }
    if (this.pendingStderr.trim()) {
      this.push(`[stderr] ${this.pendingStderr.trimEnd()}`);
      this.pendingStderr = '';
    }
  }

  private static createLogPath(sessionName: string): string {
    const rootDir = process.env.CI_TEMP_DIR?.trim() || os.tmpdir();
    const safeSessionName = sessionName.replace(/[^a-zA-Z0-9._-]+/g, '-');
    return Path.join(rootDir, `e2e-app-output-${safeSessionName}.log`);
  }

  private static createStream(logFilePath: string): WriteStream | undefined {
    try {
      mkdirSync(Path.dirname(logFilePath), { recursive: true });
      return createWriteStream(logFilePath, { flags: 'a' });
    } catch (error) {
      console.warn(`[E2E] Failed to open app output log ${logFilePath}: ${(error as Error).message}`);
      return undefined;
    }
  }
}
