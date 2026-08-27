import * as ts from 'typescript';
import type { RuntimeTypeOverride } from '../typeOverrides.js';

type TypeDeclaration = ts.InterfaceDeclaration | ts.TypeAliasDeclaration;

export type NativeTypeTranslator = {
  translate(node: ts.TypeNode): string;
  translateField(name: string, node: ts.TypeNode): string;
};

export function createNativeTypeTranslator(
  lookupSource: string,
  fieldOverrides: Readonly<Record<string, RuntimeTypeOverride>> = {},
  definitionSource?: string,
): NativeTypeTranslator {
  const sourceFile = ts.createSourceFile('types-lookup.ts', lookupSource, ts.ScriptTarget.Latest, true);
  const declarations = readTypeDeclarations(sourceFile);
  const enumVariants = definitionSource ? readEnumVariants(definitionSource) : new Map<string, Map<string, string>>();

  return {
    translate(node) {
      return translateType(node, declarations, enumVariants, new Set(), fieldOverrides);
    },
    translateField(name, node) {
      const override = nativeTypeForOverride(fieldOverrides[name]);
      return override
        ? translateOverriddenField(node, override)
        : translateType(node, declarations, enumVariants, new Set(), fieldOverrides);
    },
  };
}

function translateType(
  node: ts.TypeNode,
  declarations: Map<string, TypeDeclaration>,
  enumVariants: Map<string, Map<string, string>>,
  stack: Set<string>,
  fieldOverrides: Readonly<Record<string, RuntimeTypeOverride>>,
): string {
  if (ts.isParenthesizedTypeNode(node))
    return translateType(node.type, declarations, enumVariants, stack, fieldOverrides);
  if (ts.isUnionTypeNode(node)) {
    return unique(node.types.map(type => translateType(type, declarations, enumVariants, stack, fieldOverrides))).join(
      ' | ',
    );
  }
  if (ts.isIntersectionTypeNode(node)) {
    const meaningful = node.types.filter(type => type.getText(type.getSourceFile()) !== 'Struct');
    if (meaningful.length === 1) return translateType(meaningful[0], declarations, enumVariants, stack, fieldOverrides);
    return meaningful.map(type => translateType(type, declarations, enumVariants, stack, fieldOverrides)).join(' & ');
  }
  if (ts.isTupleTypeNode(node)) {
    return `readonly [${node.elements.map(type => translateType(type, declarations, enumVariants, stack, fieldOverrides)).join(', ')}]`;
  }
  if (ts.isArrayTypeNode(node)) {
    return `readonly ${arrayElement(translateType(node.elementType, declarations, enumVariants, stack, fieldOverrides))}[]`;
  }
  if (ts.isTypeLiteralNode(node))
    return translateProperties(node.members, declarations, enumVariants, stack, fieldOverrides);
  if (ts.isLiteralTypeNode(node)) return node.getText(node.getSourceFile());
  if (node.kind === ts.SyntaxKind.BooleanKeyword) return 'boolean';
  if (node.kind === ts.SyntaxKind.StringKeyword) return 'string';
  if (node.kind === ts.SyntaxKind.NumberKeyword) return 'number';
  if (node.kind === ts.SyntaxKind.BigIntKeyword) return 'bigint';
  if (node.kind === ts.SyntaxKind.UnknownKeyword || node.kind === ts.SyntaxKind.AnyKeyword) return 'unknown';

  if (!ts.isTypeReferenceNode(node)) {
    throw new Error(`Unsupported runtime type ${node.getText(node.getSourceFile())}`);
  }

  const name = typeReferenceName(node.typeName);
  const args = node.typeArguments ?? [];
  if (name === 'Option') {
    const inner = translateType(requiredArg(name, args, 0), declarations, enumVariants, stack, fieldOverrides);
    return inner === 'null' ? 'null' : `${inner} | null`;
  }
  if (name === 'Compact')
    return translateType(requiredArg(name, args, 0), declarations, enumVariants, stack, fieldOverrides);
  if (name === 'Vec' || name === 'BTreeSet') {
    const element = translateType(requiredArg(name, args, 0), declarations, enumVariants, stack, fieldOverrides);
    return `readonly ${arrayElement(element)}[]`;
  }
  if (name === 'BTreeMap') {
    return `Record<string, ${translateType(requiredArg(name, args, 1), declarations, enumVariants, stack, fieldOverrides)}>`;
  }
  if (name === 'ITuple')
    return translateType(requiredArg(name, args, 0), declarations, enumVariants, stack, fieldOverrides);
  if (name === 'Result') {
    const ok = translateType(requiredArg(name, args, 0), declarations, enumVariants, stack, fieldOverrides);
    const error = translateType(requiredArg(name, args, 1), declarations, enumVariants, stack, fieldOverrides);
    return `{ readonly type: 'Ok'; readonly value: ${ok} } | { readonly type: 'Err'; readonly value: ${error} }`;
  }
  if (/^u(8|16|32)$/.test(name)) return 'number';
  if (/^u(64|128|256)$/.test(name) || /^i(8|16|32|64|128|256)$/.test(name)) {
    return 'bigint';
  }
  if (/^(U256|I256)$/.test(name)) {
    return 'bigint';
  }
  if (/^(Percent|Permill|Perbill|Perquintill|FixedU128|FixedI128)$/.test(name)) return 'BigNumber';
  if (name === 'bool') return 'boolean';
  if (name === 'Null') return 'null';
  if (name === 'Bytes') return 'Uint8Array';
  if (/^(Text|Char|U8aFixed|AccountId32|H160|H256)$/.test(name)) return 'string';
  if (name === 'Event') {
    return 'HistoricalEvent';
  }

  const declaration = declarations.get(name);
  if (!declaration) {
    if (/(Account|Public|Pubkey|Hash|XPub)$/.test(name)) return 'string';
    throw new Error(`Unable to resolve runtime output type ${name}`);
  }
  if (stack.has(name)) throw new Error(`Recursive runtime output type ${[...stack, name].join(' -> ')}`);

  const nextStack = new Set(stack).add(name);
  if (ts.isTypeAliasDeclaration(declaration)) {
    return translateType(declaration.type, declarations, enumVariants, nextStack, fieldOverrides);
  }

  const base = declaration.heritageClauses?.[0]?.types[0];
  const baseName = base?.expression.getText(declaration.getSourceFile());
  if (baseName === 'Enum') return translateEnum(declaration, declarations, enumVariants, nextStack, fieldOverrides);
  if (baseName === 'Struct' || !base) {
    return translateProperties(declaration.members, declarations, enumVariants, nextStack, fieldOverrides);
  }
  if (baseName) {
    const baseNode = ts.factory.createTypeReferenceNode(baseName, base.typeArguments);
    return translateType(baseNode, declarations, enumVariants, nextStack, fieldOverrides);
  }

  throw new Error(`Unable to translate runtime output type ${name}`);
}

