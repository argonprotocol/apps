function isQueryAppCall(node: any): boolean {
  if (!node || node.type !== 'CallExpression') return false;

  const callee = node.callee;
  return (
    callee?.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property?.type === 'Identifier' &&
    callee.property.name === 'queryApp'
  );
}

function getFunctionFromDefinition(definition: any): any {
  const node = definition?.node;
  if (!node) return null;
  if (node.type === 'FunctionDeclaration') return node;
  if (node.type !== 'VariableDeclarator') return null;

  const init = node.init;
  if (!init) return null;
  if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
    return init;
  }
  return null;
}

function findVariable(scope: any, name: string): any {
  let currentScope = scope;
  while (currentScope) {
    const variable = currentScope.set?.get(name);
    if (variable) return variable;
    currentScope = currentScope.upper;
  }
  return null;
}

function resolveQueryCallback(node: any, sourceCode: any): any {
  const callback = node.arguments[0];
  if (!callback) return null;

  if (callback.type === 'ArrowFunctionExpression' || callback.type === 'FunctionExpression') {
    return callback;
  }

  if (callback.type !== 'Identifier') return null;

  const variable = findVariable(sourceCode.getScope(callback), callback.name);
  if (!variable) return null;

  for (const definition of variable.defs ?? []) {
    const functionNode = getFunctionFromDefinition(definition);
    if (functionNode) return functionNode;
  }

  return null;
}

function collectScopes(scope: any, collected: Set<any>): void {
  if (!scope || collected.has(scope)) return;
  collected.add(scope);
  for (const childScope of scope.childScopes ?? []) {
    collectScopes(childScope, collected);
  }
}

function isTypeOnlyReference(identifier: any, functionNode: any): boolean {
  let current = identifier;
  while (current && current !== functionNode) {
    if (
      typeof current.type === 'string' &&
      current.type.startsWith('TS') &&
      current.type !== 'TSAsExpression' &&
      current.type !== 'TSSatisfiesExpression' &&
      current.type !== 'TSNonNullExpression'
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isAllowedResolvedVariable(variable: any, allowedScopes: Set<any>, functionNode: any): boolean {
  if (!variable) return true;
  if (allowedScopes.has(variable.scope)) return true;
  if (variable.scope?.type === 'global') return true;
  if ((variable.defs?.length ?? 0) === 0) return true;

  return variable.defs.some((definition: any) => getFunctionFromDefinition(definition) === functionNode);
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow queryApp callbacks from capturing outer-scope variables because they are stringified before running in the app',
    },
    schema: [],
    messages: {
      externalScopeCapture:
        "queryApp callbacks are stringified before running in the app. Do not capture outer-scope variable '{{name}}'; pass it via args or define it inside the callback.",
    },
  },

  create(context: any) {
    const sourceCode = context.sourceCode;

    function check(node: any): void {
      if (!isQueryAppCall(node)) return;

      const callback = resolveQueryCallback(node, sourceCode);
      if (!callback) return;

      const callbackScope = sourceCode.getScope(callback);
      const allowedScopes = new Set<any>();
      collectScopes(callbackScope, allowedScopes);

      const reportedNames = new Set<string>();
      for (const scope of allowedScopes) {
        for (const reference of scope.references ?? []) {
          const variable = reference.resolved;
          if (!variable) continue;
          if (isTypeOnlyReference(reference.identifier, callback)) continue;
          if (isAllowedResolvedVariable(variable, allowedScopes, callback)) continue;

          const name = reference.identifier?.name;
          if (!name || reportedNames.has(name)) continue;
          reportedNames.add(name);

          context.report({
            node: reference.identifier,
            messageId: 'externalScopeCapture',
            data: { name },
          });
        }
      }
    }

    return {
      CallExpression: check,
    };
  },
};
