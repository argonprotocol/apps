import { Buffer } from 'buffer';

if (!('Buffer' in globalThis)) {
  Object.assign(globalThis, { Buffer });
}
