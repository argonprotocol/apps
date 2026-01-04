<template>
  <div class="Spinner Component mr-3 h-6 min-h-6 w-6 min-w-6" />
</template>

<style scoped>
@reference "../main.css";

.Spinner {
  @apply relative -left-0.5 hidden h-8 min-h-8 w-8 min-w-8 border;

  border-radius: 50%;
  display: block;
  border: 10px solid;
  border-color: rgba(166, 0, 212, 0.15) rgba(166, 0, 212, 0.25) rgba(166, 0, 212, 0.35) rgba(166, 0, 212, 0.5);
  animation: rotation 1s linear infinite;
}

@keyframes rotation {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}
</style>
