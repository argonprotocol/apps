export interface RuntimeCompatibilityProvenance {
  clientVersion: string;
  finalizedBlockHash: string;
  specVersion: number;
}

export interface RuntimeInterfaceSources {
  events: string;
  lookup: string;
  query: string;
  runtime: string;
  tx: string;
}

interface RuntimeSurface {
  sourceName: keyof Omit<RuntimeInterfaceSources, 'lookup'>;
  moduleName: string;
  interfaceName: string;
  compatibilityName: string;
}

interface RuntimeSection {
  body: string;
  imports: RuntimeImport[];
}

interface RuntimeImport {
  moduleName: string;
  names: string[];
}

const RUNTIME_SURFACES: RuntimeSurface[] = [
  {
    sourceName: 'tx',
    moduleName: '@polkadot/api-base/types/submittable',
    interfaceName: 'AugmentedSubmittables',
    compatibilityName: 'Transactions',
  },
  {
    sourceName: 'query',
    moduleName: '@polkadot/api-base/types/storage',
    interfaceName: 'AugmentedQueries',
    compatibilityName: 'Queries',
  },
  {
    sourceName: 'events',
    moduleName: '@polkadot/api-base/types/events',
    interfaceName: 'AugmentedEvents',
    compatibilityName: 'Events',
  },
  {
    sourceName: 'runtime',
    moduleName: '@polkadot/api-base/types/calls',
    interfaceName: 'AugmentedCalls',
    compatibilityName: 'RuntimeCalls',
  },
];

export function createRuntimeCompatibilityModule(
  sources: RuntimeInterfaceSources,
  provenance: RuntimeCompatibilityProvenance,
): string {
  const sections = [
    unwrapLookupTypes(sources.lookup),
    ...RUNTIME_SURFACES.map(surface => unwrapApiTypes(sources[surface.sourceName], surface)),
  ];
  const imports = createImports(sections.flatMap(section => section.imports));
  const namespaceBody = sections.map(section => section.body.trim()).join('\n\n');

  return [
    createHeader(provenance),
    '/* eslint-disable */',
    '',
    imports,
    '',
    'export namespace PreviousRuntimeSpec {',
    indent(namespaceBody),
    '}',
    '',
  ].join('\n');
}

export function readRuntimeCompatibilityProvenance(contents: string): RuntimeCompatibilityProvenance | null {
  const match =
    /^\/\/ Runtime compatibility source: mainnet spec (\d+) at (0x[a-f0-9]+), @argonprotocol\/mainchain@([^\s]+)$/im.exec(
      contents,
    );
  if (!match) return null;

  return {
    specVersion: Number(match[1]),
    finalizedBlockHash: match[2],
    clientVersion: match[3],
  };
}

function unwrapLookupTypes(source: string): RuntimeSection {
  const { prefix, body } = readAugmentationBody(source, '@polkadot/types/lookup');

  return {
    imports: readImports(prefix),
    body: body.replace(/^(interface|type) /gm, 'export $1 '),
  };
}

function unwrapApiTypes(source: string, surface: RuntimeSurface): RuntimeSection {
  const { prefix, body } = readAugmentationBody(source, surface.moduleName);
  const interfacePattern = new RegExp(`^interface ${surface.interfaceName}(?=<)`, 'm');
  if (!interfacePattern.test(body)) {
    throw new Error(`Unable to find ${surface.interfaceName} in generated ${surface.sourceName} types`);
  }

  return {
    imports: readImports(prefix).filter(runtimeImport => runtimeImport.moduleName !== '@polkadot/types/lookup'),
    body: [
      readPrefixDeclarations(prefix),
      body.replace(interfacePattern, `export interface ${surface.compatibilityName}`),
    ]
      .filter(Boolean)
      .join('\n\n'),
  };
}

function readAugmentationBody(source: string, moduleName: string): { prefix: string; body: string } {
  const startToken = `declare module '${moduleName}' {`;
  const start = source.indexOf(startToken);
  if (start === -1) throw new Error(`Unable to find generated ${moduleName} augmentation`);

  const endToken = '} // declare module';
  const end = source.lastIndexOf(endToken);
  if (end === -1 || end <= start) throw new Error(`Unable to find the end of generated ${moduleName} augmentation`);

  return {
    prefix: source.slice(0, start),
    body: source
      .slice(start + startToken.length, end)
      .replace(/^\r?\n/, '')
      .replace(/^  /gm, ''),
  };
}

function readImports(source: string): RuntimeImport[] {
  const imports: RuntimeImport[] = [];
  const importPattern = /import type\s*{([\s\S]*?)}\s*from\s*['"]([^'"]+)['"];?/g;

  for (const match of source.matchAll(importPattern)) {
    const names = match[1]
      .split(',')
      .map(name => name.trim())
      .filter(Boolean);
    if (!names.length) continue;

    imports.push({
      moduleName: match[2],
      names,
    });
  }

  return imports;
}

function readPrefixDeclarations(source: string): string {
  const start = source.indexOf('export type ');
  return start === -1 ? '' : source.slice(start).trim();
}

function createImports(imports: RuntimeImport[]): string {
  const namesByModule = new Map<string, Set<string>>();
  const moduleByLocalName = new Map<string, string>();

  for (const runtimeImport of imports) {
    const names = namesByModule.get(runtimeImport.moduleName) ?? new Set<string>();
    namesByModule.set(runtimeImport.moduleName, names);

    for (const name of runtimeImport.names) {
      const localName = name.split(/\s+as\s+/).at(-1)!;
      const existingModule = moduleByLocalName.get(localName);
      if (existingModule && existingModule !== runtimeImport.moduleName) {
        throw new Error(`${localName} is imported from both ${existingModule} and ${runtimeImport.moduleName}`);
      }
      moduleByLocalName.set(localName, runtimeImport.moduleName);
      names.add(name);
    }
  }

  return [...namesByModule]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([moduleName, names]) => `import type { ${[...names].sort().join(', ')} } from '${moduleName}';`)
    .join('\n');
}

function createHeader(provenance: RuntimeCompatibilityProvenance): string {
  return [
    '// Generated by `yarn mainchain:pin`; do not edit.',
    `// Runtime compatibility source: mainnet spec ${provenance.specVersion} at ${provenance.finalizedBlockHash}, @argonprotocol/mainchain@${provenance.clientVersion}`,
  ].join('\n');
}

function indent(value: string): string {
  return value
    .split('\n')
    .map(line => (line ? `  ${line}` : line))
    .join('\n');
}
