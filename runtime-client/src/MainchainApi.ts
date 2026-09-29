import { ApiPromise } from '@polkadot/api';
import type { ApiOptions } from '@polkadot/api/types';
import type { VersionedRegistry } from '@polkadot/api/base/types';
import { Metadata, TypeRegistry } from '@polkadot/types';
import type { RuntimeVersion, RuntimeVersionPartial } from '@polkadot/types/interfaces';
import { getSpecAlias, getSpecExtensions, getSpecHasher, getSpecTypes } from '@polkadot/types-known';
import type { HexString } from '@polkadot/util/types';
import { strFromU8, unzlibSync } from 'fflate';
import { compressedRuntimeMetadata } from './RuntimeMetadata.generated.js';

/**
 * ApiPromise's registry option initializes the current runtime, but api.at() does
 * not consult its metadata bundle for older runtimes. Use the public registry
 * lookup boundary to load our historical snapshots, retaining native lookup for
 * unknown chains, runtime names, and versions without an unambiguous snapshot.
 */
export class MainchainApi extends ApiPromise {
  private readonly registriesByRuntime = new Map<string, VersionedRegistry<'promise'>>();

  public static override async create(options: ApiOptions = {}): Promise<MainchainApi> {
    const client = new MainchainApi(options);
    if (!options.throwOnConnect) void client.isReadyOrError.catch(() => undefined);
    await (options.throwOnConnect ? client.isReadyOrError : client.isReady);
    return client;
  }

  constructor(options: ApiOptions = {}) {
    super({ ...options, metadata: { ...getBundledMetadata(), ...options.metadata } });
  }

  public override clone(): MainchainApi {
    return new MainchainApi({ ...this._options, source: this });
  }

  public override async getBlockRegistry(
    blockHash: Uint8Array,
    knownVersion?: RuntimeVersion,
  ): Promise<VersionedRegistry<'promise'>> {
    let version: RuntimeVersionPartial | undefined = knownVersion;
    if (!version) {
      const parentHash = this.genesisHash.eq(blockHash)
        ? this.genesisHash
        : this.registry.createType('HeaderPartial', await this.rpc.chain.getHeader.raw(blockHash)).parentHash;
      if (parentHash.isEmpty) throw new Error('Unable to retrieve header and parent from supplied hash');
      // Decoded historic RPC calls request a registry themselves; raw calls avoid that recursion.
      version = this.registry.createType(
        'RuntimeVersionPartial',
        await this.rpc.state.getRuntimeVersion.raw(parentHash),
      );
    }

    const metadataBytes = this._options.metadata?.[`${this.genesisHash.toHex()}-${version.specVersion.toString()}`];
    if (!metadataBytes || !version.specName.eq(this.runtimeVersion.specName)) {
      return await super.getBlockRegistry(blockHash, knownVersion);
    }

    const runtimeKey = `${version.specName.toString()}-${version.specVersion.toString()}`;
    let cached = this.registriesByRuntime.get(runtimeKey);
    if (!cached) {
      const registry = new TypeRegistry(blockHash);
      registry.setChainProperties(this.registry.getChainProperties());
      registry.setKnownTypes(this._options);
      registry.register(getSpecTypes(registry, this.runtimeChain, version.specName, version.specVersion));
      registry.setHasher(getSpecHasher(registry, this.runtimeChain, version.specName));
      if (registry.knownTypes.typesBundle) {
        registry.knownTypes.typesAlias = getSpecAlias(registry, this.runtimeChain, version.specName);
      }
      const metadata = new Metadata(registry, metadataBytes);
      registry.setMetadata(
        metadata,
        undefined,
        {
          ...getSpecExtensions(registry, this.runtimeChain, version.specName),
          ...this._options.signedExtensions,
        },
        this._options.noInitWarn,
      );
      cached = { counter: 0, metadata, registry, runtimeVersion: version };
      this.registriesByRuntime.set(runtimeKey, cached);
    }
    cached.counter += 1;
    cached.lastBlockHash = blockHash;
    return cached;
  }
}

let bundledMetadata: Readonly<Record<string, HexString>> | undefined;

/** Immutable bytes are shared; each API instance owns its mutable historical registries. */
export function getBundledMetadata(): Readonly<Record<string, HexString>> {
  if (bundledMetadata) return bundledMetadata;
  const compressed = Uint8Array.from(atob(compressedRuntimeMetadata), character => character.charCodeAt(0));
  const { genesisHashes, metadataBySpecVersion } = JSON.parse(strFromU8(unzlibSync(compressed))) as {
    genesisHashes: string[];
    metadataBySpecVersion: Record<number, HexString>;
  };
  bundledMetadata = Object.freeze(
    Object.fromEntries(
      genesisHashes.flatMap(genesisHash =>
        Object.entries(metadataBySpecVersion).map(([specVersion, bytes]) => [`${genesisHash}-${specVersion}`, bytes]),
      ),
    ),
  );
  return bundledMetadata;
}
