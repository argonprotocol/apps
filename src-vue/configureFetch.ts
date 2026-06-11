import { setFetchImplementation } from '@argonprotocol/apps-core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

if ('__TAURI_INTERNALS__' in window) {
  setFetchImplementation(tauriFetch);
}
