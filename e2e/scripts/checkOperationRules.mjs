import fs from 'node:fs/promises';
import Path from 'node:path';

const OPERATIONS_DIR = Path.resolve(process.cwd(), 'flows/operations');
const OPERATION_FILE_PATTERN = /^[A-Z][A-Za-z0-9]*\.(op|flow)\.[A-Za-z0-9_]+\.ts$/;

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
