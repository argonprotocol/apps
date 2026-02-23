import { NodeTypes } from '@vue/compiler-core';

const GENERIC_COMPONENT_NAMES = new Set([
  'App',
  'Dashboard',
  'Dialog',
  'Index',
  'Layout',
  'Modal',
  'Overlay',
  'Page',
  'Panel',
  'Screen',
  'View',
]);

export function createDataTestIdNodeTransform() {
  return (node, ctx) => {
    if (node.type !== NodeTypes.ELEMENT) return;
    if (!ctx.filename) return;
    if (node.props.some(prop => prop.type === NodeTypes.ATTRIBUTE && prop.name === 'data-testid')) return;

    const pushTestId = value => {
      node.props.push({
        type: NodeTypes.ATTRIBUTE,
        name: 'data-testid',
        nameLoc: node.loc,
        value: {
          type: NodeTypes.TEXT,
          content: value,
          loc: node.loc,
        },
        loc: node.loc,
      });
    };

    const primaryRootElement = ctx.root.children.find(child => child.type === NodeTypes.ELEMENT);
    const isPrimaryRootElement = ctx.parent?.type === NodeTypes.ROOT && primaryRootElement === node;
    if (isPrimaryRootElement) {
      pushTestId(deriveComponentTestId(ctx.filename, ctx.selfName));
      return;
    }

    const clickDir = node.props.find(
      prop =>
        prop.type === NodeTypes.DIRECTIVE &&
        prop.name === 'on' &&
        prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION &&
        prop.arg.content === 'click',
    );
    if (!clickDir || clickDir.type !== NodeTypes.DIRECTIVE || !clickDir.exp) return;

    let fnName = clickDir.exp.type === NodeTypes.SIMPLE_EXPRESSION ? clickDir.exp.content : '';
    if (!fnName.includes('(') && !fnName.includes('=')) fnName += '()';

    const selfName = typeof ctx.selfName === 'string' && ctx.selfName.length > 0 ? ctx.selfName : 'Component';
    pushTestId(`${selfName}.${fnName}`);
  };
}

export function deriveComponentTestId(filename, selfName) {
  const normalizedFilename = filename.replace(/\\/g, '/');
  const pathSegments = normalizedFilename.split('/');
  const rawFileName = pathSegments[pathSegments.length - 1] ?? '';
  const rawBaseName = rawFileName.replace(/\.[^/.]+$/, '');
  const baseName = toPascalCase(rawBaseName);
  const fallback = selfName ? toPascalCase(selfName) : baseName || 'Component';
  if (!baseName) return fallback;

  if (!GENERIC_COMPONENT_NAMES.has(baseName)) {
    return baseName;
  }

  const parentSegment = pathSegments[pathSegments.length - 2] ?? '';
  const parentName = toPascalCase(parentSegment);
  if (!parentName) {
    return fallback;
  }
  const parentPrefix = parentName.replace(/(Dialog|Layout|Overlay|Page|Panel|Screen|View)$/, '');
  return `${parentPrefix || parentName}${baseName}`;
}

function toPascalCase(value) {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map(part => (part ? part.charAt(0).toUpperCase() + part.slice(1) : ''))
    .join('');
}
