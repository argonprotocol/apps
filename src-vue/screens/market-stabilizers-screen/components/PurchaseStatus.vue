<template>
  <span v-if="status === StabilizerBuyStatus.SubmittingUsdcApprovalOnEthereum">Submitting USDC approval</span>
  <span v-else-if="status === StabilizerBuyStatus.ConfirmingUsdcApprovalOnEthereum">Confirming USDC approval</span>
  <span v-else-if="status === StabilizerBuyStatus.SubmittingPurchaseOnEthereum">Submitting Ethereum purchase</span>
  <span v-else-if="status === StabilizerBuyStatus.ConfirmingPurchaseOnEthereum">Confirming Ethereum purchase</span>
  <span v-else-if="status === StabilizerBuyStatus.WaitingForArgonRecognition">Waiting for Argon confirmation</span>
  <span v-else-if="status === StabilizerBuyStatus.WaitingForPrincipalReleaseOnArgon">ARGN held until release</span>
  <span v-else-if="status === StabilizerBuyStatus.Complete">Complete</span>
  <span v-else-if="status === StabilizerBuyStatus.Failed" class="text-red-700">Needs attention</span>
</template>

<script setup lang="ts">
import { StabilizerBuyStatus } from '../../../interfaces/IStabilizerBuyPurchase.ts';

defineProps<{ status: StabilizerBuyStatus }>();
</script>
