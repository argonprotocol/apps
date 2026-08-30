import Fs from 'node:fs';
import Path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as Tar from 'tar';

const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 1_000;
const MAX_NESTED_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_NESTED_ARCHIVE_BYTES_TOTAL = 24 * 1024 * 1024;
const MAX_NESTING_DEPTH = 2;
const TAR_BLOCK_SIZE = 512;
const MAX_PAX_BYTES = 64 * 1024;
const image = 'node:26.8-alpine@sha256:2d984a15c9b54fd0aeb608b8e0d0d83529eb34d2966db27a1fb4f1edc3d298a3';
const tarModule = Path.resolve(Path.dirname(import.meta.filename), '../node_modules/tar');

type ArchiveEntry = {
  name: string;
  size: number;
  issues: string[];
  nestedEntries?: ArchiveEntry[];
};

type ArchiveInspection = {
  format: 'tar' | 'zip';
  entries: ArchiveEntry[];
};

type InspectionContext = {
  declaredUncompressedBytes: number;
  entryCount: number;
  nestedArchiveBytes: number;
};

class InspectionError extends Error {}

if (process.env.ARGON_TROUBLESHOOTING_ARCHIVE_INSPECTOR === '1') {
  queueMicrotask(() => void inspectArchive());
} else {
  runDockerInspector();
}

function runDockerInspector(): void {
  const archiveArgument = process.argv[2];
  if (!archiveArgument || process.argv.length !== 3) {
    throw new Error('Usage: yarn troubleshoot:inspect /path/to/troubleshooting.tar.gz');
  }

  const archive = Path.resolve(archiveArgument);
  const archiveStats = Fs.statSync(archive);
  if (!archiveStats.isFile()) {
    throw new Error(`Archive is not a file: ${archive}`);
  }

  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--init',
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '64',
      '--memory',
      '256m',
      '--memory-swap',
      '256m',
      '--cpus',
      '1',
      '--user',
      '65534:65534',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=32m',
      '--mount',
      `type=bind,src=${archive},dst=/input/archive,readonly`,
      '--mount',
      `type=bind,src=${import.meta.filename},dst=/opt/archive_inspector.ts,readonly`,
      '--mount',
      `type=bind,src=${tarModule},dst=/opt/node_modules/tar,readonly`,
      '--env',
      'ARGON_TROUBLESHOOTING_ARCHIVE_INSPECTOR=1',
      image,
      'node',
      '/opt/archive_inspector.ts',
      '/input/archive',
    ],
    { stdio: 'inherit' },
  );

  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

