<template>
  <img :src="qrCode" :width="size" :height="size" v-bind="$attrs" alt="Bitcoin Psbt QR Code" />
</template>

<script setup type="ts">
import * as Vue from 'vue';

import QRCode from 'qrcode';
import { Buffer } from 'buffer';
import { UR, UREncoder } from '@ngraveio/bc-ur';
import { u8aToHex } from '@argonprotocol/mainchain';

window.Buffer = Buffer;

const props = defineProps({
  bytes: {
    type: Uint8Array,
    required: false,
  },
  isPsbt: {
    type: Boolean,
    default: false,
  },
  bip21: {
    type: String,
    required: false,
  },
  size: {
    type: Number,
    default: 256,
  },
});

let frames = [];
if (props.isPsbt) {
  const ur = new UR(Buffer.from(props.bytes), 'crypto-psbt');
  const encoder = new UREncoder(ur);
  frames = encoder.encodeWhole();
} else if (props.bip21) {
  frames.push(props.bip21);
} else {
  frames = [u8aToHex(props.bytes, undefined, false)];
}

const qrCode = Vue.ref('');
let index = 0;

Vue.onMounted(async () => {
  if (frames.length === 0) {
    console.warn('No frames to rotate');
    return;
  }
  qrCode.value = await QRCode.toDataURL(frames[0]);
  if (frames.length === 1) {
    return; // No need to rotate if there's only one frame
  }
  setInterval(async () => {
    index = (index + 1) % frames.length;
    qrCode.value = await QRCode.toDataURL(frames[index]);
  }, 250);
});
</script>
