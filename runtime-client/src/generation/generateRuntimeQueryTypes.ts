import * as ts from 'typescript';
import { readRuntimeConstants, readRuntimeQueries, type RuntimeQueryDeclaration } from './queryDeclarations.js';
import type { RuntimeTypeOverrides } from '../typeOverrides.js';

export type RuntimeQuerySource = {
  specVersion: number;
  source: string;
  querySource: string;
  constantSource?: string;
  lookupSource: string;
  definitionSource?: string;
};

type QueryVariant = RuntimeQueryDeclaration & {
  specVersion: number;
};

export function generateRuntimeQueryTypes(
  sources: readonly RuntimeQuerySource[],
  typeOverrides: RuntimeTypeOverrides = { fields: {}, queries: {}, queryArgs: {} },
): string {
  const declarations = collectQueryVariants(sources, typeOverrides);
  const aliases: string[] = [];
  const sections: string[] = [];
  const currentSections: string[] = [];
  const liveSections: string[] = [];
  const typeSections: string[] = [];
  const currentSpec = Math.max(...sources.map(source => source.specVersion));
  const liveSpecs = [...new Set(sources.map(source => source.specVersion))].sort((a, b) => b - a).slice(0, 2);
  const supportedSpecCount = new Set(sources.map(source => source.specVersion)).size;

  for (const [section, methods] of sortedEntries(declarations)) {
    const methodLines: string[] = [];
    const currentMethodLines: string[] = [];
    const liveMethodLines: string[] = [];
    const typeMethodLines: string[] = [];
    for (const [method, variants] of sortedEntries(methods)) {
      const uniqueResults = uniqueVariants(variants);
      const resultName = `${pascalCase(section)}${pascalCase(method)}Result`;
      const resultNames = uniqueResults.map((variant, index) => {
        const suffix =
          uniqueResults.length === 1 ? `${variant.specVersion}` : `${variant.specVersion}Variant${index + 1}`;
        const name = `${pascalCase(section)}${pascalCase(method)}ResultSpec${suffix}`;
        aliases.push(`export type ${name} = ${variant.result};`);
        return name;
      });
      const mergedResult =
        uniqueResults.length === 1 ? resultNames[0] : mergeHistoricalTypes(uniqueResults.map(result => result.result));
      const args = mergeQueryArgs(variants);
      const queryType =
        new Set(variants.map(variant => variant.specVersion)).size === supportedSpecCount
          ? 'RuntimeQuery'
          : 'OptionalRuntimeQuery';
      aliases.push(`export type ${resultName} = ${mergedResult};`);
      methodLines.push(`readonly ${safeProperty(method)}: ${queryType}<${args}, ${resultName}>;`);
      typeMethodLines.push(
        `readonly ${safeProperty(method)}: { readonly variants: ${resultNames.join(' | ')}; readonly record: ${resultName} };`,
      );

      const currentResults = [
        ...new Set(
          variants
            .filter(variant => variant.specVersion === currentSpec)
            .map(variant => resultNames[uniqueResults.findIndex(result => result.result === variant.result)]),
        ),
      ];
      if (currentResults.length) {
        const currentArgs = mergeQueryArgs(variants.filter(variant => variant.specVersion === currentSpec));
        currentMethodLines.push(
          `readonly ${safeProperty(method)}: CurrentRuntimeQuery<${currentArgs}, ${currentResults.join(' | ')}>;`,
        );
      }
      const liveVariants = variants.filter(variant => liveSpecs.includes(variant.specVersion));
      if (liveVariants.length) {
        const liveResults = uniqueVariants(liveVariants);
        const liveResult = liveResults.map(variant => variant.result).join(' | ');
        const liveQueryType =
          new Set(liveVariants.map(variant => variant.specVersion)).size === liveSpecs.length
            ? 'RuntimeQuery'
            : 'OptionalRuntimeQuery';
        liveMethodLines.push(
          `readonly ${safeProperty(method)}: ${liveQueryType}<${mergeQueryArgs(liveVariants)}, ${liveResult}>;`,
        );
      }
    }
    sections.push(`readonly ${safeProperty(section)}: { ${methodLines.join(' ')} };`);
    if (currentMethodLines.length) {
      currentSections.push(`readonly ${safeProperty(section)}: { ${currentMethodLines.join(' ')} };`);
    }
    if (liveMethodLines.length)
      liveSections.push(`readonly ${safeProperty(section)}: { ${liveMethodLines.join(' ')} };`);
    typeSections.push(`readonly ${safeProperty(section)}: { ${typeMethodLines.join(' ')} };`);
  }

  const provenance: Record<number, string[]> = {};
  for (const source of sources) (provenance[source.specVersion] ??= []).push(source.source);
  const supportedSpecs = [...new Set(sources.map(source => source.specVersion))].sort((a, b) => a - b);
  const constantsBySpec = sources
    .filter(source => liveSpecs.includes(source.specVersion) && source.constantSource)
    .map(source => ({
      specVersion: source.specVersion,
      sections: readRuntimeConstants(
        source.constantSource!,
        source.lookupSource,
        source.definitionSource,
        typeOverrides,
      ),
    }));
  const constantSections = [...new Set(constantsBySpec.flatMap(source => Object.keys(source.sections)))].sort();
  const liveConstantSections: string[] = [];
  const currentConstantSections: string[] = [];
  for (const section of constantSections) {
    const variants = constantsBySpec
      .filter(source => source.sections[section])
      .map(source => ({
        specVersion: source.specVersion,
        type: `{ ${sortedEntries(source.sections[section])
          .map(([name, type]) => `readonly ${safeProperty(name)}: ${type}`)
          .join('; ')} }`,
      }));
    liveConstantSections.push(
      `readonly ${safeProperty(section)}: ${[...new Set(variants.map(variant => variant.type))].join(' | ')};`,
    );
    const current = variants.find(variant => variant.specVersion === currentSpec);
    if (current) currentConstantSections.push(`readonly ${safeProperty(section)}: ${current.type};`);
  }

  return `// Generated by \`yarn workspace @argonprotocol/runtime-client generate\`.
// Query outputs are native TypeScript values. Runtime codec declarations are not part of this API.

import type BigNumber from 'bignumber.js';
import type { HistoricalEvent } from './HistoricalEvents.generated.js';
import type { CurrentRuntimeQuery, OptionalRuntimeQuery, RuntimeQuery } from './client.js';

${aliases.join('\n\n')}

export interface RuntimeQueries {
  ${sections.join('\n  ')}
}

export interface CurrentRuntimeQueries {
  ${currentSections.join('\n  ')}
}

export interface CurrentRuntimeConstants {
  ${currentConstantSections.join('\n  ')}
}

export interface LiveRuntimeConstants {
  ${liveConstantSections.join('\n  ')}
}

/** The deployed and next runtime; older storage shapes remain available through RuntimeQueries. */
export interface LiveRuntimeQueries {
  ${liveSections.join('\n  ')}
}

export type LiveQueryRecord<
  Section extends keyof LiveRuntimeQueries,
  Method extends keyof LiveRuntimeQueries[Section],
> = LiveRuntimeQueries[Section][Method] extends RuntimeQuery<infer _Args, infer Result>
  ? Result
  : LiveRuntimeQueries[Section][Method] extends OptionalRuntimeQuery<infer _Args, infer Result>
    ? Result
    : never;

export const liveRuntimeSpecs = ${JSON.stringify(liveSpecs.sort((a, b) => a - b))} as const;

interface RuntimeQueryTypes {
  ${typeSections.join('\n  ')}
}

export type RuntimeQuerySection = keyof RuntimeQueryTypes & string;
export type RuntimeQueryMethod<Section extends RuntimeQuerySection> = keyof RuntimeQueryTypes[Section] & string;

export type HistoricalQueryResultVariants<
  Section extends RuntimeQuerySection,
  Method extends RuntimeQueryMethod<Section>,
> = RuntimeQueryTypes[Section][Method] extends { readonly variants: infer Variants } ? Variants : never;

export type HistoricalQueryRecord<
  Section extends RuntimeQuerySection,
  Method extends RuntimeQueryMethod<Section>,
> = RuntimeQueryTypes[Section][Method] extends { readonly record: infer Record } ? Record : never;

export const supportedRuntimeSpecs = ${JSON.stringify(supportedSpecs)} as const;
export const runtimeSpecSources = ${JSON.stringify(provenance)} as const;
export const runtimeTypeOverrides = ${JSON.stringify(typeOverrides)} as const;
`;
}

