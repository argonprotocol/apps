import Path from 'node:path';
import { fileURLToPath } from 'node:url';

export function flowNameFromFile(meta: string | ImportMeta | undefined): string {
  const filePath = resolveFilePath(meta);
  return Path.basename(filePath, Path.extname(filePath));
}

function resolveFilePath(meta: string | ImportMeta | undefined): string {
  if (typeof meta === 'string') {
    return meta.startsWith('file://') ? fileURLToPath(meta) : meta;
  }
  if (meta && typeof meta === 'object') {
    const metaUrl = (meta as { url?: unknown }).url;
    if (typeof metaUrl === 'string' && metaUrl.length > 0) {
      return fileURLToPath(metaUrl);
    }
  }

  const stackPath = resolveCallerPathFromStack();
  if (stackPath) {
    return stackPath;
  }
  throw new Error('Unable to derive flow name from file path.');
}

function resolveCallerPathFromStack(): string | null {
  const stack = new Error().stack;
  if (!stack) return null;
  const lines = stack.split('\n').slice(1);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.includes('flowNameFromFile')) {
      continue;
    }

    const withParens = trimmed.match(/\((.+?):\d+:\d+\)$/);
    const withoutParens = trimmed.match(/^at\s+(.+?):\d+:\d+$/);
    const rawPath = withParens?.[1] ?? withoutParens?.[1];
    if (!rawPath) {
      continue;
    }

    if (rawPath.startsWith('node:') || rawPath === '<anonymous>') {
      continue;
    }

    const normalizedPath = rawPath.replace(/\\/g, '/');
    if (
      normalizedPath.endsWith('/helpers/flowNameFromFile.ts') ||
      normalizedPath.endsWith('/helpers/flowNameFromFile.js') ||
      normalizedPath.endsWith('/operations/index.ts') ||
      normalizedPath.endsWith('/operations/index.js')
    ) {
      continue;
    }

    if (rawPath.startsWith('file://')) {
      return fileURLToPath(rawPath);
    }
    return rawPath;
  }

  return null;
}