function translateEnum(
  declaration: ts.InterfaceDeclaration,
  declarations: Map<string, TypeDeclaration>,
  enumVariants: Map<string, Map<string, string>>,
  stack: Set<string>,
  fieldOverrides: Readonly<Record<string, RuntimeTypeOverride>>,
): string {
  const typeProperty = declaration.members.find(member => {
    return ts.isPropertySignature(member) && propertyName(member.name) === 'type';
  });
  if (!typeProperty || !ts.isPropertySignature(typeProperty) || !typeProperty.type) {
    throw new Error(`Enum ${declaration.name.text} has no literal type declaration`);
  }

  const variants = ts.isUnionTypeNode(typeProperty.type) ? typeProperty.type.types : [typeProperty.type];
  return variants
    .map(variant => {
      if (!ts.isLiteralTypeNode(variant) || !ts.isStringLiteral(variant.literal)) {
        throw new Error(`Enum ${declaration.name.text} contains a non-string variant`);
      }
      const variantName = variant.literal.text;
      const nativeVariantName = enumVariants.get(declaration.name.text)?.get(variantName.toLowerCase()) ?? variantName;
      const payload = declaration.members.find(member => {
        return ts.isPropertySignature(member) && propertyName(member.name) === `as${variantName}`;
      });
      if (!payload || !ts.isPropertySignature(payload) || !payload.type) {
        return `{ readonly type: '${nativeVariantName}' }`;
      }
      return `{ readonly type: '${nativeVariantName}'; readonly value: ${translateType(payload.type, declarations, enumVariants, stack, fieldOverrides)} }`;
    })
    .join(' | ');
}