async function inspectArchive(): Promise<void> {
  try {
    if (process.argv.length !== 3) {
      throw new InspectionError('usage: inspectTroubleshootingArchive.ts /input/archive');
    }

    const archivePath = process.argv[2];
    const archiveSize = Fs.statSync(archivePath).size;
    if (archiveSize > MAX_ARCHIVE_BYTES) {
      throw new InspectionError(`archive is larger than ${MAX_ARCHIVE_BYTES} bytes`);
    }

    const context: InspectionContext = {
      declaredUncompressedBytes: 0,
      entryCount: 0,
      nestedArchiveBytes: 0,
    };
    const { format, entries } = await inspectArchivePath(archivePath, 0, context);
    const rejected = hasRejectedEntry(entries);
    console.log(`Format: ${format}`);
    console.log(`Entries: ${entries.length}`);
    console.log(`Declared uncompressed bytes: ${context.declaredUncompressedBytes}`);

    printEntries(entries);

    console.log('No archive contents were extracted to the host.');
    if (rejected) {
      console.log('The archive contains unsafe entries and must not be extracted outside the sandbox.');
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(`REJECTED: ${error instanceof Error ? error.message : String(error)}`);
    console.log('No archive contents were extracted to the host.');
    process.exitCode = 2;
  }
}

function isZipArchive(archivePath: string): boolean {
  const descriptor = Fs.openSync(archivePath, 'r');
  try {
    return archiveFormatFromContents(readAt(descriptor, 4, 0)) === 'zip';
  } finally {
    Fs.closeSync(descriptor);
  }
}

async function inspectArchivePath(
  archivePath: string,
  depth: number,
  context: InspectionContext,
): Promise<ArchiveInspection> {
  return isZipArchive(archivePath) ? inspectZip(archivePath, depth, context) : inspectTar(archivePath, depth, context);
}

async function inspectZip(archivePath: string, depth: number, context: InspectionContext): Promise<ArchiveInspection> {
  // @ts-expect-error ZipFile is an experimental Node 26.8 API used only in the Docker inspector.
  const { ZipFile } = await import('node:zlib');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Node 22 types do not expose the container-only API.
  const zip = ZipFile.openSync(archivePath);
  try {
    if (zip.size > MAX_ENTRIES) {
      throw new InspectionError(`archive has more than ${MAX_ENTRIES} entries`);
    }

    const entries: ArchiveEntry[] = [];
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Node 22 types do not expose the container-only API.
    for (const zipEntry of zip.valuesSync()) {
      if (isFinderMetadata(zipEntry.name)) continue;
      const entry = createEntry(zipEntry.name, zipEntry.size);
      inspectEntry(entry, zipEntry.isDirectory, !zipEntry.isDirectory, zipEntry.mode);
      if (zipEntry.isSymlink) {
        entry.issues.push('symbolic link');
      }
      if (zipEntry.size > MAX_ENTRY_BYTES) {
        entry.issues.push(`entry larger than ${MAX_ENTRY_BYTES} bytes`);
      }
      if (
        zipEntry.size > 0 &&
        (zipEntry.compressedSize === 0 || zipEntry.size / zipEntry.compressedSize > MAX_COMPRESSION_RATIO)
      ) {
        entry.issues.push(`compression ratio above ${MAX_COMPRESSION_RATIO}:1`);
      }
      registerEntry(entry, context);
      if (!zipEntry.isDirectory && !zipEntry.isSymlink) {
        if (zipEntry.flags & 1) {
          entry.issues.push('encrypted ZIP entries are not supported');
        } else if (zipEntry.method !== 0 && zipEntry.method !== 8) {
          entry.issues.push(`ZIP compression method ${zipEntry.method} is not supported`);
        } else if (zipEntry.size > MAX_ENTRY_BYTES) {
          if (isNestedArchiveName(zipEntry.name))
            entry.issues.push(`nested archive is larger than ${MAX_NESTED_ARCHIVE_BYTES} bytes`);
        } else {
          try {
            const contents = await readEntryPrefix(
              // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Node 22 types do not expose the container-only API.
              zipEntry.contentIterator({ maxSize: MAX_ENTRY_BYTES, verify: true }),
            );
            await inspectContents(entry, contents, depth, context);
          } catch (error) {
            entry.issues.push(
              `ZIP entry cannot be inspected: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
      entries.push(entry);
    }
    validateCollection(entries);
    return { format: 'zip', entries };
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Node 22 types do not expose the container-only API.
    zip.closeSync();
  }
}

async function inspectNestedArchive(
  entry: ArchiveEntry,
  contents: Buffer<ArrayBufferLike>,
  depth: number,
  context: InspectionContext,
): Promise<void> {
  if (depth >= MAX_NESTING_DEPTH) {
    entry.issues.push(`nested archive exceeds maximum depth of ${MAX_NESTING_DEPTH}`);
    return;
  }
  if (context.nestedArchiveBytes + contents.length > MAX_NESTED_ARCHIVE_BYTES_TOTAL) {
    entry.issues.push(`nested archives exceed ${MAX_NESTED_ARCHIVE_BYTES_TOTAL} bytes in total`);
    return;
  }

  context.nestedArchiveBytes += contents.length;
  const directory = Fs.mkdtempSync('/tmp/argon-troubleshooting-archive-');
  const archivePath = Path.join(directory, 'archive');
  try {
    Fs.writeFileSync(archivePath, contents);
    const nestedInspection = await inspectArchivePath(archivePath, depth + 1, context);
    entry.nestedEntries = nestedInspection.entries;
    if (hasRejectedEntry(nestedInspection.entries)) {
      entry.issues.push('unsafe nested archive');
    }
  } catch (error) {
    entry.issues.push(`nested archive cannot be inspected: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    Fs.rmSync(directory, { recursive: true, force: true });
  }
}

function archiveFormatFromContents(contents: Buffer<ArrayBufferLike>): 'tar' | 'zip' | undefined {
  if (
    contents.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ||
    contents.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  ) {
    return 'zip';
  }
  if (contents.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))) return 'tar';
  if (contents.length >= TAR_BLOCK_SIZE) {
    try {
      return new Tar.Header(contents.subarray(0, TAR_BLOCK_SIZE)).cksumValid ? 'tar' : undefined;
    } catch {
      // The bytes are not a TAR header.
    }
  }
  return undefined;
}

function isNestedArchiveName(name: string): boolean {
  const lowerCaseName = name.toLowerCase();
  return (
    lowerCaseName.endsWith('.tar') ||
    lowerCaseName.endsWith('.tar.gz') ||
    lowerCaseName.endsWith('.tgz') ||
    lowerCaseName.endsWith('.zip')
  );
}

function hasRejectedEntry(entries: ArchiveEntry[]): boolean {
  return entries.some(entry => entry.issues.length > 0 || hasRejectedEntry(entry.nestedEntries ?? []));
}

function printEntries(entries: ArchiveEntry[], prefix = ''): void {
  for (const entry of entries) {
    const status = entry.issues.length > 0 ? 'REJECTED' : 'SAFE';
    const details = entry.issues;
    const suffix = details.length > 0 ? ` (${details.join('; ')})` : '';
    const qualifiedName = `${prefix}${entry.name}`;
    console.log(`${status}: ${JSON.stringify(qualifiedName)} (${entry.size} bytes)${suffix}`);
    printEntries(entry.nestedEntries ?? [], `${qualifiedName}!/`);
  }
}

async function inspectTar(archivePath: string, depth: number, context: InspectionContext): Promise<ArchiveInspection> {
  const entries: ArchiveEntry[] = [];
  const parser = new Tar.Parser({
    strict: true,
    maxMetaEntrySize: MAX_PAX_BYTES,
    maxDecompressionRatio: MAX_COMPRESSION_RATIO,
    brotli: false,
    zstd: false,
  });
  const source = Fs.createReadStream(archivePath);
  const inspections: Promise<void>[] = [];
  parser.on('entry', (tarEntry: Tar.ReadEntry) => {
    const inspection = inspectTarEntry(tarEntry, entries, depth, context);
    inspections.push(inspection);
    void inspection.catch(error => parser.abort(error instanceof Error ? error : new InspectionError(String(error))));
  });
  parser.on('ignoredEntry', (tarEntry: Tar.ReadEntry) => {
    if (tarEntry.meta) {
      parser.abort(new InspectionError(`PAX header is larger than ${MAX_PAX_BYTES} bytes`));
      return;
    }
    const entry = createEntry(tarEntry.path, tarEntry.size);
    inspectEntry(entry, false, false, tarEntry.mode ?? 0);
    entry.issues.push('non-regular archive entry');
    registerEntry(entry, context);
    entries.push(entry);
  });
  const parsed = new Promise<void>((resolve, reject) => {
    parser.once('end', resolve);
    parser.once('error', reject);
    source.once('error', reject);
  });

  source.pipe(parser);
  await parsed;
  await Promise.all(inspections);
  validateCollection(entries);
  return { format: 'tar', entries };
}

async function inspectTarEntry(
  tarEntry: Tar.ReadEntry,
  entries: ArchiveEntry[],
  depth: number,
  context: InspectionContext,
): Promise<void> {
  if (!Number.isSafeInteger(tarEntry.size) || tarEntry.size < 0) {
    throw new InspectionError('TAR size exceeds the supported range');
  }
  if (isFinderMetadata(tarEntry.path)) {
    await readEntryPrefix(tarEntry);
    return;
  }

  const isDirectory = tarEntry.type === 'Directory';
  const isRegular = tarEntry.type === 'File' || tarEntry.type === 'OldFile' || tarEntry.type === 'ContiguousFile';
  const entry = createEntry(tarEntry.path, tarEntry.size);
  inspectEntry(entry, isDirectory, isRegular, tarEntry.mode ?? 0);
  if (tarEntry.type === 'Link' || tarEntry.type === 'SymbolicLink') {
    entry.issues.push('link');
  } else if (!isDirectory && !isRegular) {
    entry.issues.push('non-regular archive entry');
  }
  if (tarEntry.size > MAX_ENTRY_BYTES) {
    entry.issues.push(`entry larger than ${MAX_ENTRY_BYTES} bytes`);
  }
  registerEntry(entry, context);

  const contents = await readEntryPrefix(tarEntry, isRegular ? MAX_NESTED_ARCHIVE_BYTES : 0);
  if (isRegular) await inspectContents(entry, contents, depth, context);
  entries.push(entry);
}

async function inspectContents(
  entry: ArchiveEntry,
  contents: Buffer<ArrayBufferLike>,
  depth: number,
  context: InspectionContext,
): Promise<void> {
  if (hasExecutableSignature(contents)) entry.issues.push('executable file signature');

  if (archiveFormatFromContents(contents)) {
    if (entry.size > MAX_NESTED_ARCHIVE_BYTES) {
      entry.issues.push(`nested archive is larger than ${MAX_NESTED_ARCHIVE_BYTES} bytes`);
    } else {
      await inspectNestedArchive(entry, contents, depth, context);
    }
  } else if (isNestedArchiveName(entry.name)) {
    entry.issues.push('nested archive has an unsupported format');
  }
}

async function readEntryPrefix(source: AsyncIterable<Buffer>, maxBytes = MAX_NESTED_ARCHIVE_BYTES): Promise<Buffer> {
  const prefixChunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of source) {
    const remaining = maxBytes - length;
    if (remaining <= 0) continue;
    const prefix = chunk.subarray(0, remaining);
    prefixChunks.push(prefix);
    length += prefix.length;
  }
  return Buffer.concat(prefixChunks, length);
}

function createEntry(name: string, size: number): ArchiveEntry {
  return { name, size, issues: [] };
}

function inspectEntry(entry: ArchiveEntry, isDirectory: boolean, isRegular: boolean, mode: number): void {
  const normalized = normalizePath(entry.name);
  if (normalized === undefined) {
    entry.issues.push('unsafe path');
  }
  if (isRegular && !isDirectory && hasExecutableNameOrMode(entry.name, mode)) {
    entry.issues.push('executable entry');
  }
}

function registerEntry(entry: ArchiveEntry, context: InspectionContext): void {
  context.entryCount += 1;
  if (context.entryCount > MAX_ENTRIES) {
    throw new InspectionError(`archive has more than ${MAX_ENTRIES} entries`);
  }
  context.declaredUncompressedBytes += entry.size;
  if (context.declaredUncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
    throw new InspectionError(`archive declares more than ${MAX_UNCOMPRESSED_BYTES} uncompressed bytes`);
  }
}

function validateCollection(entries: ArchiveEntry[]): void {
  const names = new Set<string>();
  for (const entry of entries) {
    const normalized = normalizePath(entry.name);
    if (!normalized) continue;
    if (names.has(normalized)) entry.issues.push('duplicate destination path');
    names.add(normalized);
  }
}

function normalizePath(name: string): string | undefined {
  if (!name || name.includes('\0') || name.includes('\r') || name.includes('\n')) return undefined;
  const portable = name.replaceAll('\\', '/');
  if (portable.startsWith('/') || /^[A-Za-z]:/.test(portable)) return undefined;

  const parts: string[] = [];
  for (const part of portable.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return undefined;
    parts.push(part);
  }
  return parts.length > 0 ? parts.join('/') : undefined;
}

function isFinderMetadata(name: string): boolean {
  const normalized = normalizePath(name);
  if (!normalized) return false;
  const parts = normalized.split('/');
  return parts[0] === '__MACOSX' && parts.at(-1)!.startsWith('._');
}

function hasExecutableSignature(contents: Buffer<ArrayBufferLike>): boolean {
  return (
    contents.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    hasPortableExecutableSignature(contents) ||
    [
      [0xfe, 0xed, 0xfa, 0xce],
      [0xce, 0xfa, 0xed, 0xfe],
      [0xfe, 0xed, 0xfa, 0xcf],
      [0xcf, 0xfa, 0xed, 0xfe],
      [0xca, 0xfe, 0xba, 0xbe],
      [0xbe, 0xba, 0xfe, 0xca],
      [0xca, 0xfe, 0xba, 0xbf],
      [0xbf, 0xba, 0xfe, 0xca],
    ].some(signature => contents.subarray(0, signature.length).equals(Buffer.from(signature))) ||
    contents.subarray(0, 2).equals(Buffer.from('#!'))
  );
}

function hasPortableExecutableSignature(contents: Buffer<ArrayBufferLike>): boolean {
  if (!contents.subarray(0, 2).equals(Buffer.from('MZ')) || contents.length < 0x40) return false;
  const headerOffset = contents.readUInt32LE(0x3c);
  return (
    headerOffset <= contents.length - 4 &&
    contents.subarray(headerOffset, headerOffset + 4).equals(Buffer.from('PE\0\0'))
  );
}

function hasExecutableNameOrMode(name: string, mode: number): boolean {
  return (
    Boolean(mode & 0o111) ||
    ['.app', '.bat', '.cmd', '.com', '.dll', '.exe', '.msi', '.sh'].includes(Path.posix.extname(name).toLowerCase())
  );
}

function readAt(descriptor: number, length: number, position: number): Buffer {
  const buffer = Buffer.alloc(length);
  const bytesRead = Fs.readSync(descriptor, buffer, 0, length, position);
  if (bytesRead !== length) throw new InspectionError('archive ended unexpectedly');
  return buffer;
}
