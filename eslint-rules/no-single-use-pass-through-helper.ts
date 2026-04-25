function unwrapPassThroughCall(node: any): any {
  if (!node) return null;
  if (node.type === 'AwaitExpression') return unwrapPassThroughCall(node.argument);
  if (node.type === 'ChainExpression') return unwrapPassThroughCall(node.expression);
  if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression') {
    return unwrapPassThroughCall(node.expression);
  }
  if (node.type === 'CallExpression') return node;
  return null;
}

function getPassThroughCall(functionNode: any): any {
  if (functionNode.body.type !== 'BlockStatement') {
    return unwrapPassThroughCall(functionNode.body);
  }

  if (functionNode.body.body.length !== 1) return null;
  const [statement] = functionNode.body.body;

  if (statement.type === 'ReturnStatement') {
    return unwrapPassThroughCall(statement.argument);
  }

  if (statement.type === 'ExpressionStatement') {
    return unwrapPassThroughCall(statement.expression);
  }

  return null;
}

function getCandidateName(node: any): string | null {
  if (node.type === 'FunctionDeclaration') {
    return node.id?.name ?? null;
  }

  if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
    return node.id.name;
  }

  return null;
}

function getFunctionNode(node: any): any {
  if (node.type === 'FunctionDeclaration') return node;
  if (node.type === 'VariableDeclarator') return node.init;
  return null;
}

function isTopLevelHelper(node: any): boolean {
  const parent = node.parent;
  if (!parent) return false;

  if (parent.type === 'Program') return true;

  if (parent.type === 'ExportNamedDeclaration') {
    return false;
  }

  if (parent.type !== 'VariableDeclaration') return false;
  return parent.parent?.type === 'Program';
}

export default {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Disallow single-use helpers that only wrap another call',
    },
    schema: [],
    messages: {
      inlineHelper: 'Inline this single-use helper. It only wraps another call.',
    },
  },

  create(context: any) {
    const candidates = new Map<string, any>();
    const callCounts = new Map<string, number>();

    return {
      FunctionDeclaration(node: any) {
        if (!isTopLevelHelper(node) || !node.id) return;
        if (!getPassThroughCall(node)) return;
        candidates.set(node.id.name, node);
        callCounts.set(node.id.name, 0);
      },

      VariableDeclarator(node: any) {
        if (!isTopLevelHelper(node)) return;
        if (!node.init || (node.init.type !== 'ArrowFunctionExpression' && node.init.type !== 'FunctionExpression')) {
          return;
        }
        const name = getCandidateName(node);
        if (!name) return;
        if (!getPassThroughCall(node.init)) return;
        candidates.set(name, node);
        callCounts.set(name, 0);
      },

      CallExpression(node: any) {
        if (node.callee.type !== 'Identifier') return;

        const candidate = candidates.get(node.callee.name);
        if (!candidate) return;

        const scope = context.sourceCode.getScope(node);
        const reference = scope.references.find((entry: any) => entry.identifier === node.callee);
        if (!reference?.resolved) return;
        if (reference.resolved.scope.type !== 'module') return;

        callCounts.set(node.callee.name, (callCounts.get(node.callee.name) ?? 0) + 1);
      },

      'Program:exit'() {
        for (const [name, candidate] of candidates) {
          const functionNode = getFunctionNode(candidate);
          if (!functionNode || !getPassThroughCall(functionNode)) continue;
          if (callCounts.get(name) !== 1) continue;

          context.report({
            node: candidate,
            messageId: 'inlineHelper',
          });
        }
      },
    };
  },
};
