import type { ArgonQueryClient } from '@argonprotocol/apps-core';
import {
  readReadonlyAccountIdentity,
  type ReadonlyAccountIdentity,
  type RuntimeOperationalAccount,
} from '../../scripts/troubleshootAccount.ts';

export const OPERATIONAL_ACCOUNT_FEATURES = ['bitcoin', 'bonds', 'mining', 'upstream', 'vault'] as const;
export type OperationalAccountFeature = (typeof OPERATIONAL_ACCOUNT_FEATURES)[number];

export interface OperationalAccountGraphNode {
  identity: ReadonlyAccountIdentity;
  operationalAccountId: string;
  upstreamOperationalAccountId?: string;
  features: OperationalAccountFeature[];
}

export class OperationalAccountGraph {
  private readonly nodesById: Map<string, OperationalAccountGraphNode>;
  private readonly neighborsById: Map<string, Set<string>>;

  constructor(public readonly nodes: OperationalAccountGraphNode[]) {
    this.nodesById = new Map(nodes.map(node => [node.operationalAccountId, node]));
    this.neighborsById = new Map(nodes.map(node => [node.operationalAccountId, new Set<string>()]));
    for (const node of nodes) {
      const upstreamId = node.upstreamOperationalAccountId;
      if (!upstreamId || !this.nodesById.has(upstreamId)) continue;
      this.neighborsById.get(node.operationalAccountId)!.add(upstreamId);
      this.neighborsById.get(upstreamId)!.add(node.operationalAccountId);
    }
  }

  public static async load(client: ArgonQueryClient): Promise<OperationalAccountGraph> {
    const entries = (await client.query.operationalAccounts.operationalAccounts.entries()) ?? [];
    const nodes = entries.flatMap(([key, profile]) => {
      if (!profile) return [];
      const operationalAccountId = String(key.args[0]);
      const upstreamOperationalAccountId =
        'upstreamAccount' in profile ? (profile.upstreamAccount ?? undefined) : (profile.sponsor ?? undefined);
      return [
        {
          identity: readReadonlyAccountIdentity(operationalAccountId, profile),
          operationalAccountId,
          upstreamOperationalAccountId: upstreamOperationalAccountId ?? undefined,
          features: OperationalAccountGraph.features(profile, upstreamOperationalAccountId != null),
        },
      ];
    });
    if (!nodes.length) throw new Error('The pinned runtime has no operational accounts');
    return new OperationalAccountGraph(nodes);
  }

  public selectConnectedScenarios(limit: number): OperationalAccountGraphNode[] {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error(`Operational account graph limit must be a positive safe integer, got ${limit}`);
    }

    const component = this.selectComponent();
    const anchor = [...component].sort((left, right) => this.compareNodes(left, right, new Set()))[0];
    const selected = [anchor];
    const selectedIds = new Set([anchor.operationalAccountId]);
    const coveredFeatures = new Set(anchor.features);

    while (selected.length < Math.min(limit, component.length)) {
      const frontier = component.filter(
        node =>
          !selectedIds.has(node.operationalAccountId) &&
          [...(this.neighborsById.get(node.operationalAccountId) ?? [])].some(id => selectedIds.has(id)),
      );
      if (!frontier.length) break;
      frontier.sort((left, right) => this.compareNodes(left, right, coveredFeatures));
      const next = frontier[0];
      selected.push(next);
      selectedIds.add(next.operationalAccountId);
      for (const feature of next.features) coveredFeatures.add(feature);
    }

    const missingFeatures = OPERATIONAL_ACCOUNT_FEATURES.filter(feature => !coveredFeatures.has(feature));
    if (missingFeatures.length) {
      throw new Error(
        `A connected selection of ${limit} operational accounts does not cover: ${missingFeatures.join(', ')}. Increase --account-limit or use a newer pinned graph.`,
      );
    }
    return selected;
  }

  private selectComponent(): OperationalAccountGraphNode[] {
    const remaining = new Set(this.nodesById.keys());
    const components: OperationalAccountGraphNode[][] = [];
    while (remaining.size) {
      const first = [...remaining].sort()[0];
      const queue = [first];
      const component: OperationalAccountGraphNode[] = [];
      remaining.delete(first);
      while (queue.length) {
        const id = queue.shift()!;
        component.push(this.nodesById.get(id)!);
        for (const neighborId of this.neighborsById.get(id) ?? []) {
          if (!remaining.delete(neighborId)) continue;
          queue.push(neighborId);
        }
      }
      components.push(component);
    }

    return components.sort((left, right) => {
      const coverageDifference =
        OperationalAccountGraph.coverage(right).size - OperationalAccountGraph.coverage(left).size;
      if (coverageDifference) return coverageDifference;
      const edgeDifference = OperationalAccountGraph.edgeCount(right) - OperationalAccountGraph.edgeCount(left);
      if (edgeDifference) return edgeDifference;
      if (left.length !== right.length) return right.length - left.length;
      return left[0].operationalAccountId.localeCompare(right[0].operationalAccountId);
    })[0];
  }

  private compareNodes(
    left: OperationalAccountGraphNode,
    right: OperationalAccountGraphNode,
    coveredFeatures: Set<OperationalAccountFeature>,
  ): number {
    const newFeatureDifference =
      right.features.filter(feature => !coveredFeatures.has(feature)).length -
      left.features.filter(feature => !coveredFeatures.has(feature)).length;
    if (newFeatureDifference) return newFeatureDifference;
    if (left.features.length !== right.features.length) return right.features.length - left.features.length;
    const degreeDifference =
      (this.neighborsById.get(right.operationalAccountId)?.size ?? 0) -
      (this.neighborsById.get(left.operationalAccountId)?.size ?? 0);
    if (degreeDifference) return degreeDifference;
    return left.operationalAccountId.localeCompare(right.operationalAccountId);
  }

  private static features(profile: RuntimeOperationalAccount, hasUpstream: boolean): OperationalAccountFeature[] {
    const features: OperationalAccountFeature[] = [];
    if (
      [
        profile.accountBitcoinAmount,
        profile.bitcoinAccrual,
        profile.bitcoinAppliedTotal,
        profile.bitcoinHighWatermark,
        profile.vaultBitcoinAccrual,
        profile.vaultBitcoinAppliedTotal,
      ].some(value => BigInt(value ?? 0) > 0n)
    ) {
      features.push('bitcoin');
    }
    if (profile.hasTreasuryPoolParticipation || BigInt(profile.accountVaultBondAmount ?? 0) > 0n) {
      features.push('bonds');
    }
    if (
      [profile.miningSeatAccrual, profile.miningSeatAppliedTotal, profile.miningSeatHighWatermark].some(
        value => Number(value ?? 0) > 0,
      )
    ) {
      features.push('mining');
    }
    if (hasUpstream) features.push('upstream');
    if (
      profile.vaultCreated ||
      BigInt(profile.vaultBitcoinAccrual ?? 0) > 0n ||
      BigInt(profile.vaultBitcoinAppliedTotal ?? 0) > 0n
    ) {
      features.push('vault');
    }
    return features;
  }

  private static coverage(nodes: OperationalAccountGraphNode[]): Set<OperationalAccountFeature> {
    return new Set(nodes.flatMap(node => node.features));
  }

  private static edgeCount(nodes: OperationalAccountGraphNode[]): number {
    const ids = new Set(nodes.map(node => node.operationalAccountId));
    return nodes.filter(node => node.upstreamOperationalAccountId && ids.has(node.upstreamOperationalAccountId)).length;
  }
}
