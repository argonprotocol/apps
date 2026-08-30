import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import Path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import * as tar from 'tar';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('troubleshooting archive inspector', () => {
  it('reports a support bundle without extracting files on the host', async () => {
    const directory = await temporaryDirectory();
    const source = Path.join(directory, 'source');
    const archive = Path.join(directory, 'support.tar.gz');
    await mkdir(Path.join(source, 'logs'), { recursive: true });
    await writeFile(Path.join(source, 'logs', 'argon.log'), 'diagnostic output\n');
    await tar.create({ cwd: source, file: archive, gzip: true }, ['logs/argon.log']);

    const output = execFileSync('yarn', ['troubleshoot:inspect', archive], { encoding: 'utf8' });

    expect(output).toContain('logs/argon.log');
    expect(output).toContain('No archive contents were extracted to the host.');
    expect((await readdir(directory)).sort()).toEqual(['source', 'support.tar.gz']);
  });

  it('reports TAR and TGZ bundles without extracting them on the host', async () => {
    const directory = await temporaryDirectory();
    const source = Path.join(directory, 'source');
    const tarArchive = Path.join(directory, 'support.tar');
    const tgzArchive = Path.join(directory, 'support.tgz');
    await mkdir(Path.join(source, 'logs'), { recursive: true });
    await writeFile(Path.join(source, 'logs', 'argon.log'), 'diagnostic output\n');
    await tar.create({ cwd: source, file: tarArchive }, ['logs/argon.log']);
    await tar.create({ cwd: source, file: tgzArchive, gzip: true }, ['logs/argon.log']);

    const tarOutput = execFileSync('yarn', ['troubleshoot:inspect', tarArchive], { encoding: 'utf8' });
    const tgzOutput = execFileSync('yarn', ['troubleshoot:inspect', tgzArchive], { encoding: 'utf8' });

    expect(tarOutput).toContain('Format: tar');
    expect(tgzOutput).toContain('Format: tar');
    expect((await readdir(directory)).sort()).toEqual(['source', 'support.tar', 'support.tgz']);
  }, 20_000);

  it('accepts PAX TAR bundles without extracting them on the host', async () => {
    const directory = await temporaryDirectory();
    const source = Path.join(directory, 'source');
    const archive = Path.join(directory, 'support.tar.gz');
    await mkdir(Path.join(source, 'logs'), { recursive: true });
    await writeFile(Path.join(source, 'logs', 'argon.log'), 'diagnostic output\n');
    execFileSync('tar', ['--format', 'pax', '-czf', archive, '-C', source, 'logs/argon.log']);

    const output = execFileSync('yarn', ['troubleshoot:inspect', archive], { encoding: 'utf8' });

    expect(output).toContain('SAFE: "logs/argon.log"');
    expect(output).not.toContain('PaxHeader');
    expect((await readdir(directory)).sort()).toEqual(['source', 'support.tar.gz']);
  });

  it('reports GNU long-path TAR bundles without extracting them on the host', async () => {
    const directory = await temporaryDirectory();
    const source = Path.join(directory, 'source');
    const archive = Path.join(directory, 'support.tar.gz');
    const longPath = `logs/${'a'.repeat(128)}.log`;
    await mkdir(Path.join(source, 'logs'), { recursive: true });
    await writeFile(Path.join(source, longPath), 'diagnostic output\n');
    execFileSync(process.platform === 'darwin' ? 'gtar' : 'tar', [
      '--format=gnu',
      '-czf',
      archive,
      '-C',
      source,
      longPath,
    ]);

    const output = execFileSync('yarn', ['troubleshoot:inspect', archive], { encoding: 'utf8' });

    expect(output).toContain(`SAFE: "${longPath}"`);
    expect(output).not.toContain('LongLink');
    expect((await readdir(directory)).sort()).toEqual(['source', 'support.tar.gz']);
  });

  it('rejects executable files before they can be extracted', async () => {
    const directory = await temporaryDirectory();
    const source = Path.join(directory, 'source');
    const archive = Path.join(directory, 'support.tar.gz');
    await mkdir(source, { recursive: true });
    await writeFile(Path.join(source, 'diagnostic-tool'), 'not run\n');
    await chmod(Path.join(source, 'diagnostic-tool'), 0o755);
    await tar.create({ cwd: source, file: archive, gzip: true }, ['diagnostic-tool']);

    const result = spawnSync('yarn', ['troubleshoot:inspect', archive], { encoding: 'utf8' });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('executable entry');
    expect((await readdir(directory)).sort()).toEqual(['source', 'support.tar.gz']);
  });

  it('rejects an unsafe TAR archive nested in a TAR support bundle', async () => {
    const directory = await temporaryDirectory();
    const source = Path.join(directory, 'source');
    const nestedSource = Path.join(source, 'nested-source');
    const nestedArchive = Path.join(source, 'attachments', 'diagnostics.tgz');
    const archive = Path.join(directory, 'support.tar.gz');
    await mkdir(Path.join(source, 'attachments'), { recursive: true });
    await mkdir(nestedSource, { recursive: true });
    await writeFile(Path.join(nestedSource, 'diagnostic-tool'), 'not run\n');
    await chmod(Path.join(nestedSource, 'diagnostic-tool'), 0o755);
    await tar.create({ cwd: nestedSource, file: nestedArchive, gzip: true }, ['diagnostic-tool']);
    await tar.create({ cwd: source, file: archive, gzip: true }, ['attachments/diagnostics.tgz']);

    const result = spawnSync('yarn', ['troubleshoot:inspect', archive], { encoding: 'utf8' });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('unsafe nested archive');
    expect(result.stdout).toContain('attachments/diagnostics.tgz!/diagnostic-tool');
    expect((await readdir(directory)).sort()).toEqual(['source', 'support.tar.gz']);
  });

  it('rejects an unsafe TAR archive nested in a ZIP support bundle', async () => {
    const directory = await temporaryDirectory();
    const source = Path.join(directory, 'source');
    const nestedArchive = Path.join(source, 'diagnostics.tar');
    const archive = Path.join(directory, 'support.zip');
    await mkdir(source, { recursive: true });
    await writeFile(Path.join(source, 'diagnostic-tool'), 'not run\n');
    await chmod(Path.join(source, 'diagnostic-tool'), 0o755);
    await tar.create({ cwd: source, file: nestedArchive }, ['diagnostic-tool']);
    await createZip(archive, 'attachments/diagnostics.tar', await readFile(nestedArchive), { deflate: true });

    const result = spawnSync('yarn', ['troubleshoot:inspect', archive], { encoding: 'utf8' });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('unsafe nested archive');
    expect(result.stdout).toContain('attachments/diagnostics.tar!/diagnostic-tool');
    expect((await readdir(directory)).sort()).toEqual(['source', 'support.zip']);
  });

  it('rejects an unsafe extensionless ZIP archive nested in a TAR support bundle', async () => {
    const directory = await temporaryDirectory();
    const source = Path.join(directory, 'source');
    const nestedArchive = Path.join(source, 'attachments', 'diagnostics');
    const archive = Path.join(directory, 'support.tar');
    await mkdir(Path.join(source, 'attachments'), { recursive: true });
    await createZip(nestedArchive, '../outside.log', 'not extracted\n');
    await tar.create({ cwd: source, file: archive }, ['attachments/diagnostics']);

    const result = spawnSync('yarn', ['troubleshoot:inspect', archive], { encoding: 'utf8' });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('attachments/diagnostics!/../outside.log');
    expect(result.stdout).toContain('unsafe nested archive');
    expect((await readdir(directory)).sort()).toEqual(['source', 'support.tar']);
  });

  it('rejects a third embedded archive layer', async () => {
    const directory = await temporaryDirectory();
    const source = Path.join(directory, 'source');
    const terminalSource = Path.join(source, 'terminal-source');
    const secondSource = Path.join(source, 'second-source');
    const firstSource = Path.join(source, 'first-source');
    const terminalArchive = Path.join(source, 'terminal.tar');
    const secondArchive = Path.join(source, 'second.tar');
    const firstArchive = Path.join(source, 'first.tar');
    const archive = Path.join(directory, 'support.tar');
    await mkdir(terminalSource, { recursive: true });
    await mkdir(secondSource, { recursive: true });
    await mkdir(firstSource, { recursive: true });
    await writeFile(Path.join(terminalSource, 'argon.log'), 'diagnostic output\n');
    await tar.create({ cwd: terminalSource, file: terminalArchive }, ['argon.log']);
    await writeFile(Path.join(secondSource, 'terminal.tar'), await readFile(terminalArchive));
    await tar.create({ cwd: secondSource, file: secondArchive }, ['terminal.tar']);
    await writeFile(Path.join(firstSource, 'second.tar'), await readFile(secondArchive));
    await tar.create({ cwd: firstSource, file: firstArchive }, ['second.tar']);
    await tar.create({ cwd: source, file: archive }, ['first.tar']);

    const result = spawnSync('yarn', ['troubleshoot:inspect', archive], { encoding: 'utf8' });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('first.tar!/second.tar!/terminal.tar');
    expect(result.stdout).toContain('maximum depth of 2');
    expect((await readdir(directory)).sort()).toEqual(['source', 'support.tar']);
  });

  it('reports nested database diagnostics without extracting them on the host', async () => {
    const directory = await temporaryDirectory();
    const source = Path.join(directory, 'source');
    const nestedSource = Path.join(source, 'nested-source');
    const nestedArchive = Path.join(source, 'server', 'support.tar.gz');
    const archive = Path.join(directory, 'support.zip');
    await mkdir(Path.join(source, 'server'), { recursive: true });
    await mkdir(Path.join(nestedSource, 'data', 'argon'), { recursive: true });
    await writeFile(Path.join(nestedSource, 'data', 'argon', 'vault.sqlite'), 'not inspected\n');
    await tar.create({ cwd: nestedSource, file: nestedArchive, gzip: true }, ['data/argon/vault.sqlite']);
    await createZip(archive, 'server/support.tar.gz', await readFile(nestedArchive), { deflate: true });

    const result = spawnSync('yarn', ['troubleshoot:inspect', archive], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('SAFE: "server/support.tar.gz!/data/argon/vault.sqlite"');
    expect((await readdir(directory)).sort()).toEqual(['source', 'support.zip']);
  });

  it('reports expected database backup files in troubleshooting ZIPs as safe', async () => {
    const directory = await temporaryDirectory();
    const source = Path.join(directory, 'source');
    const archive = Path.join(directory, 'support.zip');
    await mkdir(Path.join(source, 'data', 'database-backups', '1.5.0'), { recursive: true });
    await writeFile(Path.join(source, 'data', 'database.sqlite'), 'current database\n');
    await writeFile(Path.join(source, 'data', 'database-backups', '1.5.0', 'database.sqlite'), 'database backup\n');
    execFileSync('zip', ['-q', '-r', archive, 'data'], { cwd: source });

    const output = execFileSync('yarn', ['troubleshoot:inspect', archive], { encoding: 'utf8' });

    expect(output).toContain('SAFE: "data/database.sqlite"');
    expect(output).toContain('SAFE: "data/database-backups/1.5.0/database.sqlite"');
    expect(output).not.toContain('QUARANTINED: "data/database');
    expect((await readdir(directory)).sort()).toEqual(['source', 'support.zip']);
  });

  it('ignores Finder metadata instead of treating it as an executable', async () => {
    const directory = await temporaryDirectory();
    const archive = Path.join(directory, 'support.zip');
    await createZip(archive, '__MACOSX/troubleshooting/._logs', 'Finder metadata\n', { mode: 0o100755 });

    const result = spawnSync('yarn', ['troubleshoot:inspect', archive], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('REJECTED');
    expect(result.stdout).not.toContain('__MACOSX');
    expect((await readdir(directory)).sort()).toEqual(['support.zip']);
  });

  it('rejects an ELF binary disguised as a diagnostic log', async () => {
    const directory = await temporaryDirectory();
    const archive = Path.join(directory, 'support.zip');
    await createZip(archive, 'logs/mainnet-default.log', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]));

    const result = spawnSync('yarn', ['troubleshoot:inspect', archive], { encoding: 'utf8' });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('executable file signature');
    expect((await readdir(directory)).sort()).toEqual(['support.zip']);
  });

  it('rejects a non-runnable PE header disguised as a database', async () => {
    const directory = await temporaryDirectory();
    const archive = Path.join(directory, 'support.zip');
    const contents = Buffer.alloc(0x88);
    contents.write('MZ');
    contents.writeUInt32LE(0x80, 0x3c);
    contents.write('PE\0\0', 0x80);
    await createZip(archive, 'data/database.sqlite', contents);

    const result = spawnSync('yarn', ['troubleshoot:inspect', archive], { encoding: 'utf8' });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('REJECTED: "data/database.sqlite"');
    expect(result.stdout).toContain('executable file signature');
    expect((await readdir(directory)).sort()).toEqual(['support.zip']);
  });

  it('reports ZIP bundles without extracting them on the host', async () => {
    const directory = await temporaryDirectory();
    const archive = Path.join(directory, 'support.zip');
    await createZip(archive, 'logs/argon.log', 'diagnostic output\n');

    const output = execFileSync('yarn', ['troubleshoot:inspect', archive], { encoding: 'utf8' });

    expect(output).toContain('Format: zip');
    expect(output).toContain('logs/argon.log');
    expect((await readdir(directory)).sort()).toEqual(['support.zip']);
  });

  it('reports safe ZIP64 bundles without extracting them on the host', async () => {
    const directory = await temporaryDirectory();
    const source = Path.join(directory, 'source');
    const archive = Path.join(directory, 'support.zip');
    await mkdir(Path.join(source, 'logs'), { recursive: true });
    await writeFile(Path.join(source, 'logs', 'argon.log'), 'diagnostic output\n');
    execFileSync('zip', ['-fz', archive, 'logs/argon.log'], { cwd: source });
    expect((await readFile(archive)).includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(true);

    const output = execFileSync('yarn', ['troubleshoot:inspect', archive], { encoding: 'utf8' });

    expect(output).toContain('Format: zip');
    expect(output).toContain('SAFE: "logs/argon.log"');
    expect((await readdir(directory)).sort()).toEqual(['source', 'support.zip']);
  });

  it('rejects traversal paths before they reach the host', async () => {
    const directory = await temporaryDirectory();
    const archive = Path.join(directory, 'support.zip');
    await createZip(archive, '../outside.log', 'not extracted\n');

    const result = spawnSync('yarn', ['troubleshoot:inspect', archive], { encoding: 'utf8' });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('unsafe path');
    expect((await readdir(directory)).sort()).toEqual(['support.zip']);
  });

  it('rejects an unsupported ZIP member even without an archive filename', async () => {
    const directory = await temporaryDirectory();
    const archive = Path.join(directory, 'support.zip');
    await createZip(archive, 'attachment', 'not inspected\n', { compressionMethod: 12 });

    const result = spawnSync('yarn', ['troubleshoot:inspect', archive], { encoding: 'utf8' });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('ZIP compression method 12 is not supported');
    expect((await readdir(directory)).sort()).toEqual(['support.zip']);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(Path.join(os.tmpdir(), 'argon-troubleshooting-archive-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function createZip(
  archive: string,
  fileName: string,
  contents: string | Buffer,
  options: { compressionMethod?: number; deflate?: boolean; mode?: number } = {},
): Promise<void> {
  const name = Buffer.from(fileName);
  const uncompressedData = Buffer.from(contents);
  const compressionMethod = options.compressionMethod ?? (options.deflate ? 8 : 0);
  const data = compressionMethod === 8 ? deflateRawSync(uncompressedData) : uncompressedData;
  const checksum = crc32(uncompressedData) >>> 0;
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(compressionMethod, 8);
  localHeader.writeUInt32LE(checksum, 14);
  localHeader.writeUInt32LE(data.length, 18);
  localHeader.writeUInt32LE(uncompressedData.length, 22);
  localHeader.writeUInt16LE(name.length, 26);

  const centralDirectory = Buffer.alloc(46);
  centralDirectory.writeUInt32LE(0x02014b50);
  centralDirectory.writeUInt16LE(0x0314, 4);
  centralDirectory.writeUInt16LE(20, 6);
  centralDirectory.writeUInt16LE(compressionMethod, 10);
  centralDirectory.writeUInt32LE(checksum, 16);
  centralDirectory.writeUInt32LE(data.length, 20);
  centralDirectory.writeUInt32LE(uncompressedData.length, 24);
  centralDirectory.writeUInt16LE(name.length, 28);
  centralDirectory.writeUInt32LE((options.mode ?? 0o100644) * 2 ** 16, 38);

  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50);
  endOfCentralDirectory.writeUInt16LE(1, 8);
  endOfCentralDirectory.writeUInt16LE(1, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectory.length + name.length, 12);
  endOfCentralDirectory.writeUInt32LE(localHeader.length + name.length + data.length, 16);

  await writeFile(archive, Buffer.concat([localHeader, name, data, centralDirectory, name, endOfCentralDirectory]));
}
