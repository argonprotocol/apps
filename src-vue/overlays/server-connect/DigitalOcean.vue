<template>
  <DialogDescription class="mt-4 pr-10 font-light opacity-80">
    Argon Investor Console is built to natively support Digital Ocean. All you need to do is create an account, and
    copy/paste the API Key they give you. We'll then create the server, install all required software, and activate it
    for you. Simply follow the steps below to get started. Or, you can select other server options using the tabs
    located at the top of this overlay.
  </DialogDescription>

  <div Recommendation>
    <strong>RECOMMENDED:</strong>
    Digital Ocean is the preferred way to run your miner. It's inexpensive, easy to setup, and it doesn't require
    staying online 24/7.
  </div>

  <div class="mt-10 mb-16 flex grow flex-row">
    <div class="flex w-[43%] flex-col py-1">
      <div Browser class="flex h-full w-full flex-col rounded-md border border-slate-800/20 shadow">
        <div TopBar class="-mb-px flex h-8 flex-row items-center border-b border-slate-800/20">
          <div Controls class="ml-2 flex flex-row items-center space-x-1">
            <div class="h-3 w-3 rounded-full bg-red-500"></div>
            <div class="h-3 w-3 rounded-full bg-yellow-500"></div>
            <div class="h-3 w-3 rounded-full bg-green-500"></div>
          </div>
          <div
            class="relative top-px my-2 ml-2 grow items-center rounded-full border border-slate-800/20 bg-white py-px pl-5 text-xs text-slate-800/70">
            <SecureIcon class="absolute top-1/2 left-2 h-2.5 -translate-y-1/2 opacity-50" />
            https://digitalocean.com/
          </div>
          <div class="mx-2 mt-0.5 flex flex-col items-center space-y-[1.5px]">
            <div class="h-[3px] w-3 rounded-full bg-slate-600/50"></div>
            <div class="ounded-full h-[3px] w-3 bg-slate-600/50"></div>
            <div class="h-[3px] w-3 rounded-full bg-slate-600/50"></div>
          </div>
        </div>
        <div class="relative mx-px grow overflow-hidden rounded-b">
          <div
            v-if="currentStep === 1.0 || currentStep === 1.1 || currentStep === 1.2"
            class="absolute top-px left-0 flex h-full w-full flex-col">
            <img src="../../assets/digitalocean-1.0-topbar.png" class="w-full" />
            <div class="-mb-px w-full grow bg-[#000D79]" />
            <img src="../../assets/digitalocean-1.0-main.png" class="w-full" />
            <div class="-mt-px w-full grow bg-[#0169FF]" />
            <div
              v-if="currentStep === 1.1 || currentStep === 1.2"
              class="absolute top-5/12 left-1/2 w-5/12 max-w-[360px] -translate-x-1/2 -translate-y-1/2">
              <img src="../../assets/digitalocean-1.1-overlay.png" class="w-full" />
              <img
                v-if="currentStep === 1.2"
                src="../../assets/digitalocean-1.2-button.png"
                class="animate-pulse-button absolute top-[72%] left-[11.5%] w-[75%]" />
            </div>
          </div>
          <div v-else-if="currentStep === 1.3" class="absolute top-px left-0 flex h-full w-full flex-col">
            <img src="../../assets/digitalocean-1.3-top.png" class="w-full" />
            <div class="-mb-px w-full grow bg-[#D2E6FF]" />
            <img src="../../assets/digitalocean-1.3-middle.png" class="w-full" />
            <div class="-mt-px w-full grow bg-[#D2E6FF]" />
            <img src="../../assets/digitalocean-1.3-bottom.png" class="w-full" />
          </div>
          <div v-else-if="currentStep === 1.4" class="absolute top-px left-0 flex h-full w-full flex-col bg-[#EAECF1]">
            <img src="../../assets/digitalocean-1.4-top.png" class="w-full" />
            <div class="-mb-px w-full grow bg-[#EAECF1]" />
            <img src="../../assets/digitalocean-1.4-message.png" class="relative -top-[10%] z-10 mx-auto w-[39.8%]" />
            <div class="-mt-px w-full grow bg-[#EAECF1]" />
            <img src="../../assets/digitalocean-1.4-bottom.png" class="absolute bottom-0 left-0 w-full" />
          </div>
          <div
            v-else-if="currentStep >= 2 && currentStep < 3"
            class="absolute top-px left-0 flex h-full w-full flex-col">
            <img src="../../assets/digitalocean-2.0-billing.png" class="w-full" />
            <img
              v-if="currentStep === 2.2"
              src="../../assets/digitalocean-2.0-button.png"
              class="animate-pulse-button2 absolute top-[99px] left-[19.4%] w-[15.2%]" />
            <div v-if="currentStep === 2.3" class="absolute top-0 left-0 h-full w-full bg-white/70">
              <img
                src="../../assets/digitalocean-2.0-form.png"
                class="absolute top-1/2 left-1/2 w-[80%] max-w-[650px] -translate-x-1/2 -translate-y-1/2" />
            </div>
          </div>
          <div v-else class="absolute top-px left-0 flex h-full w-full flex-col">
            <img
              v-if="currentStep === 3.0 || currentStep === 3.1"
              src="../../assets/digitalocean-3.0-form.png"
              class="w-full" />
            <img v-else-if="currentStep === 3.2" src="../../assets/digitalocean-3.2-formfilled.png" class="w-full" />
            <img v-else-if="currentStep === 3.3" src="../../assets/digitalocean-3.3-finished.png" class="w-full" />
            <img v-else-if="currentStep === 3.3" src="../../assets/digitalocean-3.3-apikey.png" class="" />
          </div>
        </div>
      </div>
    </div>
    <div class="relative flex w-[5%] flex-col items-center">
      <div class="absolute top-0 -right-px h-full w-px bg-slate-800/20"></div>
    </div>

    <div class="relative z-20 flex w-[52%] flex-col pr-16">
      <AccordionRoot
        class="flex h-full grow flex-col"
        defaultValue="1"
        type="single"
        :modelValue="accordionValue"
        @update:modelValue="setAccordionValue">
        <AccordionItem value="1" class="flex flex-col data-[state=open]:grow">
          <AccordionHeader class="flex">
            <AccordionTrigger
              class="text-argon-700/40 hover:text-argon-600/70 group relative flex cursor-pointer flex-row items-center text-lg font-bold data-[state=open]:cursor-default data-[state=open]:text-slate-800/90">
              <div class="relative h-8 w-8 -translate-x-1/2 rounded-full border-3 border-white bg-white">
                <div
                  class="group-data-[state=open]:border-argon-700 group-data-[state=open]:bg-argon-500 absolute flex h-full w-full items-center justify-center rounded-full border border-slate-800/20 group-data-[state=open]:text-white">
                  1
                </div>
              </div>
              <span class="relative -left-2.5">Create a Digital Ocean Account</span>
            </AccordionTrigger>
          </AccordionHeader>
          <AccordionContent class="AnimateAccordionContent mt-4 flex flex-col space-y-1 overflow-hidden font-light">
            <p class="ml-6">
              Digital Ocean has $200 in promotional credits for new users, which means your first few months of mining
              won't cost a dime.
            </p>

            <p class="mt-3 ml-6">
              Warning: Do NOT click the signup link at the top of their website. It gives $0 in credits. Instead, do
              this...
            </p>

            <div
              HoverableStep
              :Current="currentStep === 1.1"
              :Selected="selectedStep === 1.0 || selectedStep === 1.1"
              class="group mt-2"
              @mouseover="mouseover(1.1)"
              @mouseleave="mouseleave(1.1)"
              @click="toggle(1.1)">
              <div CircleWrapper>
                <div CircleOutside>
                  <div CircleInside />
                </div>
                &nbsp;
              </div>
              <div StepContent>
                —>
                <a MainLink href="https://m.do.co/c/3fc891051aa9" target="_blank">
                  Open Digital Ocean's $200 in free credits.
                </a>
              </div>
            </div>

            <div
              HoverableStep
              :Current="currentStep === 1.2"
              :Selected="selectedStep === 1.2"
              class="group"
              @mouseover="mouseover(1.2)"
              @mouseleave="mouseleave(1.2)"
              @click="toggle(1.2)">
              <div CircleWrapper>
                <div CircleOutside>
                  <div CircleInside />
                </div>
                &nbsp;
              </div>
              <div StepContent>Click the "Get Started" button on the overlay.</div>
            </div>

            <div
              HoverableStep
              :Current="currentStep === 1.3"
              :Selected="selectedStep === 1.3"
              class="group"
              @mouseover="mouseover(1.3)"
              @mouseleave="mouseleave(1.3)"
              @click="toggle(1.3)">
              <div CircleWrapper>
                <div CircleOutside>
                  <div CircleInside />
                </div>
                &nbsp;
              </div>
              <div StepContent>
                Choose whether you want to use an existing auth service or directly sign up with your email.
              </div>
            </div>

            <div
              HoverableStep
              :Current="currentStep === 1.4"
              :Selected="selectedStep === 1.4"
              class="group"
              @mouseover="mouseover(1.4)"
              @mouseleave="mouseleave(1.4)"
              @click="toggle(1.4)">
              <div CircleWrapper>
                <div CircleOutside>
                  <div CircleInside />
                </div>
                &nbsp;
              </div>
              <div StepContent>Complete the final step of confirming your email address.</div>
            </div>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="2" class="mt-2 flex flex-col data-[state=open]:grow">
          <AccordionHeader class="flex">
            <AccordionTrigger
              class="text-argon-700/40 hover:text-argon-600/70 group relative flex cursor-pointer flex-row items-center text-lg font-bold data-[state=open]:cursor-default data-[state=open]:text-slate-800/90">
              <div class="relative h-8 w-8 -translate-x-1/2 rounded-full border-3 border-white bg-white">
                <div
                  class="group-data-[state=open]:border-argon-700 group-data-[state=open]:bg-argon-500 absolute flex h-full w-full items-center justify-center rounded-full border border-slate-800/20 group-data-[state=open]:text-white">
                  2
                </div>
              </div>
              <span class="relative -left-2.5">Add Your Credit Card</span>
            </AccordionTrigger>
          </AccordionHeader>
          <AccordionContent class="AnimateAccordionContent mt-4 flex flex-col space-y-1 overflow-hidden font-light">
            <p class="ml-6">
              Although your account has $200 in free server credits, Digital Ocean requires you to add a credit card
              before you can start creating servers. Click the following link to go straight to the billing page.
            </p>

            <div
              HoverableStep
              :Current="currentStep === 2.1"
              :Selected="selectedStep === 2.1"
              class="group mt-2"
              @mouseover="mouseover(2.1)"
              @mouseleave="mouseleave(2.1)"
              @click="toggle(2.1)">
              <div CircleWrapper>
                <div CircleOutside>
                  <div CircleInside />
                </div>
                &nbsp;
              </div>
              <div StepContent>
                —>
                <a MainLink href="https://cloud.digitalocean.com/account/billing" target="_blank">
                  Open Digital Ocean's Billing Page.
                </a>
              </div>
            </div>

            <div
              HoverableStep
              :Current="currentStep === 2.2"
              :Selected="selectedStep === 2.2"
              class="group"
              @mouseover="mouseover(2.2)"
              @mouseleave="mouseleave(2.2)"
              @click="toggle(2.2)">
              <div CircleWrapper>
                <div CircleOutside>
                  <div CircleInside />
                </div>
                &nbsp;
              </div>
              <div StepContent>Click the "Add Payment Method" button.</div>
            </div>

            <div
              HoverableStep
              :Current="currentStep === 2.3"
              :Selected="selectedStep === 2.3"
              class="group"
              @mouseover="mouseover(2.3)"
              @mouseleave="mouseleave(2.3)"
              @click="toggle(2.3)">
              <div CircleWrapper>
                <div CircleOutside>
                  <div CircleInside />
                </div>
                &nbsp;
              </div>
              <div StepContent>Fill out the form, and when you're finished, click the "Create" button.</div>
            </div>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="3" class="mt-2 flex flex-col data-[state=open]:grow">
          <AccordionHeader class="flex">
            <AccordionTrigger
              class="text-argon-700/40 hover:text-argon-600/70 group relative flex cursor-pointer flex-row items-center text-lg font-bold data-[state=open]:cursor-default data-[state=open]:text-slate-800/90">
              <div class="relative h-8 w-8 -translate-x-1/2 rounded-full border-3 border-white bg-white">
                <div
                  class="group-data-[state=open]:border-argon-700 group-data-[state=open]:bg-argon-500 absolute flex h-full w-full items-center justify-center rounded-full border border-slate-800/20 group-data-[state=open]:text-white">
                  3
                </div>
              </div>
              <span class="relative -left-2.5">Activate New API Key</span>
            </AccordionTrigger>
          </AccordionHeader>
          <AccordionContent class="AnimateAccordionContent mt-4 flex flex-col space-y-1 overflow-hidden font-light">
            <p class="ml-6">
              Digital Ocean requires all accounts -- even those with a free $200 -- to add a credit card before they can
              start creating servers. Click the following link to go straight to the billing page:
            </p>

            <div
              HoverableStep
              :Current="currentStep === 3.1"
              :Selected="selectedStep === 3.1"
              class="group mt-2"
              @mouseover="mouseover(3.1)"
              @mouseleave="mouseleave(3.1)"
              @click="toggle(3.1)">
              <div CircleWrapper>
                <div CircleOutside>
                  <div CircleInside />
                </div>
                &nbsp;
              </div>
              <div StepContent>
                <a MainLink href="https://cloud.digitalocean.com/account/api/tokens/new" target="_blank">
                  —> Open Digital Ocean's Create API Key.
                </a>
              </div>
            </div>

            <div
              HoverableStep
              :Current="currentStep === 3.2"
              :Selected="selectedStep === 3.2"
              class="group"
              @mouseover="mouseover(3.2)"
              @mouseleave="mouseleave(3.2)"
              @click="toggle(3.2)">
              <div CircleWrapper>
                <div CircleOutside>
                  <div CircleInside />
                </div>
                &nbsp;
              </div>
              <div StepContent>
                Enter a Token Name, select "Full Access" for the Scope, and click the "Generate Token" button.
              </div>
            </div>

            <div
              HoverableStep
              :Current="currentStep === 3.3"
              :Selected="selectedStep === 3.3"
              class="group"
              @mouseover="mouseover(3.3)"
              @mouseleave="mouseleave(3.3)"
              @click="toggle(3.3)">
              <div CircleWrapper>
                <div CircleOutside>
                  <div CircleInside />
                </div>
                &nbsp;
              </div>
              <div StepContent class="pr-4">
                Copy your newly created personal access token and paste it into the field below:
                <input
                  type="text"
                  v-model="apiKey"
                  placeholder="Digital Ocean API Key"
                  class="mt-3 mb-2 w-full rounded-md border border-slate-300 bg-white px-4 py-3" />
                <div
                  v-if="hasInvalidApiKeyError || hasUnauthorizedApiKeyError"
                  class="mt-1 mb-3 flex flex-row items-center">
                  <ExclamationTriangleIcon class="inline-block w-5 text-red-400" aria-hidden="true" />
                  <div class="ml-2 text-sm font-medium text-red-800">
                    {{
                      hasInvalidApiKeyError
                        ? 'This is an invalid API key.'
                        : 'This API key does not have the correct permissions.'
                    }}
                  </div>
                </div>
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>
      </AccordionRoot>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import {
  DialogDescription,
  AccordionRoot,
  AccordionItem,
  AccordionHeader,
  AccordionTrigger,
  AccordionContent,
} from 'reka-ui';
import SecureIcon from '../../assets/secure.svg?component';
import { IServerConnectChildExposed } from '../ServerConnectOverlay.vue';
import { IConfigServerCreationDigitalOcean } from '../../interfaces/IConfig';
import { MiningMachine } from '../../lib/MiningMachine';
import { ExclamationTriangleIcon } from '@heroicons/vue/20/solid';
import { useConfig } from '../../stores/config';

