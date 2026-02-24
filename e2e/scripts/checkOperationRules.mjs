import fs from 'node:fs/promises';
import Path from 'node:path';
import { parse, compileTemplate } from '@vue/compiler-sfc';
import { createDataTestIdNodeTransform } from './testIdNaming.mjs';

const FLOWS_DIR = Path.resolve(process.cwd(), 'flows');
const OPERATIONS_DIR = Path.join(FLOWS_DIR, 'operations');
const SRC_VUE_DIR = Path.resolve(process.cwd(), '..', 'src-vue');
const OPERATION_FILE_PATTERN = /^[A-Z][A-Za-z0-9]*\.(op|flow)\.[A-Za-z0-9_]+\.ts$/;

const knownActionTargets = await collectKnownVueActionTargets();
const operationEntries = await fs.readdir(OPERATIONS_DIR, { withFileTypes: true });
const operationFiles = operationEntries
  .filter(entry => entry.isFile() && entry.name.endsWith('.ts'))
  .map(entry => entry.name);

const errors = [];

for (const fileName of operationFiles) {
  if (fileName === 'index.ts') {
    continue;
  }

  const filePath = Path.join(OPERATIONS_DIR, fileName);
  const source = await fs.readFile(filePath, 'utf8');

  if (!OPERATION_FILE_PATTERN.test(fileName)) {
    errors.push(`${fileName}: operation file names must be Domain.op.action.ts or Domain.flow.action.ts`);
    continue;
  }

  if (source.includes('IE2EFlowDefinition')) {
    errors.push(`${fileName}: operations must not define flow orchestration types`);
  }

  if (source.includes('isDone(')) {
    errors.push(`${fileName}: operations must use inspect + run (no isDone)`);
  }

  const isFlowFile = fileName.includes('.flow.');
  if (!isFlowFile && /\bcreate[A-Za-z0-9_]+FlowContext\(/.test(source)) {
    errors.push(`${fileName}: context creation belongs in contexts, not operation files`);
  }

  if (isFlowFile) {
    const hasDirectFlowExport = source.includes('export default new OperationalFlow');
    const hasFlowFactoryExport = /export\s+default\s+create[A-Za-z0-9_]+Flow/.test(source);
    if (!hasDirectFlowExport && !hasFlowFactoryExport) {
      errors.push(`${fileName}: flow file must default-export new OperationalFlow(...) or a create*Flow(...) factory`);
    }
  } else {
    const hasDirectOperationExport = source.includes('export default new Operation');
    const hasOperationFactoryExport = /export\s+default\s+create[A-Za-z0-9_]+Operation/.test(source);
    if (!hasDirectOperationExport && !hasOperationFactoryExport) {
      errors.push(`${fileName}: op file must default-export new Operation(...) or a create*Operation(...) factory`);
    }
  }

  if (source.includes("from './orchestrations") || source.includes("from '../orchestrations")) {
    errors.push(`${fileName}: operations must not import orchestrations`);
  }

  for (const target of findUnprefixedActionTargets(source)) {
    errors.push(`${fileName}: action target "${target}" must include a component prefix (Component.action())`);
  }
}

const flowFiles = await collectTypeScriptFiles(FLOWS_DIR);
for (const filePath of flowFiles) {
  const source = await fs.readFile(filePath, 'utf8');
  const relativePath = Path.relative(FLOWS_DIR, filePath).replace(/\\/g, '/');
  for (const target of findActionTargets(source)) {
    if (!shouldValidateAgainstVueIds(target)) continue;
    if (knownActionTargets.has(target)) continue;
    errors.push(
      `${relativePath}: unknown action target "${target}". This target is not present in generated/static Vue data-testid values`,
    );
  }
}

if (errors.length > 0) {
  console.error('[operations-rule] violations found:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

function findUnprefixedActionTargets(source) {
  const callPatterns = [/\bflow\.click\(\s*(['"`])([^'"`]+)\1/g, /\bclickIfVisible\(\s*[^,]+,\s*(['"`])([^'"`]+)\1/g];
  const unprefixed = new Set();

  for (const pattern of callPatterns) {
    let match = pattern.exec(source);
    while (match) {
      const target = match[2];
      if (isUnprefixedActionTarget(target)) {
        unprefixed.add(target);
      }
      match = pattern.exec(source);
    }
  }

  return [...unprefixed];
}

function isUnprefixedActionTarget(target) {
  return /^[A-Za-z0-9_]+\([^)]*\)$/.test(target);
}

function findActionTargets(source) {
  const callPatterns = [
    /\bflow\.(click|waitFor|isVisible|getText|getAttribute|copy|paste|type)\(\s*(['"`])([^'"`]+)\2/g,
    /\bclickIfVisible\(\s*[^,]+,\s*(['"`])([^'"`]+)\1/g,
  ];
  const targets = new Set();

  for (const pattern of callPatterns) {
    let match = pattern.exec(source);
    while (match) {
      const target = match[3] ?? match[2];
      if (typeof target === 'string' && target.length > 0) {
        targets.add(target);
      }
      match = pattern.exec(source);
    }
  }

  return [...targets];
}

function shouldValidateAgainstVueIds(target) {
  if (target.includes('${')) return false;
  if (!/^[A-Z][A-Za-z0-9_]*\.[^()]+\([^)]*\)$/.test(target)) return false;
  return true;
}

async function collectKnownVueActionTargets() {
  const vueFiles = await collectVueFiles(SRC_VUE_DIR);
  const known = new Set();

  for (const filePath of vueFiles) {
    const source = await fs.readFile(filePath, 'utf8');
    const parsed = parse(source, { filename: filePath });
    const template = parsed.descriptor.template;
    if (!template?.content) continue;

    const compiled = compileTemplate({
      source: template.content,
      filename: filePath,
      id: 'operation-rules',
      compilerOptions: {
        nodeTransforms: [createDataTestIdNodeTransform()],
      },
    });

    if (compiled.errors.length > 0) {
      const first = compiled.errors[0];
      const message = first instanceof Error ? first.message : JSON.stringify(first);
      throw new Error(`Failed to compile ${filePath}: ${message}`);
    }

    for (const testId of extractTestIdsFromCompiledCode(compiled.code)) {
      if (shouldValidateAgainstVueIds(testId)) {
        known.add(testId);
      }
    }
  }

  return known;
}

function extractTestIdsFromCompiledCode(code) {
  const ids = new Set();
  const patterns = [/"data-testid":\s*"([^"]+)"/g, /"data-testid",\s*"([^"]+)"/g];
  for (const pattern of patterns) {
    let match = pattern.exec(code);
    while (match) {
      if (match[1]) {
        ids.add(match[1]);
      }
      match = pattern.exec(code);
    }
  }
  return [...ids];
}

async function collectTypeScriptFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = Path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTypeScriptFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith('.ts')) {
      files.push(fullPath);
    }
  }

  return files;
}

async function collectVueFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = Path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectVueFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith('.vue')) {
      files.push(fullPath);
    }
  }

  return files;
}