function translateProperties(
  members: ts.NodeArray<ts.TypeElement>,
  declarations: Map<string, TypeDeclaration>,
  enumVariants: Map<string, Map<string, string>>,
  stack: Set<string>,
  fieldOverrides: Readonly<Record<string, RuntimeTypeOverride>>,
): string {
  const fields = members.flatMap(member => {
    if (!ts.isPropertySignature(member) || !member.type) return [];
    const name = propertyName(member.name);
    if (!name) return [];
    const override = nativeTypeForOverride(fieldOverrides[name]);
    return [
      `readonly ${safeProperty(name)}${member.questionToken ? '?' : ''}: ${override ? translateOverriddenField(member.type, override) : translateType(member.type, declarations, enumVariants, stack, fieldOverrides)}`,
    ];
  });
  return fields.length ? `{ ${fields.join('; ')} }` : '{}';
}

function translateOverriddenField(node: ts.TypeNode, override: string): string {
  if (!ts.isTypeReferenceNode(node)) return override;

  const name = typeReferenceName(node.typeName);
  if (name === 'Option') {
    const inner = translateOverriddenField(requiredArg(name, node.typeArguments ?? [], 0), override);
    return `${inner} | null`;
  }
  if (name === 'Compact') {
    return translateOverriddenField(requiredArg(name, node.typeArguments ?? [], 0), override);
  }
  return override;
}

export function nativeTypeForOverride(override?: RuntimeTypeOverride): string | undefined {
  if (override === 'number') return 'number';
  if (override === 'number[]') return 'readonly number[]';
  if (override === 'FixedU128') return 'BigNumber';
  return undefined;
}

function readTypeDeclarations(sourceFile: ts.SourceFile): Map<string, TypeDeclaration> {
  const declarations = new Map<string, TypeDeclaration>();
  visit(sourceFile);
  return declarations;

  function visit(node: ts.Node): void {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      declarations.set(node.name.text, node);
    }
    ts.forEachChild(node, visit);
  }
}

function readEnumVariants(contents: string): Map<string, Map<string, string>> {
  const sourceFile = ts.createSourceFile('lookup.ts', contents, ts.ScriptTarget.Latest, true);
  const definitions = sourceFile.statements.find(ts.isExportAssignment)?.expression;
  const result = new Map<string, Map<string, string>>();
  if (!definitions || !ts.isObjectLiteralExpression(definitions)) return result;

  for (const definition of definitions.properties) {
    if (!ts.isPropertyAssignment(definition) || !ts.isObjectLiteralExpression(definition.initializer)) continue;
    const typeName = propertyName(definition.name);
    const enumProperty = definition.initializer.properties.find(property => {
      return ts.isPropertyAssignment(property) && propertyName(property.name) === '_enum';
    });
    if (!typeName || !enumProperty || !ts.isPropertyAssignment(enumProperty)) continue;

    const variants = new Map<string, string>();
    if (ts.isObjectLiteralExpression(enumProperty.initializer)) {
      for (const variant of enumProperty.initializer.properties) {
        const name = propertyName(variant.name);
        if (name) variants.set(name.toLowerCase(), name);
      }
    } else if (ts.isArrayLiteralExpression(enumProperty.initializer)) {
      for (const variant of enumProperty.initializer.elements) {
        if (ts.isStringLiteral(variant)) variants.set(variant.text.toLowerCase(), variant.text);
      }
    }
    result.set(typeName, variants);
  }
  return result;
}

function requiredArg(name: string, args: readonly ts.TypeNode[], index: number): ts.TypeNode {
  const arg = args[index];
  if (!arg) throw new Error(`${name} is missing type argument ${index + 1}`);
  return arg;
}

function propertyName(name?: ts.PropertyName): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function typeReferenceName(name: ts.EntityName): string {
  if (ts.isIdentifier(name)) return name.text;
  return `${typeReferenceName(name.left)}.${name.right.text}`;
}

function safeProperty(name: string): string {
  return /^[$A-Z_a-z][$\w]*$/.test(name) ? name : JSON.stringify(name);
}

function arrayElement(type: string): string {
  return type.includes(' | ') || type.startsWith('readonly ') ? `(${type})` : type;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
