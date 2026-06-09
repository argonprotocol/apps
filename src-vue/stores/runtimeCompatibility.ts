import * as Vue from 'vue';
import { defineStore } from 'pinia';
import type { ArgonClient } from '@argonprotocol/mainchain';
import { fetch } from '@tauri-apps/plugin-http';
import { ENABLE_AUTO_UPDATE, IS_CAPITAL_APP, IS_EXPERIMENTAL_BUILD } from '../lib/Env.ts';
import { getMainchainClients } from './mainchain.ts';
import { useAppUpdater } from './appUpdater.ts';

export type RuntimeCompatibilityPhase = 'disabled' | 'loading' | 'compatible' | 'paused' | 'upgrade-required';

type Unsubscribe = () => void | Promise<void>;
type ClientType = 'archive' | 'pruned';

const BLOCKED_COMPATIBILITY_POLL_MILLIS = 60e3;
const UPDATE_CHECK_STALE_MILLIS = 60e3;

export const useRuntimeCompatibility = defineStore('runtimeCompatibility', () => {
  const phase = Vue.ref<RuntimeCompatibilityPhase>('disabled');
  const errorMessage = Vue.ref('');
  const isLoading = Vue.computed(() => phase.value === 'loading');
  const shouldShowCompatibilityScreen = Vue.computed(
    () => isLoading.value || phase.value === 'paused' || phase.value === 'upgrade-required',
  );

  const updater = useAppUpdater();

  let isStarted = false;
  let refreshPromise: Promise<void> | null = null;
  let blockedRefreshInterval: ReturnType<typeof setInterval> | null = null;
  const observedSpecVersionByClient = Vue.reactive<Record<ClientType, number | null>>({
    archive: null,
    pruned: null,
  });
  const stopRuntimeVersionSubscriptions: Partial<Record<ClientType, Unsubscribe>> = {};

  function start() {
    if (isStarted) {
      return;
    }

    isStarted = true;

    if (!ENABLE_AUTO_UPDATE) {
      phase.value = 'disabled';
      return;
    }

    phase.value = 'loading';
    void refreshCompatibility('startup');
    void subscribeToRuntimeVersion('archive').catch(error => {
      console.error('[runtime-compatibility] Failed to subscribe to archive runtime version', error);
    });

    if (getMainchainClients().prunedClientPromise) {
      void subscribeToRuntimeVersion('pruned').catch(error => {
        console.error('[runtime-compatibility] Failed to subscribe to pruned runtime version', error);
      });
    }

    getMainchainClients().events.on('on-pruned-client', () => {
      void subscribeToRuntimeVersion('pruned').catch(error => {
        console.error('[runtime-compatibility] Failed to switch pruned runtime version subscription', error);
      });
    });

    Vue.watch(
      () => updater.update?.version,
      version => {
        if (phase.value === 'paused' && version) {
          phase.value = 'upgrade-required';
          return;
        }

        if (phase.value === 'upgrade-required' && !version) {
          phase.value = 'paused';
        }
      },
    );

    Vue.watch(
      phase,
      nextPhase => {
        const shouldPollWhileBlocked = nextPhase === 'paused' || nextPhase === 'upgrade-required';
        if (!shouldPollWhileBlocked) {
          if (blockedRefreshInterval) {
            clearInterval(blockedRefreshInterval);
            blockedRefreshInterval = null;
          }
          return;
        }

        blockedRefreshInterval ??= setInterval(() => {
          void refreshCompatibility('poll');
        }, BLOCKED_COMPATIBILITY_POLL_MILLIS);
      },
      { immediate: true },
    );
  }

  async function loadObservedSpecVersion(clientType: ClientType): Promise<ArgonClient | undefined> {
    const client =
      clientType === 'archive'
        ? await getMainchainClients().archiveClientPromise
        : await getMainchainClients().prunedClientPromise;
    if (!client) {
      return;
    }

    observedSpecVersionByClient[clientType] = (await client.rpc.state.getRuntimeVersion()).specVersion.toNumber();
    return client;
  }

  async function subscribeToRuntimeVersion(clientType: ClientType) {
    const previousSpecVersion = observedSpecVersionByClient[clientType];
    const client = await loadObservedSpecVersion(clientType);
    if (!client) {
      return;
    }

    if (previousSpecVersion !== observedSpecVersionByClient[clientType]) {
      void refreshCompatibility('runtime-change');
    }

    if (stopRuntimeVersionSubscriptions[clientType]) {
      await stopRuntimeVersionSubscriptions[clientType]?.();
    }

    stopRuntimeVersionSubscriptions[clientType] = await client.rpc.state.subscribeRuntimeVersion(version => {
      const specVersion = version.specVersion.toNumber();
      if (observedSpecVersionByClient[clientType] === specVersion) {
        return;
      }

      observedSpecVersionByClient[clientType] = specVersion;
      void refreshCompatibility('runtime-change');
    });
  }

  async function getObservedSpecVersions() {
    const observedSpecVersions = Object.values(observedSpecVersionByClient).filter(
      (version): version is number => typeof version === 'number',
    );
    if (observedSpecVersions.length) {
      return observedSpecVersions;
    }

    await Promise.allSettled([loadObservedSpecVersion('archive'), loadObservedSpecVersion('pruned')]);

    const nextObservedSpecVersions = Object.values(observedSpecVersionByClient).filter(
      (version): version is number => typeof version === 'number',
    );
    if (!nextObservedSpecVersions.length) {
      throw new Error('Unable to determine the current Argon network version');
    }

    return nextObservedSpecVersions;
  }

  async function refreshCompatibility(reason: 'startup' | 'manual' | 'poll' | 'runtime-change' = 'manual') {
    if (phase.value === 'disabled') {
      return;
    }

    refreshPromise ??= (async () => {
      try {
        const version = await updater.ensureInstalledVersion();
        const specVersions = await getObservedSpecVersions();
        const channelName = `${IS_CAPITAL_APP ? 'capital' : 'operations'}-${IS_EXPERIMENTAL_BUILD ? 'experimental' : 'stable'}`;
        const response = await fetch(
          `https://raw.githubusercontent.com/argonprotocol/apps/refs/heads/main/release-channels/${channelName}-compatibility.json?t=${Date.now()}`,
        );

        let compatibilityByVersion: Record<string, { maxSpecVersion?: number }> = {};
        if (response.ok) {
          compatibilityByVersion = (await response.json()) ?? {};
        } else if (response.status !== 404) {
          console.warn(
            `[runtime-compatibility] Failed to load compatibility file: ${response.status} ${response.statusText}`,
          );
        }

        const compatibility = compatibilityByVersion[version];
        const maxSpecVersion = compatibility?.maxSpecVersion;
        const expectedClientCount = getMainchainClients().prunedClientPromise ? 2 : 1;
        const hasAllObservedClients = specVersions.length >= expectedClientCount;
        const areObservedSpecVersionsCompatible =
          !!compatibility &&
          specVersions.every(specVersion => typeof maxSpecVersion !== 'number' || specVersion <= maxSpecVersion);
        const isWaitingForAnotherClient =
          phase.value === 'loading' && !hasAllObservedClients && areObservedSpecVersionsCompatible;
        errorMessage.value = '';

        if (hasAllObservedClients && areObservedSpecVersionsCompatible) {
          phase.value = 'compatible';
          return;
        }

        if (isWaitingForAnotherClient) {
          return;
        }

        const hasRecentUpdateCheck =
          updater.lastCheckedAt && Date.now() - updater.lastCheckedAt.getTime() < UPDATE_CHECK_STALE_MILLIS;
        if (!hasRecentUpdateCheck || reason !== 'poll') {
          await updater.checkForUpdates();
        }

        phase.value = updater.update ? 'upgrade-required' : 'paused';
      } catch (error) {
        errorMessage.value = error instanceof Error ? error.message : String(error);

        if (phase.value !== 'paused' && phase.value !== 'upgrade-required') {
          phase.value = 'compatible';
        }

        console.error('[runtime-compatibility] Failed to refresh runtime compatibility', error);
      } finally {
        refreshPromise = null;
      }
    })();

    return refreshPromise;
  }

  return {
    phase,
    errorMessage,
    isLoading,
    shouldShowCompatibilityScreen,
    start,
    refreshCompatibility,
  };
});