function mergeQueryArgs(variants: readonly QueryVariant[]): string {
  const tuples = new Set(variants.map(variant => `readonly [${variant.args.join(', ')}]`));
  return [...tuples].join(' | ');
}

function collectQueryVariants(
  sources: readonly RuntimeQuerySource[],
  typeOverrides: RuntimeTypeOverrides,
): Record<string, Record<string, QueryVariant[]>> {
  const declarations: Record<string, Record<string, QueryVariant[]>> = {};
  for (const source of sources) {
    const sourceQueries = readRuntimeQueries(
      source.querySource,
      source.lookupSource,
      source.definitionSource,
      typeOverrides,
    );
    for (const [section, methods] of Object.entries(sourceQueries)) {
      for (const [method, declaration] of Object.entries(methods)) {
        ((declarations[section] ??= {})[method] ??= []).push({
          ...declaration,
          specVersion: source.specVersion,
        });
      }
    }
  }
  return declarations;
}

function uniqueVariants(variants: readonly QueryVariant[]): QueryVariant[] {
  const results = new Map<string, QueryVariant>();
  for (const variant of variants) {
    if (!results.has(variant.result)) results.set(variant.result, variant);
  }
  return [...results.values()];
}

function sortedEntries<Value>(record: Record<string, Value>): [string, Value][] {
  return Object.entries(record).sort(([left], [right]) => left.localeCompare(right));
}

