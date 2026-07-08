import * as Vue from 'vue';

const OVERLAY_BACKDROP_Z_INDEX = 1000;
const OVERLAY_Z_INDEX_STEP = 6;
const ROOT_FLOATING_Z_INDEX = OVERLAY_BACKDROP_Z_INDEX - OVERLAY_Z_INDEX_STEP;
const openOverlayZIndexes = new Set<number>();
const overlayContentZIndexKey = Symbol('overlay-content-z-index') as Vue.InjectionKey<
  Vue.Ref<number> | Vue.ComputedRef<number>
>;

export function getOverlayBackdropZIndex(contentZIndex: number) {
  if (!contentZIndex) {
    return OVERLAY_BACKDROP_Z_INDEX;
  }

  return contentZIndex - 1;
}

export function releaseOverlayZIndex(contentZIndex: number) {
  if (!contentZIndex) {
    return;
  }

  openOverlayZIndexes.delete(contentZIndex);
}

export function reserveOverlayZIndex(contentZIndex = 0) {
  releaseOverlayZIndex(contentZIndex);

  const nextZIndex = Math.max(OVERLAY_BACKDROP_Z_INDEX - 1, ...openOverlayZIndexes) + OVERLAY_Z_INDEX_STEP;
  openOverlayZIndexes.add(nextZIndex);
  return nextZIndex;
}

export function useOverlayZIndex(getIsOpen: () => boolean) {
  const contentZIndex = Vue.ref(0);

  function bringToFront() {
    if (!getIsOpen()) {
      return;
    }

    contentZIndex.value = reserveOverlayZIndex(contentZIndex.value);
  }

  Vue.watch(
    getIsOpen,
    isOpen => {
      if (!isOpen) {
        releaseOverlayZIndex(contentZIndex.value);
        contentZIndex.value = 0;
        return;
      }

      bringToFront();
    },
    { immediate: true },
  );

  Vue.onUnmounted(() => {
    releaseOverlayZIndex(contentZIndex.value);
  });

  return Vue.reactive({
    backdropZIndex: Vue.computed(() => getOverlayBackdropZIndex(contentZIndex.value)),
    contentZIndex,
    bringToFront,
  });
}

export function provideOverlayContentZIndex(contentZIndex: Vue.Ref<number> | Vue.ComputedRef<number>) {
  Vue.provide(overlayContentZIndexKey, contentZIndex);
}

export function useFloatingZIndex(offset = 1) {
  const parentOverlayContentZIndex = Vue.inject(overlayContentZIndexKey, undefined);
  const rootFloatingZIndex = ROOT_FLOATING_Z_INDEX + Math.max(offset - 1, 0);

  return Vue.computed(() => ({
    zIndex: parentOverlayContentZIndex ? parentOverlayContentZIndex.value + offset : rootFloatingZIndex,
  }));
}