const emit = defineEmits(['ready']);

const config = useConfig();

const hasApiKey = !!config.serverCreation?.digitalOcean?.apiKey;
const accordionValue = Vue.ref(hasApiKey ? '3' : '1');
const selectedStep = Vue.ref(hasApiKey ? 3.1 : 1.0);
const hoveredStep = Vue.ref(0);
const currentStep = Vue.computed(() => hoveredStep.value || selectedStep.value);
const apiKey = Vue.ref(config.serverCreation?.digitalOcean?.apiKey ?? '');

const hasInvalidApiKeyError = Vue.ref(false);
const hasUnauthorizedApiKeyError = Vue.ref(false);

function setAccordionValue(value: string | string[] | undefined) {
  if (!value) return;
  selectedStep.value = Number(`${value}.1`);
  accordionValue.value = value as string;
}

function mouseover(step: number) {
  hoveredStep.value = step;
}

function mouseleave(step: number) {
  if (hoveredStep.value === step) {
    hoveredStep.value = 0;
  }
}

function toggle(step: number) {
  const majorVersion: '1' | '2' | '3' = step.toString().split('.')[0] as '1' | '2' | '3';
  if (selectedStep.value === step) {
    selectedStep.value = Number(majorVersion);
  } else {
    selectedStep.value = step;
  }
}