function pascalCase(value: string): string {
  return value.replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_, _separator, character: string) => {
    return character.toUpperCase();
  });
}

function safeProperty(name: string): string {
  return /^[$A-Z_a-z][$\w]*$/.test(name) ? name : quote(name);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function mergeHistoricalTypes(types: readonly string[]): string {
  const sourceFile = ts.createSourceFile(
    'historical-query-result.ts',
    `type Result = ${types.join(' | ')};`,
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = sourceFile.statements.find(ts.isTypeAliasDeclaration);
  if (!declaration) throw new Error('Unable to parse historical query result');
  return mergeTypeNodes([declaration.type], sourceFile);
}

function mergeTypeNodes(nodes: readonly ts.TypeNode[], sourceFile: ts.SourceFile): string {
  const alternatives = uniqueNodes(nodes.flatMap(flattenUnion), sourceFile);
  const nonNull = alternatives.filter(node => !isNullType(node));
  const includesNull = nonNull.length !== alternatives.length;
  let merged: string;

  if (nonNull.length > 1 && nonNull.every(ts.isTypeLiteralNode) && !isDiscriminatedUnion(nonNull)) {
    merged = mergeObjectTypes(nonNull, sourceFile);
  } else {
    merged = nonNull.map(node => node.getText(sourceFile)).join(' | ') || 'never';
  }

  return includesNull ? `${merged} | null` : merged;
}

function mergeObjectTypes(nodes: readonly ts.TypeLiteralNode[], sourceFile: ts.SourceFile): string {
  const properties = new Map<string, ts.PropertySignature[]>();
  for (const node of nodes) {
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || !member.type) continue;
      const name = propertyName(member.name);
      if (!name) continue;
      const variants = properties.get(name) ?? [];
      variants.push(member);
      properties.set(name, variants);
    }
  }

  const fields = [...properties].map(([name, variants]) => {
    const optional = variants.length !== nodes.length || variants.some(variant => variant.questionToken);
    const type = mergeTypeNodes(
      variants.map(variant => variant.type!),
      sourceFile,
    );
    return `readonly ${safeProperty(name)}${optional ? '?' : ''}: ${type}`;
  });
  return `{ ${fields.join('; ')} }`;
}

function flattenUnion(node: ts.TypeNode): ts.TypeNode[] {
  return ts.isUnionTypeNode(node) ? node.types.flatMap(flattenUnion) : [node];
}

function uniqueNodes(nodes: readonly ts.TypeNode[], sourceFile: ts.SourceFile): ts.TypeNode[] {
  const unique = new Map<string, ts.TypeNode>();
  for (const node of nodes) unique.set(node.getText(sourceFile), node);
  return [...unique.values()];
}

function isNullType(node: ts.TypeNode): boolean {
  return ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword;
}

function isDiscriminatedUnion(nodes: readonly ts.TypeLiteralNode[]): boolean {
  return nodes.every(node =>
    node.members.some(member => ts.isPropertySignature(member) && propertyName(member.name) === 'type'),
  );
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}
