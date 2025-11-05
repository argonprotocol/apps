<script setup lang="ts">
// const releasingBitcoinProgress = Vue.computed(() => {
//   const lock = personalLock.value;
//   if (!lock) return 0;
//   return bitcoinLocks.getReleaseProcessingPercent(lock);
// });
</script>

<style scoped>
@reference "../../main.css";

@keyframes fade-progress {
  0%,
  100% {
    color: oklch(0.48 0.24 320 / 0.3); /* text-slate-600/50 */
  }
  50% {
    color: oklch(0.48 0.24 320 / 0.7); /* argon-600 at 50% */
  }
}

.fade-progress {
  animation: fade-progress 1s ease-in-out infinite;
}
</style>