async function connect(): Promise<IConfigServerCreationDigitalOcean> {
  if (!apiKey.value) {
    throw new Error('API Key is required');
  }

  try {
    await MiningMachine.testDigitalOcean(apiKey.value);
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      hasUnauthorizedApiKeyError.value = true;
    }
    throw error;
  }

  return {
    apiKey: apiKey.value,
  };
}

Vue.watch(
  apiKey,
  () => {
    // DigitalOcean API key pattern: dop_v1_ followed by 64 hex characters
    const digitalOceanApiKeyRegex = /^dop_v1_[a-f0-9]{64}$/i;
    const isValid = digitalOceanApiKeyRegex.test(apiKey.value.trim());
    hasInvalidApiKeyError.value = !!apiKey.value && !isValid;
    hasUnauthorizedApiKeyError.value = false;
    emit('ready', isValid);
  },
  { immediate: true },
);

defineExpose<IServerConnectChildExposed>({ connect });
</script>

<style scoped>
@reference "../../main.css";

div[Recommendation] {
  @apply mt-4 rounded-md border border-green-700/20 bg-lime-50/50 px-5 py-4;
  strong {
    @apply text-lime-800;
  }
}

[HoverableStep] {
  @apply relative;
  &[Selected='true'] {
    [CircleInside] {
      @apply bg-argon-400/80;
    }
    [StepContent] {
      @apply border-slate-800/50;
    }
  }
}

