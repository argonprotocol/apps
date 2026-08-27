import * as ts from 'typescript';
import { createNativeTypeTranslator, nativeTypeForOverride } from './nativeTypes.js';
import type { RuntimeTypeOverrides } from '../typeOverrides.js';

export type RuntimeQueryDeclaration = {
  args: readonly string[];
  result: string;
};

export type RuntimeQueryDeclarations = Record<string, Record<string, RuntimeQueryDeclaration>>;

export function readRuntimeQueries(
  querySource: string,
  lookupSource: string,
  definitionSource?: string,
  typeOverrides: RuntimeTypeOverrides = { fields: {}, queries: {}, queryArgs: {} },
): RuntimeQueryDeclarations {
  const sourceFile = ts.createSourceFile('augment-api-query.ts', querySource, ts.ScriptTarget.Latest, true);
  const queriesInterface = findInterface(sourceFile, 'AugmentedQueries');
  if (!queriesInterface) throw new Error('Unable to find AugmentedQueries');

  const translator = createNativeTypeTranslator(lookupSource, typeOverrides.fields, definitionSource);
  const queries: RuntimeQueryDeclarations = {};
  for (const sectionMember of queriesInterface.members) {
    if (!ts.isPropertySignature(sectionMember) || !sectionMember.type || !ts.isTypeLiteralNode(sectionMember.type)) {
      continue;
    }
    const section = propertyName(sectionMember.name);
    if (!section) continue;

    const methods: Record<string, RuntimeQueryDeclaration> = {};
    for (const methodMember of sectionMember.type.members) {
      if (!ts.isPropertySignature(methodMember) || !methodMember.type || !ts.isTypeReferenceNode(methodMember.type)) {
        continue;
      }
      const method = propertyName(methodMember.name);
      const call = methodMember.type.typeArguments?.[1];
      const storageArgs = methodMember.type.typeArguments?.[2];
      if (!method || !call || !ts.isFunctionTypeNode(call)) continue;

      methods[method] = {
        args:
          storageArgs && ts.isTupleTypeNode(storageArgs)
            ? storageArgs.elements.map((argument, index) => {
                return (
                  nativeTypeForOverride(typeOverrides.queryArgs?.[`${section}.${method}`]?.[index]) ??
                  translator.translate(argument)
                );
              })
            : call.parameters.map(() => 'unknown'),
        result:
          nativeTypeForOverride(typeOverrides.queries[`${section}.${method}`]) ??
          translator.translate(unwrapObservable(call.type)),
      };
    }
    queries[section] = methods;
  }
  return queries;
}

function unwrapObservable(node: ts.TypeNode): ts.TypeNode {
  if (!ts.isTypeReferenceNode(node) || node.typeName.getText(node.getSourceFile()) !== 'Observable') {
    throw new Error(`Expected query Observable result, received ${node.getText(node.getSourceFile())}`);
  }
  const result = node.typeArguments?.[0];
  if (!result) throw new Error('Query Observable is missing its result type');
  return result;
}

function findInterface(sourceFile: ts.SourceFile, name: string): ts.InterfaceDeclaration | undefined {
  let found: ts.InterfaceDeclaration | undefined;
  visit(sourceFile);
  return found;

  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  }
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}
