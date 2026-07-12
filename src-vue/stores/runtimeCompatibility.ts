import * as Vue from 'vue';
import { defineStore } from 'pinia';
import { fetch, SingleFileQueue } from '@argonprotocol/apps-core';
import type { ArgonClient } from '@argonprotocol/mainchain';
import { ENABLE_AUTO_UPDATE, IS_EXPERIMENTAL_BUILD, IS_TREASURY_APP } from '../lib/Env.ts';
import { getMainchainClients } from './mainchain.ts';
import { useAppUpdater } from './appUpdater.ts';

export type RuntimeCompatibilityPhase = 'disabled' | 'loading' | 'compatible' | 'paused' | 'upgrade-required';

type CompatibilityInfo = { maxSpecVersion?: number; newDownloadRequired?: boolean };
type Unsubscribe = () => void | Promise<void>;
type ClientType = 'archive' | 'pruned';

const INITIAL_LOADING_POLL_MILLIS = 5e3;
const INITIAL_LOADING_TIMEOUT_MILLIS = 15e3;
const BLOCKED_COMPATIBILITY_POLL_MILLIS = 60e3;
const COMPATIBLE_COMPATIBILITY_POLL_MILLIS = 60 * 60e3;
const UPDATE_CHECK_STALE_MILLIS = 60e3;

export const useRuntimeCompatibility = defineStore('runtimeCompatibility', () => {
  const phase = Vue.ref<RuntimeCompatibilityPhase>('disabled');
  const errorMessage = Vue.ref('');
  const newDownloadRequired = Vue.ref(false);
  const isLoading = Vue.computed(() => phase.value === 'loading');
  const shouldShowCompatibilityScreen = Vue.computed(
    () => isLoading.value || phase.value === 'paused' || phase.value === 'upgrade-required',
  );

  const updater = useAppUpdater();

  let isStarted = false;
  const refreshQueue = new SingleFileQueue();
  let loadingStartedAt = 0;
  let refreshInterval: ReturnType<typeof setInterval> | null = null;
  let refreshIntervalMillis = 0;
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
    loadingStartedAt = Date.now();
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
        let pollMillis = 0;
        if (nextPhase === 'loading') {
          pollMillis = INITIAL_LOADING_POLL_MILLIS;
        } else if (nextPhase === 'paused' || nextPhase === 'upgrade-required') {
          pollMillis = BLOCKED_COMPATIBILITY_POLL_MILLIS;
        } else if (nextPhase === 'compatible') {
          pollMillis = COMPATIBLE_COMPATIBILITY_POLL_MILLIS;
        }

        if (!pollMillis) {
          if (refreshInterval) {
            clearInterval(refreshInterval);
            refreshInterval = null;
            refreshIntervalMillis = 0;
          }
          return;
        }

        if (refreshInterval && refreshIntervalMillis === pollMillis) {
          return;
        }

        if (refreshInterval) {
          clearInterval(refreshInterval);
        }

        refreshIntervalMillis = pollMillis;
        refreshInterval = setInterval(() => {
          void refreshCompatibility('poll');
        }, pollMillis);
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

    const specVersion = (await client.rpc.state.getRuntimeVersion()).specVersion.toNumber();
    observedSpecVersionByClient[clientType] = specVersion;
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

  async function loadCompatibilityByVersion(): Promise<Record<string, CompatibilityInfo>> {
    const channelName = `${IS_TREASURY_APP ? 'treasury' : 'operations'}-${IS_EXPERIMENTAL_BUILD ? 'experimental' : 'stable'}`;
    const response = await fetch(
      `https://raw.githubusercontent.com/argonprotocol/apps/refs/heads/main/release-channels/${channelName}-compatibility.json?t=${Date.now()}`,
    );

    if (response.ok) {
      return ((await response.json()) ?? {}) as Record<string, CompatibilityInfo>;
    }

    if (response.status !== 404) {
      console.warn(
        `[runtime-compatibility] Failed to load compatibility file: ${response.status} ${response.statusText}`,
      );
    }

    return {};
  }

  async function refreshCompatibility(reason: 'startup' | 'manual' | 'poll' | 'runtime-change' = 'manual') {
    if (phase.value === 'disabled') {
      return;
    }

    return refreshQueue.add(async () => {
      try {
        const version = await updater.ensureInstalledVersion();
        const compatibilityByVersion = await loadCompatibilityByVersion();
        const compatibility = compatibilityByVersion[version];
        const newDownloadRequiredForVersion = compatibility?.newDownloadRequired === true;
        newDownloadRequired.value = newDownloadRequiredForVersion;
        errorMessage.value = '';

        if (newDownloadRequiredForVersion) {
          phase.value = 'upgrade-required';
          return;
        }

        if (!observedSpecVersionByClient.archive) {
          await loadObservedSpecVersion('archive');
        }

        const specVersions = Object.values(observedSpecVersionByClient).flatMap(specVersion =>
          specVersion == null ? [] : [specVersion],
        );
        if (!specVersions.length) {
          throw new Error('Unable to determine the current Argon network version');
        }

        const maxSpecVersion = compatibility?.maxSpecVersion;

        if (maxSpecVersion == null || specVersions.every(specVersion => specVersion <= maxSpecVersion)) {
          phase.value = 'compatible';
          return;
        }

        const hasRecentUpdateCheck =
          updater.lastCheckedAt && Date.now() - updater.lastCheckedAt.getTime() < UPDATE_CHECK_STALE_MILLIS;
        if (!hasRecentUpdateCheck || reason !== 'poll') {
          await updater.checkForUpdates();
        }

        phase.value = updater.update ? 'upgrade-required' : 'paused';
      } catch (error) {
        if (phase.value === 'loading' && Date.now() - loadingStartedAt < INITIAL_LOADING_TIMEOUT_MILLIS) {
          return;
        }

        errorMessage.value = error instanceof Error ? error.message : String(error);

        if (phase.value !== 'paused' && phase.value !== 'upgrade-required') {
          phase.value = 'compatible';
        }

        console.error(`[runtime-compatibility] Failed to refresh runtime compatibility (${reason})`, error);
      }
    }).promise;
  }

  return {
    phase,
    errorMessage,
    newDownloadRequired,
    isLoading,
    shouldShowCompatibilityScreen,
    start,
    refreshCompatibility,
  };
});