[CircleWrapper] {
  @apply absolute flex flex-row items-center justify-center py-2;
}

[CircleOutside] {
  @apply absolute left-0 h-5 w-5 -translate-x-1/2 cursor-pointer rounded-full border-3 border-white bg-white;
}

[CircleInside] {
  @apply group-hover:bg-argon-300/40 absolute h-full w-full rounded-full border border-slate-800/40;
}

[StepContent] {
  @apply relative ml-1 rounded-md border border-l-0 border-dashed border-transparent py-2 pl-5 group-hover:border-slate-800/30;
}

a[MainLink] {
  @apply text-argon-500 hover:text-argon-600 hover:font-bold;
}

.AnimateAccordionContent {
  @apply relative -left-5 overflow-hidden pl-5;
}
.AnimateAccordionContent[data-state='open'] {
  animation: slideDown 300ms ease-out;
}
.AnimateAccordionContent[data-state='closed'] {
  animation: slideUp 300ms ease-out;
}

@keyframes slideDown {
  from {
    height: 0;
  }
  to {
    height: var(--reka-accordion-content-height);
  }
}

@keyframes slideUp {
  from {
    height: var(--reka-accordion-content-height);
  }
  to {
    height: 0;
  }
}

@keyframes pulseButton {
  0%,
  100% {
    transform: translateY(-50%) scale(1);
    opacity: 0.2;
  }
  50% {
    transform: translateY(-50%) scale(1.1);
    opacity: 1;
  }
}

.animate-pulse-button {
  animation: pulseButton 1s ease-in-out infinite;
}

@keyframes pulseButton2 {
  0%,
  100% {
    transform: translateY(-50%) scale(1);
  }
  50% {
    transform: translateY(-50%) scale(1.2);
  }
}

.animate-pulse-button2 {
  animation: pulseButton2 1s ease-in-out infinite;
}
</style>
