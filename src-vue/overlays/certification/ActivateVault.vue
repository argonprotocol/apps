<template>
  <div class="pl-2">
    <p
      v-if="myVault.createdVault && !controller.isCertificationStepComplete(OperationalStepId.ActivateVault)"
      class="text-md leading-7"
    >
      Increase your vault's Argon securitization to at least
      {{ microgonToArgonNm(controller.rewardConfig.operationalMinimumVaultSecuritization).format('0,0.[000000]') }}
      ARGN to complete this step. Start this task to open your vault's funding settings.
    </p>
    <template v-else>
      <p class="text-md leading-7">
        Stabilization Vaults lock Bitcoin into special contracts that help provide price stability for the Argon
        stablecoin. When you create a vault, you commit your own Argons as security for Bitcoin locked into the vault.
        Other users can then lock their Bitcoin into your vault, allowing it to grow while your Argons provide the
        backing for those deposits.
      </p>
      <p class="text-md mt-4 leading-7">
        To complete this step, choose Vaulting from the sidebar, select
        <strong>Activate Vault</strong>
        , and follow the prompts. After the transaction is confirmed, your vault becomes active and can begin earning
        revenue as it provides stabilization services for newly issued stablecoins.
      </p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { OperationalStepId, useCertificationController } from '../../stores/certificationController.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getMyVault } from '../../stores/vaults.ts';

const controller = useCertificationController();
const myVault = getMyVault();
const { microgonToArgonNm } = createNumeralHelpers(getCurrency());
</script>
