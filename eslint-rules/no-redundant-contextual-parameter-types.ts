import * as ts from 'typescript';

function getContextualSignature(checker: ts.TypeChecker, functionNode: ts.ArrowFunction | ts.FunctionExpression) {
  const contextualType = checker.getContextualType(functionNode);
  if (!contextualType) return;

  const signatures = checker.getSignaturesOfType(contextualType, ts.SignatureKind.Call);
  if (!signatures.length) return;

  return signatures[0];
}

function areEquivalentTypes(
  checker: ts.TypeChecker,
  left: ts.Type,
  right: ts.Type,
  typeNode: ts.TypeNode,
): boolean {
  const formatFlags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;
  const leftText = checker.typeToString(left, typeNode, formatFlags);
  const rightText = checker.typeToString(right, typeNode, formatFlags);

  if (leftText === rightText) {
    return true;
  }

  const broadFlags = ts.TypeFlags.Any | ts.TypeFlags.Unknown;
  if ((left.flags & broadFlags) !== 0 || (right.flags & broadFlags) !== 0) {
    return false;
  }

  if (ts.isIntersectionTypeNode(typeNode) || ts.isUnionTypeNode(typeNode)) {
    return false;
  }

  return checker.isTypeAssignableTo(left, right) && checker.isTypeAssignableTo(right, left);
}

export default {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Disallow explicit parameter types when a function expression is contextually typed',
    },
    schema: [],
    messages: {
      redundantParameterType: 'Remove this explicit parameter type. It is already inferred from the callback context.',
    },
  },

  create(context: any) {
    const parserServices = context.sourceCode.parserServices;
    if (!parserServices?.program || !parserServices.esTreeNodeToTSNodeMap) {
      return {};
    }

    const checker = parserServices.program.getTypeChecker();

    function check(node: any) {
      if (!node.params.some((param: any) => param.type === 'Identifier' && param.typeAnnotation)) {
        return;
      }

      const tsNode = parserServices.esTreeNodeToTSNodeMap.get(node) as ts.ArrowFunction | ts.FunctionExpression;
      const contextualSignature = getContextualSignature(checker, tsNode);
      if (!contextualSignature) {
        return;
      }

      const contextualParameters = contextualSignature.getParameters();
      for (const [index, param] of node.params.entries()) {
        if (param.type !== 'Identifier' || !param.typeAnnotation) continue;
        if (param.optional || param.decorators?.length) continue;

        const tsParam = tsNode.parameters[index];
        if (!tsParam?.type || contextualParameters.length <= index) continue;

        const explicitType = checker.getTypeFromTypeNode(tsParam.type);
        const contextualType = checker.getTypeOfSymbolAtLocation(contextualParameters[index], tsParam);
        if (!areEquivalentTypes(checker, explicitType, contextualType, tsParam.type)) continue;

        context.report({
          node: param.typeAnnotation,
          messageId: 'redundantParameterType',
        });
      }
    }

    return {
      ArrowFunctionExpression: check,
      FunctionExpression: check,
    };
  },
};
