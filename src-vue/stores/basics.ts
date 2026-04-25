import * as Vue from 'vue';
import { defineStore } from 'pinia';

export const useBasics = defineStore('basics', () => {
  const overlayIsOpen = Vue.ref(false);

  return {
    overlayIsOpen,
  };
});
