<template>
  <PopoverRoot :open="props.open" :modal="true" @update:open="emit('update:open', $event)">
    <PopoverTrigger asChild>
      <slot />
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        data-testid="ConnectorChannel"
        :data-e2e-state="channelE2eState"
        :data-channel-uuid="displayedChannel?.uuid"
        side="bottom"
        :align="props.direction === 'left' ? 'start' : 'end'"
        :alignOffset="-150"
        :sideOffset="props.channelUuid ? -8 : -20"
        :collisionPadding="30"
        :prioritizePosition="isAddingInsurance"
        :style="floatingZIndex"
        class="w-108 rounded-lg shadow-2xl"
        @pointerDownOutside="keepOpenForRelatedConnector"
      >
        <div
          class="flex max-h-[var(--reka-popover-content-available-height)] flex-col overflow-hidden rounded-lg border border-black/50 bg-white text-left text-gray-700"
        >
          <h2
            class="z-20 mx-1 flex shrink-0 items-center gap-x-2.5 border-b border-slate-400/50 pt-3 pr-3 pb-2 pl-2 select-none"
          >
            <button
              v-if="
                !isAddingInsurance &&
                (displayedChannel ||
                  isShowingArchivedChannels ||
                  canReturnToCosignerChoices ||
                  (isShowingChannelForm && hasChannelOverviewContent))
              "
              type="button"
              :aria-label="shouldReturnToArchivedChannels ? 'Back to archived channels' : 'Back to Bitcoin channels'"
              class="group hover:bg-argon-100/20 flex h-8 cursor-pointer items-center rounded-md py-1 pr-2 pl-1"
              @click="navigateBack"
            >
              <BackIcon class="relative -top-0.25 w-4 opacity-50 group-hover:opacity-100" />
            </button>
            <span class="min-w-0 grow px-1 text-xl font-bold text-slate-800/70">
              <template v-if="isAddingInsurance">
                {{ insuranceActionLabel }}
                <template v-if="displayedChannel">with {{ channelCosignerLabel(displayedChannel) }}</template>
              </template>
              <template v-else-if="displayedChannel">
                Bitcoin with {{ channelCosignerLabel(displayedChannel) }}
              </template>
              <template v-else-if="isShowingArchivedChannels">Archived channels</template>
              <template v-else-if="isChoosingCosigner">Choose a Vault</template>
              <template v-else-if="showChannelOverview">Bitcoin</template>
              <template v-else>Create Bitcoin Channel</template>
            </span>
            <ButtonClose @close="emit('update:open', false)" />
          </h2>
          <div class="min-h-0 overflow-y-auto">
            <div v-if="!config.hasExtensionTreasury" class="min-h-48 px-5 py-4">
              This feature requires access to Treasury.
              <button
                type="button"
                class="text-argon-600 cursor-pointer hover:underline"
                @click="requestTreasuryAccess"
              >
                Click to request access.
              </button>
            </div>
            <div
              v-else-if="isLoadingChannels"
              class="flex min-h-48 items-center justify-center px-5 py-4 text-slate-500"
            >
              Loading Bitcoin channels...
            </div>
            <div v-else-if="channelLoadError" class="min-h-48 px-5 py-4">
              <div class="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-3 text-sm text-amber-800">
                <AlertIcon class="mt-0.5 h-4 shrink-0" />
                <span>{{ channelLoadError }}</span>
              </div>
              <button
                class="border-argon-600 text-argon-600 mt-5 cursor-pointer rounded-lg border px-5 py-1"
                @click="retryLoadChannels"
              >
                Retry
              </button>
            </div>
            <div v-else-if="isCreatingChannel" class="min-h-48 px-5 py-7 text-center">
              <div class="text-lg font-semibold text-slate-700">Creating your Bitcoin channel</div>
              <div class="mt-1 text-sm text-slate-500">Preparing the Bitcoin channel request...</div>
              <ProgressBar :progress="0" class="mt-5 h-5" />
              <div class="mt-3 text-xs text-slate-400">You can close this window while the request continues.</div>
            </div>
            <div v-else-if="isShowingArchivedChannels" class="min-h-48 px-5 py-4">
              <button
                v-for="channel in archivedChannels"
                :key="channel.uuid"
                :data-channel-uuid="channel.uuid"
                type="button"
                class="hover:bg-argon-50/40 block w-full cursor-pointer border-b border-slate-300 px-1 py-3 text-left last:border-b-0"
                @click="showChannel(channel, true)"
              >
                <div class="flex items-center">
                  <span class="grow">Cosigner: {{ channelCosignerLabel(channel) }}</span>
                  <span>{{ satToBtcNm(channel.fundedSatoshis).format('0,0.[00000000]') }} BTC</span>
                  <span data-testid="ConnectorChannel.archivedChannelCaret" class="ml-2 flex shrink-0 items-center">
                    <ChevronRightIcon class="h-4 w-4 text-slate-400" />
                  </span>
                </div>
                <div class="mt-1 flex items-center gap-3 text-xs text-slate-500">
                  <span class="min-w-0 grow truncate font-mono">
                    {{ abbreviateAddress(channelScriptAddress(channel), 8) }}
                  </span>
                  <span>
                    Archived
                    {{
                      dayjs
                        .utc(channel.removalBlockTime ?? channel.updatedAt)
                        .local()
                        .format('MMM D, YYYY')
                    }}
                  </span>
                </div>
              </button>
            </div>
            <div v-else-if="showChannelOverview" class="min-h-48 px-5 py-4">
              <div
                v-if="securitizationHoldChannel?.status !== BitcoinLockStatus.LockFunded"
                class="flex items-center rounded-md bg-slate-50 px-4 py-3"
              >
                <span class="grow text-sm text-slate-600">No channel is currently open.</span>
                <button class="text-argon-600 cursor-pointer text-sm font-semibold" @click="showChannelForm">
                  Create Channel
                </button>
              </div>

              <div v-if="archivedChannels.length" class="mt-3 border-t border-slate-300 pt-3">
                <button
                  type="button"
                  class="text-argon-600 w-full cursor-pointer text-right text-sm hover:underline"
                  @click="showArchivedChannels"
                >
                  View {{ archivedChannels.length }} archived channel{{ archivedChannels.length === 1 ? '' : 's' }}
                </button>
              </div>

              <button
                v-if="securitizationHoldChannel?.status === BitcoinLockStatus.LockFunded"
                type="button"
                aria-label="View current Bitcoin channel"
                class="hover:bg-argon-50/40 mt-4 flex w-full cursor-pointer items-center border-t border-slate-300 px-1 pt-3 text-left"
                @click="showChannel(securitizationHoldChannel)"
              >
                <span class="min-w-0 grow">
                  <span class="block font-semibold text-slate-700">Current channel</span>
                  <span class="mt-0.5 block text-xs text-slate-500">
                    {{ satToBtcNm(securitizationHoldChannel.fundedSatoshis).format('0,0.[00000000]') }} BTC with
                    {{ channelCosignerLabel(securitizationHoldChannel) }}
                  </span>
                </span>
                <ChevronRightIcon class="size-4 shrink-0 text-slate-400" />
              </button>
            </div>
            <div v-else-if="displayedChannel" class="min-h-48 px-5 py-4">
              <div v-if="channelDisplayError" class="flex flex-col gap-4">
                <div class="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-3 text-sm text-amber-800">
                  <AlertIcon class="mt-0.5 h-4 shrink-0" />
                  <span>{{ channelDisplayError }}</span>
                </div>
                <button
                  class="border-argon-600 text-argon-600 cursor-pointer rounded-lg border px-5 py-1"
                  @click="showChannelForm"
                >
                  Create Another Channel
                </button>
              </div>
              <div v-else-if="displayedChannel.status === BitcoinLockStatus.Released" class="py-1">
                <div class="rounded-md bg-slate-50 px-4 py-3">
                  <div class="text-sm text-slate-500">Archived channel</div>
                  <div class="mt-0.5 text-2xl font-bold text-slate-800">
                    {{ satToBtcNm(displayedChannel.fundedSatoshis).format('0,0.[00000000]') }} BTC
                  </div>
                  <div class="mt-1 text-sm text-slate-500">
                    {{
                      dayjs
                        .utc(displayedChannel.removalBlockTime ?? displayedChannel.updatedAt)
                        .local()
                        .format('MMM D, YYYY')
                    }}
                  </div>
                </div>
                <div class="mt-4 border-y border-slate-200 text-sm">
                  <div class="flex items-start gap-4 py-3">
                    <span class="shrink-0 text-slate-500">Channel address</span>
                    <span class="min-w-0 grow text-right font-mono text-xs break-all text-slate-700">
                      {{ channelScriptAddress(displayedChannel) || 'Address unavailable' }}
                    </span>
                  </div>
                  <div class="flex items-start gap-4 border-t border-slate-200 py-3">
                    <span class="shrink-0 text-slate-500">Sent to</span>
                    <span class="min-w-0 grow text-right font-mono text-xs break-all text-slate-700">
                      {{ archivedDestinationAddress || 'Destination unavailable' }}
                    </span>
                  </div>
                  <div class="flex items-center gap-4 border-t border-slate-200 py-3">
                    <span class="grow text-slate-500">Cosigner</span>
                    <span>{{ channelCosignerLabel(displayedChannel) }}</span>
                  </div>
                </div>
                <a
                  v-if="archivedReleaseTxid"
                  :href="mempool.txUrl(archivedReleaseTxid)"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-argon-600 mt-4 inline-flex items-center gap-1 text-sm hover:underline"
                >
                  View Bitcoin transaction
                  <ArrowTopRightOnSquareIcon class="h-4 w-4" />
                </a>
              </div>
              <div
                v-else-if="
                  props.mode === 'insurance' &&
                  displayedChannel.status === BitcoinLockStatus.LockFunded &&
                  !hasPendingInboundUtxos
                "
                class="py-1"
              >
                <div v-if="isAddingInsuranceTransaction" class="space-y-4">
                  <ProgressBar :progress="addInsuranceProgressPct" :showLabel="false" class="h-4" />
                  <div class="text-sm text-slate-500">{{ addInsuranceProgressLabel }}</div>
                  <div class="text-xs text-slate-400">You can close this window without stopping the transaction.</div>
                  <button
                    disabled
                    class="bg-argon-600 w-full cursor-not-allowed rounded-md px-5 py-2 font-semibold text-white opacity-50"
                  >
                    Updating Insurance...
                  </button>
                </div>

                <div v-else class="space-y-4">
                  <div v-if="isLoadingAddInsuranceTerms" class="py-5 text-center text-sm text-slate-500">
                    Loading current insurance terms...
                  </div>
                  <div v-else class="relative flex flex-col">
                    <label class="mb-1 font-bold text-gray-500/80">Insurance guarantee</label>
                    <InputToken
                      v-model="addInsuranceTargetCoverageMicrogons"
                      data-testid="ConnectorChannel.addInsuranceAmount"
                      :prefix="argonSymbol"
                      :min="currentInsuranceCoverageMicrogons"
                      :max="maximumInsuranceCoverageMicrogons"
                      :maxDecimals="2"
                    />
                    <div class="mt-1 text-sm text-slate-500">
                      Supports up to
                      {{ satToBtcNm(addInsuranceSupportedSatoshis).format('0,0.[00000000]') }} BTC at the current market
                      price.
                    </div>
                    <SliderRoot
                      v-model="addInsuranceSliderValue"
                      class="relative mt-2 flex h-5 w-full touch-none items-center select-none"
                      :min="0"
                      :max="100"
                      :step="0.01"
                    >
                      <SliderTrack class="relative h-2 grow rounded-full bg-gray-500/30">
                        <SliderRange class="bg-argon-600/50 absolute h-full rounded-full" />
                      </SliderTrack>
                      <!-- prettier-ignore -->
                      <SliderThumb class="block h-6 w-6 rounded-full border border-gray-400 bg-white shadow-sm focus:outline-none" />
                    </SliderRoot>
                    <div class="mt-1 flex justify-between text-xs text-stone-400">
                      <span>
                        {{ argonSymbol }}{{ microgonToArgonNm(currentInsuranceCoverageMicrogons).format('0,0.00') }}
                        current
                      </span>
                      <span>
                        {{ argonSymbol }}{{ microgonToArgonNm(maximumInsuranceCoverageMicrogons).format('0,0.00') }}
                        maximum
                      </span>
                    </div>
                  </div>

                  <div
                    v-if="
                      !isLoadingAddInsuranceTerms &&
                      maximumInsuranceCoverageMicrogons <= currentInsuranceCoverageMicrogons
                    "
                    class="rounded-md bg-amber-50 px-3 py-3 text-sm text-amber-800"
                  >
                    {{ channelCosignerLabel(displayedChannel) }} does not currently have capacity for more insurance.
                  </div>

                  <div v-if="!isLoadingAddInsuranceTerms" class="flex flex-col gap-x-3">
                    <label class="mb-1 font-bold text-gray-500/80">Cost of Insurance</label>
                    <div class="border-b border-gray-300 text-sm">
                      <div class="flex border-t border-gray-300 py-2">
                        <span class="grow">Guaranteed repayment</span>
                        <span>
                          {{ argonSymbol }}{{ microgonToArgonNm(addInsuranceTargetCoverageMicrogons).format('0,0.00') }}
                        </span>
                      </div>
                      <div class="flex border-t border-gray-300 py-2">
                        <span class="grow">One-time insurance fee</span>
                        <span v-if="addInsuranceCouponCreditMicrogons">
                          <span class="mr-1 line-through">
                            {{ argonSymbol
                            }}{{
                              microgonToArgonNm(addInsuranceFeeMicrogons + addInsuranceCouponCreditMicrogons).format(
                                '0,0.00',
                              )
                            }}
                          </span>
                          {{ argonSymbol }}{{ microgonToArgonNm(addInsuranceFeeMicrogons).format('0,0.00') }}
                        </span>
                        <span v-else>
                          {{ argonSymbol }}{{ microgonToArgonNm(addInsuranceFeeMicrogons).format('0,0.00') }}
                        </span>
                      </div>
                      <div v-if="addInsuranceCouponCreditMicrogons" class="pb-2 text-xs text-slate-500">
                        {{ argonSymbol
                        }}{{ microgonToArgonNm(addInsuranceCouponCreditMicrogons).format('0,0.00') }} gift from
                        {{ upstreamOperatorName }}
                      </div>
                    </div>
                  </div>

                  <div v-if="addInsuranceError" class="text-sm font-semibold text-red-700">
                    {{ addInsuranceError }}
                  </div>

                  <div class="flex gap-2">
                    <button
                      class="border-argon-600 text-argon-600 cursor-pointer rounded-md border px-5 py-2"
                      @click="emit('update:open', false)"
                    >
                      Cancel
                    </button>
                    <button
                      :disabled="
                        isLoadingAddInsuranceTerms ||
                        addInsuranceTargetCoverageMicrogons <= currentInsuranceCoverageMicrogons
                      "
                      class="bg-argon-600 hover:bg-argon-700 grow cursor-pointer rounded-md px-5 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                      @click="submitAddInsurance"
                    >
                      {{ insuranceActionLabel }}
                    </button>
                  </div>
                </div>
              </div>
              <div v-else-if="isArgonChannelProcessing" class="py-3 text-center">
                <div class="text-lg font-semibold text-slate-700">Creating your Bitcoin channel</div>
                <div class="mt-1 text-sm text-slate-500">{{ channelProgressLabel }}</div>
                <ProgressBar :progress="channelProgress.progressPct" class="mt-5 h-5" />
                <div class="mt-3 text-xs text-slate-400">
                  You can close this window while the transaction continues.
                </div>
              </div>
              <div v-else class="flex flex-col items-center py-2 text-center">
                <div class="text-lg font-semibold text-slate-700">
                  {{ hasPendingInboundUtxos ? 'Bitcoin funding detected' : 'Your Bitcoin channel is ready' }}
                </div>
                <div
                  v-if="!hasPendingInboundUtxos && props.wallet.hasActiveSecuritizationHold(displayedChannel)"
                  class="bg-argon-100/30 text-argon-900/80 mt-2 flex items-center rounded-full py-1 pr-3 pl-1 text-sm"
                >
                  <ClockIcon class="h-4" />
                  <span class="mr-1">Insurance reservation:</span>
                  <CountdownClock :time="securitizationHoldExpirationTime" v-slot="{ days, hours, minutes, seconds }">
                    <template v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}</template>
                    <template v-if="days || hours">{{ hours }}h</template>
                    <template v-else>{{ minutes }}m {{ seconds }}s</template>
                  </CountdownClock>
                </div>
                <div class="mt-1 text-sm text-slate-500">
                  {{ hasPendingInboundUtxos ? channelProgressLabel : 'Send Bitcoin to add it to this channel.' }}
                </div>
                <div class="mt-4 w-full text-left">
                  <div class="mb-1 text-sm font-semibold text-slate-500">
                    Cosigner:
                    <span class="text-slate-700">{{ channelCosignerLabel(displayedChannel) }}</span>
                  </div>
                  <div class="flex items-center gap-2 rounded-md border border-slate-300 bg-slate-50 px-3 py-2">
                    <span data-testid="ConnectorChannel.fundingAddress" class="min-w-0 grow truncate font-mono text-xs">
                      {{ channelFundingAddress }}
                    </span>
                    <ButtonCopy :address="channelFundingAddress" />
                  </div>
                </div>
                <ProgressBar v-if="hasPendingInboundUtxos" :progress="channelProgress.progressPct" class="mt-5 h-5" />
              </div>
            </div>
            <div v-else-if="isChoosingCosigner" class="min-h-48 px-5 py-4">
              <p class="text-md font-light">Choose the vault that will cosign your reusable Bitcoin address.</p>

              <div class="mt-4 divide-y divide-slate-200 border-t border-slate-200">
                <div v-for="choice in cosignerChoices" :key="choice.vault.vaultId" class="flex items-center gap-2 py-3">
                  <button
                    type="button"
                    class="hover:bg-argon-50/40 min-w-0 grow cursor-pointer rounded px-2 py-1.5 text-left"
                    :data-testid="`ConnectorChannel.selectVault-${choice.vault.vaultId}`"
                    @click="selectCosigner(choice)"
                  >
                    <span class="flex min-w-0 items-center gap-1.5">
                      <span class="shrink-0 font-semibold text-slate-700">{{ choice.name }}</span>
                      <template v-if="choice.channelAddress">
                        <span :title="choice.channelAddress" class="min-w-0 truncate font-mono text-xs text-slate-500">
                          {{ abbreviateAddress(choice.channelAddress, 7) }}
                        </span>
                        <CopyToClipboard
                          :content="choice.channelAddress"
                          :data-testid="`ConnectorChannel.copyAddress-${choice.vault.vaultId}`"
                          class="relative flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-slate-400 hover:bg-slate-200/70 hover:text-slate-600"
                          title="Copy Bitcoin address"
                        >
                          <CopyIcon class="h-3.5 w-3.5" />
                          <template #copying><CheckIcon class="h-3.5 w-3.5 text-green-600" /></template>
                        </CopyToClipboard>
                      </template>
                    </span>
                    <template v-if="choice.channelAddress">
                      <span v-if="choice.fundingReservationExpiresAt" class="mt-0.5 block text-xs text-slate-500">
                        <template v-if="choice.fundingReservationExpiresAt > progressNow">
                          Funding reservation expires
                          {{ dayjs.utc(choice.fundingReservationExpiresAt).local().format('MMM D, YYYY h:mm A') }}
                        </template>
                        <template v-else>Funding reservation expired</template>
                      </span>
                    </template>
                    <span
                      v-else-if="choice.channel?.status === BitcoinLockStatus.LockIsProcessingOnArgon"
                      class="mt-0.5 block text-xs text-slate-500"
                    >
                      Channel creation in progress
                    </span>
                    <span v-else class="mt-0.5 block text-xs text-slate-500">
                      {{ choice.isOwnedVault ? 'Reusable personal Bitcoin address' : 'Create with insurance' }}
                    </span>
                  </button>
                  <Tooltip
                    :asChild="true"
                    :content="
                      choice.isOwnedVault
                        ? 'Your vault cosigns this Bitcoin address. No insurance guarantee is required.'
                        : 'This vault cosigns your Bitcoin address and can insure its Bitcoin against loss.'
                    "
                    side="top"
                  >
                    <button
                      type="button"
                      :aria-label="`About ${choice.name}`"
                      class="text-argon-600/30 hover:text-argon-600 mr-1 shrink-0 cursor-pointer p-1"
                    >
                      <InfoIcon class="w-4" />
                    </button>
                  </Tooltip>
                  <ChevronRightIcon class="size-4 shrink-0 text-slate-400" />
                </div>
              </div>

              <button
                v-if="archivedChannels.length"
                type="button"
                class="text-argon-600 mt-4 w-full cursor-pointer text-right text-sm hover:underline"
                @click="showArchivedChannels"
              >
                View {{ archivedChannels.length }} archived channel{{ archivedChannels.length === 1 ? '' : 's' }}
              </button>
            </div>
            <div v-else class="min-h-48 px-5 py-4">
              <p class="text-md font-light">
                <template v-if="isOwnedDefaultVault">
                  Create a reusable, personalized Bitcoin receive address into your vault.
                </template>
                <template v-else>Create a reusable Bitcoin receive address with your cosigner.</template>
              </p>

              <div v-if="!isOwnedDefaultVault" class="mt-4 flex flex-col">
                <label class="mb-1 font-bold text-gray-500/80">Cosigner</label>
                <div class="flex grow items-center rounded-md border border-slate-900/20 px-2 py-1.5 text-gray-500/80">
                  <span class="min-w-0 grow truncate whitespace-nowrap">{{ selectedCosignerLabel }}</span>
                  <Tooltip
                    :asChild="true"
                    content="A cosigner is a multisig guarantor of your BTC. They provide insurance against any loss of your underlying BTC so you can re-purchase if necessary."
                    side="top"
                  >
                    <button
                      type="button"
                      aria-label="About this cosigner"
                      class="text-argon-600/30 hover:text-argon-600 shrink-0 cursor-pointer"
                    >
                      <InfoIcon class="w-4" />
                    </button>
                  </Tooltip>
                </div>
              </div>

              <div v-if="!isOwnedDefaultVault" class="relative mt-4 flex flex-col">
                <div class="flex flex-row items-center">
                  <label class="mb-1 grow font-bold text-gray-500/80">Insurance guarantee</label>
                  <a
                    :href="`${NetworkConfig.websiteHost}/docs/assets-and-entities/bitcoin-locks`"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="text-sm opacity-50 hover:opacity-100"
                  >
                    Info
                  </a>
                </div>
                <InputToken
                  v-model="insuranceAmount"
                  data-testid="ConnectorChannel.insuranceAmount"
                  :data-microgons="insuranceAmount.toString()"
                  :prefix="argonSymbol"
                  :min="0n"
                  :max="maxValue"
                  :maxDecimals="2"
                />
                <SliderRoot
                  v-model="sliderValue"
                  class="relative mt-2 flex h-5 w-full touch-none items-center select-none"
                  :min="0"
                  :max="100"
                  :step="0.01"
                  @pointerdown.capture="isSliding = true"
                  @pointerup="isSliding = false"
                  @pointercancel="isSliding = false"
                  @lostpointercapture="isSliding = false"
                >
                  <SliderTrack class="relative h-2 grow rounded-full bg-gray-500/30">
                    <SliderRange class="bg-argon-600/50 absolute h-full rounded-full" />
                  </SliderTrack>
                  <!-- prettier-ignore -->
                  <SliderThumb class="block h-6 w-6 rounded-full border border-gray-400 bg-white shadow-sm focus:outline-none" />
                </SliderRoot>
                <div class="mt-1 flex justify-between text-xs text-stone-400">
                  <span>{{ currency.symbol }}0</span>
                  <span>{{ currency.symbol }}{{ microgonToArgonNm(maxValue).format('0,0.[00]') }}</span>
                </div>
              </div>
              <div v-if="!isOwnedDefaultVault" class="mt-6 flex flex-col gap-x-3">
                <label class="mb-1 font-bold text-gray-500/80">Cost of Channel</label>
                <div class="border-b border-gray-300 text-sm">
                  <div class="flex flex-row border-t border-gray-300 py-2">
                    <div class="grow">{{ insuranceAmount === 0n ? 'Base Channel Cost' : 'Insurance Fee' }}</div>
                    <div class="relative">
                      <template v-if="isVaultOperator">Waived</template>
                      <template v-else-if="channelCouponCreditMicrogons">
                        <span class="mr-1 line-through">
                          {{ argonSymbol }}{{ microgonToArgonNm(fullChannelFeeMicrogons).format('0,0.00') }}
                        </span>
                        {{ argonSymbol }}{{ microgonToArgonNm(channelFeeMicrogons).format('0,0.00') }}
                      </template>
                      <template v-else>
                        {{ argonSymbol }}{{ microgonToArgonNm(channelFeeMicrogons).format('0,0.00') }}
                      </template>
                    </div>
                  </div>
                  <div v-if="channelCouponCreditMicrogons" class="pb-2 text-xs text-slate-500">
                    {{ argonSymbol }}{{ microgonToArgonNm(channelCouponCreditMicrogons).format('0,0.00') }} fee waiver
                    from {{ couponProviderLabel }}
                  </div>
                  <div v-if="channelCostPreview" class="flex border-t border-gray-300 py-2">
                    <div class="grow">Network Fee (estimated)</div>
                    <div>
                      {{ argonSymbol
                      }}{{ microgonToArgonNm(channelCostPreview.txFeePlusTip).format('0,0.00', Math.ceil) }}
                    </div>
                  </div>
                  <div v-if="channelCostError" class="py-2 text-xs text-amber-700">
                    {{ channelCostError }}
                    <button type="button" class="text-argon-600 cursor-pointer underline" @click="channelCostRetry++">
                      Retry estimate
                    </button>
                  </div>
                  <div v-else-if="!channelCostPreview" class="py-2 text-xs text-slate-500">
                    Estimating required balance...
                  </div>
                </div>
              </div>

              <div v-if="formError" data-testid="ConnectorChannel.error" class="mt-5 text-sm text-amber-700">
                {{ formError }}
              </div>
              <div class="mt-8 mb-2 flex flex-row gap-x-2">
                <button
                  v-if="!isCreatingChannel"
                  class="border-argon-600 text-argon-600 cursor-pointer rounded-lg border px-5 py-1"
                  @click="emit('update:open', false)"
                >
                  Cancel
                </button>
                <button
                  :disabled="isCreatingChannel || !defaultVault"
                  class="border-argon-700 bg-argon-600 grow cursor-pointer rounded-lg border px-5 py-1 text-white disabled:cursor-default disabled:border-gray-400 disabled:bg-gray-300 disabled:text-gray-500"
                  @click="createChannel"
                >
                  {{
                    isCreatingChannel
                      ? 'Creating Channel...'
                      : isOwnedDefaultVault
                        ? 'Create Address'
                        : 'Create Channel'
                  }}
                  &raquo;
                </button>
              </div>
            </div>
          </div>
        </div>
        <PopoverArrow :width="26" :height="12" class="-mt-px fill-white stroke-gray-800/40 stroke-[0.5]" />
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<script setup lang="ts">
import {
  PopoverArrow,
  PopoverContent,
  PopoverPortal,
  PopoverRoot,
  PopoverTrigger,
  type PointerDownOutsideEvent,
  SliderTrack,
  SliderThumb,
  SliderRoot,
  SliderRange,
} from 'reka-ui';
import { useFloatingZIndex } from '../../overlays/helpers/OverlayZIndex.ts';
import ButtonClose from './ButtonClose.vue';
import ButtonCopy from './ButtonCopy.vue';
import InputToken from '../../components/InputToken.vue';
import CountdownClock from '../../components/CountdownClock.vue';
import CopyToClipboard from '../../components/CopyToClipboard.vue';
import Tooltip from '../../components/Tooltip.vue';
import * as Vue from 'vue';
import BigNumber from 'bignumber.js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { ArrowTopRightOnSquareIcon, CheckIcon, ChevronRightIcon } from '@heroicons/vue/24/outline';
import {
  bigIntMax,
  bigIntMin,
  bigNumberToBigInt,
  BitcoinLock,
  NetworkConfig,
  UnitOfMeasurement,
  type Vault,
} from '@argonprotocol/apps-core';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../../interfaces/IBitcoinLockRecord.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { abbreviateAddress } from '../../lib/Utils.ts';
import { trackTransactionProgress } from '../../lib/TransactionProgress.ts';
import type { TransactionInfo } from '../../lib/TransactionInfo.ts';
import type { IBitcoinResecuritizationMetadata } from '../../lib/txs/BitcoinLock.resecuritize.ts';
import type { WalletForBitcoin } from '../../lib/WalletForBitcoin.ts';
import type { IBitcoinLockCreatePreview } from '../../lib/txs/BitcoinLock.create.ts';
import { getCurrency } from '../../stores/currency.ts';
import InfoIcon from '../../assets/info.svg';
import CopyIcon from '../../assets/copy.svg';
import BackIcon from '../../assets/back.svg';
import { getConfig } from '../../stores/config.ts';
import { getMyVault, getVaults } from '../../stores/vaults.ts';
import AlertIcon from '../../assets/alert.svg?component';
import ClockIcon from '../../assets/clock.svg?component';
import ProgressBar from '../../components/ProgressBar.vue';
import { getBitcoinLockCoupons, getBitcoinLocks, getBitcoinTransactionOperations } from '../../stores/bitcoin.ts';
import { getMainchainClient, getMiningFrames } from '../../stores/mainchain.ts';
import { getWalletKeys } from '../../stores/wallets.ts';
import BitcoinMempool from '../../lib/BitcoinMempool.ts';
import { ESPLORA_HOST } from '../../lib/Env.ts';
import basicEmitter from '../../emitters/basicEmitter.ts';

dayjs.extend(utc);

const props = withDefaults(
  defineProps<{
    channelUuid?: string;
    connectorId?: string;
    direction: 'right' | 'left';
    mode?: 'channel' | 'insurance';
    open: boolean;
    vaultId?: number;
    wallet: WalletForBitcoin;
  }>(),
  { mode: 'channel' },
);

const emit = defineEmits<{
  (event: 'update:open', value: boolean): void;
}>();

const currency = getCurrency();
const floatingZIndex = useFloatingZIndex();
const config = getConfig();
const myVault = getMyVault();
const vaults = getVaults();
const bitcoinLocks = getBitcoinLocks();
const bitcoinLockCoupons = getBitcoinLockCoupons();
const { bitcoinLockResecuritize, bitcoinLockCreate } = getBitcoinTransactionOperations();
const walletKeys = getWalletKeys();
const miningFrames = getMiningFrames();

const { microgonToArgonNm, satToBtcNm } = createNumeralHelpers(currency);
const argonSymbol = currency.recordsByKey[UnitOfMeasurement.ARGN].symbol;

const isSliding = Vue.ref(false);
const selectedVaultId = Vue.ref('');
const insuranceAmount = Vue.ref(0n);
const channelCostPreview = Vue.ref<IBitcoinLockCreatePreview>();
const channelCostError = Vue.ref('');
const channelCostRetry = Vue.ref(0);
const maxValue = Vue.ref(0n);
const isCreatingChannelRequest = Vue.ref(false);
const isAddingInsurance = Vue.ref(false);
const isLoadingAddInsuranceTerms = Vue.ref(false);
const isAddingInsuranceTransaction = Vue.ref(false);
const maximumInsuranceCoverageMicrogons = Vue.ref(0n);
const addInsuranceTargetCoverageMicrogons = Vue.ref(0n);
const addInsuranceRateMicrogonsPerBtc = Vue.ref(0n);
const currentBitcoinPriceMicrogonsPerBtc = Vue.ref(0n);
const addInsuranceSupportedSatoshis = Vue.ref(0n);
const addInsuranceFeeMicrogons = Vue.ref(0n);
const addInsuranceCouponCreditMicrogons = Vue.ref(0n);
const addInsuranceProgressPct = Vue.ref(0);
const addInsuranceProgressLabel = Vue.ref('');
const addInsuranceError = Vue.ref('');
const isLoadingChannels = Vue.ref(false);
const channelLoadError = Vue.ref('');
const formError = Vue.ref('');
const sessionChannelUuid = Vue.ref<string>();
const openedChannel = Vue.ref<IBitcoinLockRecord>();
const isShowingChannelForm = Vue.ref(false);
const isShowingArchivedChannels = Vue.ref(false);
const shouldReturnToArchivedChannels = Vue.ref(false);
const mempool = new BitcoinMempool(ESPLORA_HOST);
const progressNow = Vue.ref(Date.now());
let channelSessionKey = 0;
let progressRefreshInterval: ReturnType<typeof setInterval> | undefined;
let addInsuranceProgressCleanupFns: (() => void)[] = [];
let trackedAddInsuranceTransactionId: number | undefined;
let unsubscribeInsuranceTicks: (() => void) | undefined;
let insuranceQuoteTick: number | undefined;
let supportedBitcoinRunId = 0;

const sliderValue = Vue.computed<number[]>({
  get: () =>
    maxValue.value === 0n
      ? [0]
      : [BigNumber(insuranceAmount.value.toString()).dividedBy(maxValue.value.toString()).multipliedBy(100).toNumber()],
  set: ([percentage]) => {
    insuranceAmount.value = bigNumberToBigInt(
      BigNumber(maxValue.value.toString())
        .multipliedBy(percentage ?? 0)
        .dividedBy(100),
    );
  },
});
const addInsuranceSliderValue = Vue.computed<number[]>({
  get: () => {
    const availableRange = maximumInsuranceCoverageMicrogons.value - currentInsuranceCoverageMicrogons.value;
    if (availableRange <= 0n) return [0];
    return [
      BigNumber(addInsuranceTargetCoverageMicrogons.value - currentInsuranceCoverageMicrogons.value)
        .dividedBy(availableRange.toString())
        .multipliedBy(100)
        .toNumber(),
    ];
  },
  set: ([percentage]) => {
    const availableRange = maximumInsuranceCoverageMicrogons.value - currentInsuranceCoverageMicrogons.value;
    addInsuranceTargetCoverageMicrogons.value =
      currentInsuranceCoverageMicrogons.value +
      bigNumberToBigInt(
        BigNumber(availableRange.toString())
          .multipliedBy(percentage ?? 0)
          .dividedBy(100),
      );
  },
});

const upstreamOperatorName = Vue.computed(() => {
  const upstreamOperator = config.upstreamOperator;
  return upstreamOperator?.name || 'Unnamed';
});
const couponProviderLabel = Vue.computed(() => config.upstreamOperator?.name || 'The vault operator');

const cosignerChoices = Vue.computed(() => {
  progressNow.value;
  const createChoice = (vault: Vault, name: string) => {
    const isOwnedVault = vault.vaultId === myVault.createdVault?.vaultId;
    const channel = props.wallet.findReusableChannelLock({ vaultId: vault.vaultId, isOwnedVault });
    let fundingReservationExpiresAt: number | undefined;
    if (channel && channel.status !== BitcoinLockStatus.LockIsProcessingOnArgon) {
      try {
        fundingReservationExpiresAt = bitcoinLocks.getSecuritizationHoldExpirationTime(channel);
      } catch {
        // Pending and recovered locks can temporarily lack funding-window terms.
      }
    }
    return {
      vault,
      name,
      isOwnedVault,
      channel,
      channelAddress: channel ? channelScriptAddress(channel) : '',
      fundingReservationExpiresAt,
    };
  };

  if (props.vaultId != null) {
    const vault =
      props.vaultId === myVault.createdVault?.vaultId ? myVault.createdVault : vaults.vaultsById[props.vaultId];
    if (!vault) return [];
    return [
      createChoice(vault, vault.vaultId === myVault.createdVault?.vaultId ? 'Your Vault' : upstreamOperatorName.value),
    ];
  }

  const choices: ReturnType<typeof createChoice>[] = [];
  const upstreamVaultId = config.upstreamOperator?.vaultId;
  const upstreamVault = upstreamVaultId == null ? undefined : vaults.vaultsById[upstreamVaultId];
  if (upstreamVault) choices.push(createChoice(upstreamVault, upstreamOperatorName.value));
  if (myVault.createdVault) choices.push(createChoice(myVault.createdVault, 'Your Vault'));
  return choices;
});
const defaultVault = Vue.computed(() => {
  return cosignerChoices.value.find(({ vault }) => vault.vaultId.toString() === selectedVaultId.value)?.vault;
});
const selectedCosignerLabel = Vue.computed(() => {
  return cosignerChoices.value.find(({ vault }) => vault.vaultId.toString() === selectedVaultId.value)?.name ?? '';
});
const isOwnedDefaultVault = Vue.computed(() => defaultVault.value?.vaultId === myVault.createdVault?.vaultId);
const isChoosingCosigner = Vue.computed(
  () => isShowingChannelForm.value && cosignerChoices.value.length > 1 && !defaultVault.value,
);
const canReturnToCosignerChoices = Vue.computed(
  () => !props.vaultId && cosignerChoices.value.length > 1 && !!defaultVault.value,
);
const securitizationHoldChannel = Vue.computed(() => {
  progressNow.value;
  return props.wallet.getChannelWithActiveSecuritizationHold();
});
const defaultDisplayedChannel = Vue.computed(() => {
  const choice = cosignerChoices.value.find(({ vault }) => vault.vaultId.toString() === selectedVaultId.value);
  return choice?.channel;
});
const displayedChannel = Vue.computed(() => {
  const uuid = sessionChannelUuid.value;
  if (!uuid) return;
  return props.wallet.getChannel(uuid) ?? (openedChannel.value?.uuid === uuid ? openedChannel.value : undefined);
});
const pendingAddInsuranceTxInfo = Vue.computed(() => {
  if (!props.open || props.mode !== 'insurance') return;
  const lockId = displayedChannel.value?.lockId;
  return lockId == null ? undefined : bitcoinLockResecuritize.getPendingResecuritizationTxInfo(lockId);
});
const archivedChannels = Vue.computed(() => props.wallet.getArchivedChannels());
const hasChannelOverviewContent = Vue.computed(() => archivedChannels.value.length > 0);
const showChannelOverview = Vue.computed(
  () => hasChannelOverviewContent.value && !displayedChannel.value && !isShowingChannelForm.value,
);
const currentInsuranceCoverageMicrogons = Vue.computed(
  () => displayedChannel.value?.securitizationCoverageMicrogons ?? 0n,
);
const insuranceActionLabel = Vue.computed(() =>
  currentInsuranceCoverageMicrogons.value > 0n ? 'Update Insurance' : 'Add Insurance',
);
const archivedRelease = Vue.computed(() => {
  const channel = displayedChannel.value;
  return channel?.status === BitcoinLockStatus.Released ? bitcoinLocks.releases.getLatestForLock(channel) : undefined;
});
const archivedDestinationAddress = Vue.computed(() => {
  const destination = archivedRelease.value?.toScriptPubkey;
  if (!destination) return '';
  try {
    return bitcoinLocks.formatAddressBytes(destination);
  } catch {
    return destination;
  }
});
const archivedReleaseTxid = Vue.computed(() => archivedRelease.value?.bitcoinTxid);
const releaseState = Vue.computed(() => bitcoinLocks.getLockUnlockReleaseState(displayedChannel.value));
const isArgonChannelProcessing = Vue.computed(
  () => displayedChannel.value?.status === BitcoinLockStatus.LockIsProcessingOnArgon,
);
const hasPendingInboundUtxos = Vue.computed(() => {
  const channel = displayedChannel.value;
  return channel ? bitcoinLocks.utxoTracking.getObservedFundingUtxos(channel).length > 0 : false;
});
const channelProgress = Vue.computed(() => {
  progressNow.value;
  const channel = displayedChannel.value;
  return channel
    ? props.wallet.getChannelProgress(channel)
    : { progressPct: 0, confirmations: -1, expectedConfirmations: 0 };
});
const channelFundingAddress = Vue.computed(() => {
  const channel = displayedChannel.value;
  if (!channel || isArgonChannelProcessing.value || channel.status === BitcoinLockStatus.LockFailed) return '';
  try {
    return props.wallet.getChannelFundingAddress(channel);
  } catch {
    return '';
  }
});

async function requestTreasuryAccess() {
  emit('update:open', false);
  await Vue.nextTick();
  basicEmitter.emit('openUpgradeToTreasuryOverlay');
}

function channelScriptAddress(channel: IBitcoinLockRecord): string {
  const scriptHash = channel.scriptDetails?.p2wshScriptHashHex;
  if (!scriptHash) return '';
  try {
    return bitcoinLocks.formatP2wshAddress(scriptHash);
  } catch {
    return '';
  }
}
const securitizationHoldExpirationTime = Vue.computed(() => {
  const channel = displayedChannel.value;
  return channel ? dayjs.utc(bitcoinLocks.getSecuritizationHoldExpirationTime(channel)) : dayjs.utc();
});
const channelDisplayError = Vue.computed(() => {
  const channel = displayedChannel.value;
  if (!channel) return '';
  const error = props.wallet.getChannelError(channel);
  if (error) return error;
  if (channel.status === BitcoinLockStatus.LockPendingFunding && !channelFundingAddress.value) {
    return 'Unable to load the Bitcoin funding address for this channel.';
  }
  return '';
});
const channelProgressLabel = Vue.computed(() => {
  const { confirmations, expectedConfirmations } = channelProgress.value;
  if (isArgonChannelProcessing.value) {
    if (confirmations < 0 || expectedConfirmations <= 0) return 'Submitting to the Argon network...';
    return `Argon confirmation ${Math.min(confirmations + 1, expectedConfirmations)} of ${expectedConfirmations}`;
  }
  if (confirmations < 0) return 'Detected in the Bitcoin mempool. Waiting for the first confirmation...';
  if (expectedConfirmations <= 0) return 'Bitcoin funding detected.';
  return `Bitcoin confirmation ${Math.min(confirmations + 1, expectedConfirmations)} of ${expectedConfirmations}`;
});
const isVaultOperator = Vue.computed(() => {
  return walletKeys.defaultArgonAddress === defaultVault.value?.operatorAccountId;
});
const operatorCoupon = Vue.computed(() => {
  const vault = defaultVault.value;
  if (!vault) return;

  const resumableCoupon = bitcoinLockCoupons.resumableCoupon;
  const currentCoupon = bitcoinLockCoupons.currentCoupon;
  let coupon;
  if (resumableCoupon?.coupon.vaultId === vault.vaultId) coupon = resumableCoupon;
  else if (currentCoupon?.coupon.vaultId === vault.vaultId) coupon = currentCoupon;
  if (!coupon) return;
  if (coupon.coupon.expirationTick != null && miningFrames.currentTick >= coupon.coupon.expirationTick) return;

  return {
    vaultId: coupon.coupon.vaultId,
    offerCode: coupon.coupon.offerCode,
    accountId: coupon.coupon.accountId,
    remainingFeeCreditMicrogons: coupon.remainingFeeCreditMicrogons,
    pendingInitialization: coupon.uses?.find(use => use.status === 'Prepared' && use.feeCoupon),
  };
});
const fullChannelFeeMicrogons = Vue.computed(() => {
  return defaultVault.value?.calculateBitcoinFee(insuranceAmount.value) ?? 0n;
});
const channelCouponCreditMicrogons = Vue.computed(() => {
  const vault = defaultVault.value;
  const coupon = operatorCoupon.value;
  if (!vault || !coupon) return 0n;

  const variableFee = bigIntMax(fullChannelFeeMicrogons.value - vault.terms.bitcoinBaseFee, 0n);
  const availableCredit =
    (coupon.remainingFeeCreditMicrogons ?? 0n) + (coupon.pendingInitialization?.feeCreditMicrogons ?? 0n);
  return bigIntMin(variableFee, availableCredit);
});
const channelFeeMicrogons = Vue.computed(() => {
  if (isVaultOperator.value) return 0n;
  return fullChannelFeeMicrogons.value - channelCouponCreditMicrogons.value;
});
const isCreatingChannel = Vue.computed(() => {
  const vaultId = defaultVault.value?.vaultId;
  return isCreatingChannelRequest.value || (vaultId != null && props.wallet.isCreatingChannel(vaultId));
});
const channelE2eState = Vue.computed(() => {
  if (!config.hasExtensionTreasury) return 'Unavailable';
  if (isLoadingChannels.value) return 'Loading';
  if (channelLoadError.value || channelDisplayError.value) return 'Error';
  if (isCreatingChannel.value || isArgonChannelProcessing.value) return 'ProcessingOnArgon';
  if (isChoosingCosigner.value) return 'ChooseVault';
  if (showChannelOverview.value) return 'Overview';
  if (!displayedChannel.value) return 'Create';
  if (displayedChannel.value.status === BitcoinLockStatus.Released) return 'Archived';
  if (hasPendingInboundUtxos.value) return 'ProcessingOnBitcoin';
  if (displayedChannel.value.status === BitcoinLockStatus.LockFunded) return 'Funded';
  return 'ReadyForBitcoin';
});

Vue.watch(defaultVault, (vault, _, onCleanup) => void updateMaximumInsurance(vault, onCleanup), { immediate: true });
Vue.watch(
  [
    () => props.open,
    channelE2eState,
    defaultVault,
    insuranceAmount,
    channelCouponCreditMicrogons,
    fullChannelFeeMicrogons,
    channelCostRetry,
  ],
  async ([open, state, vault, liquidityMicrogons, feeDiscountMicrogons], _, onCleanup) => {
    channelCostPreview.value = undefined;
    channelCostError.value = '';
    if (!open || state !== 'Create' || !vault || isOwnedDefaultVault.value) return;

    let cancelled = false;
    const timeout = setTimeout(() => {
      cancelled = true;
      channelCostError.value = 'Unable to estimate the required balance. Please retry.';
    }, 15_000);
    onCleanup(() => {
      cancelled = true;
      clearTimeout(timeout);
    });
    try {
      const satoshis =
        liquidityMicrogons === 0n ? 0n : await bitcoinLocks.satoshisForArgonLiquidity(liquidityMicrogons);
      const txSigner = await walletKeys.getLiquidLockingKeypair();
      if (cancelled) return;
      const preview = await bitcoinLockCreate.preview({ vault, satoshis, txSigner, feeDiscountMicrogons });
      if (!cancelled) channelCostPreview.value = preview;
    } catch {
      if (!cancelled) channelCostError.value = 'Unable to estimate the required balance. Please retry.';
    } finally {
      clearTimeout(timeout);
    }
  },
  { immediate: true },
);
Vue.watch(
  () => releaseState.value.isReleaseStatus,
  isReleasing => {
    if (isReleasing) emit('update:open', false);
  },
);
Vue.watch(
  cosignerChoices,
  choices => {
    if (choices.some(({ vault }) => vault.vaultId.toString() === selectedVaultId.value)) return;
    selectedVaultId.value =
      props.vaultId != null || choices.length === 1 ? (choices[0]?.vault.vaultId.toString() ?? '') : '';
  },
  { immediate: true },
);
Vue.watch(
  () => [props.open, props.vaultId, props.channelUuid] as const,
  ([open], _, onCleanup) => {
    const sessionKey = ++channelSessionKey;
    if (!open) {
      sessionChannelUuid.value = undefined;
      openedChannel.value = undefined;
      selectedVaultId.value =
        !props.vaultId && cosignerChoices.value.length > 1
          ? ''
          : (cosignerChoices.value[0]?.vault.vaultId.toString() ?? '');
      isShowingChannelForm.value = false;
      isShowingArchivedChannels.value = false;
      shouldReturnToArchivedChannels.value = false;
      stopAddingInsurance();
      formError.value = '';
      return;
    }
    void loadChannels(sessionKey, onCleanup);
  },
  { immediate: true },
);
Vue.watch(
  () => props.open,
  open => {
    if (progressRefreshInterval) clearInterval(progressRefreshInterval);
    progressRefreshInterval = undefined;
    if (!open) return;

    progressNow.value = Date.now();
    progressRefreshInterval = setInterval(() => (progressNow.value = Date.now()), 1_000);
  },
  { immediate: true },
);
Vue.watch(
  [addInsuranceTargetCoverageMicrogons, currentBitcoinPriceMicrogonsPerBtc],
  async ([coverageMicrogons, currentBitcoinPrice]) => {
    updateAddInsuranceFee();
    const runId = ++supportedBitcoinRunId;
    if (!coverageMicrogons || !currentBitcoinPrice) {
      addInsuranceSupportedSatoshis.value = 0n;
      return;
    }

    const supportedSatoshis = await bitcoinLocks.satoshisForArgonLiquidity(coverageMicrogons, currentBitcoinPrice);
    if (runId !== supportedBitcoinRunId) return;
    addInsuranceSupportedSatoshis.value = bigIntMin(displayedChannel.value?.fundedSatoshis ?? 0n, supportedSatoshis);
  },
);
Vue.watch(
  defaultDisplayedChannel,
  (channel, previousChannel) => {
    if (!props.open || props.mode === 'insurance') return;

    const requestedChannel = displayedChannel.value;
    if (props.channelUuid && requestedChannel?.uuid === props.channelUuid) {
      if (shouldDisplayRequestedChannel(requestedChannel)) return;

      openedChannel.value = channel;
      sessionChannelUuid.value = channel?.uuid;
      return;
    }

    if (props.channelUuid) return;
    if (sessionChannelUuid.value && sessionChannelUuid.value !== previousChannel?.uuid) return;
    if (!channel && displayedChannel.value) return;

    openedChannel.value = channel;
    sessionChannelUuid.value = channel?.uuid;
  },
  { immediate: true },
);
Vue.watch(
  pendingAddInsuranceTxInfo,
  txInfo => {
    if (txInfo) trackAddInsuranceTransaction(txInfo);
  },
  { immediate: true },
);
Vue.watch(
  () => [props.open, props.channelUuid, displayedChannel.value?.uuid, displayedChannel.value?.status] as const,
  ([open, requestedChannelUuid, displayedChannelUuid, status]) => {
    if (
      props.mode !== 'insurance' ||
      !open ||
      !requestedChannelUuid ||
      !displayedChannelUuid ||
      status !== BitcoinLockStatus.LockFunded
    ) {
      return;
    }
    if (!isAddingInsurance.value) void beginAddInsurance();
  },
  { immediate: true },
);

async function loadChannels(sessionKey = channelSessionKey, onCleanup?: (cleanup: () => void) => void): Promise<void> {
  let cancelled = false;
  onCleanup?.(() => (cancelled = true));
  isLoadingChannels.value = true;
  channelLoadError.value = '';
  try {
    await props.wallet.loadChannels();
    if (cancelled || sessionKey !== channelSessionKey || !props.open) return;
    let channel: IBitcoinLockRecord | undefined;
    if (props.channelUuid) {
      const requestedChannel = props.wallet.getChannel(props.channelUuid);
      if (!requestedChannel) throw new Error('The requested Bitcoin channel is no longer available.');
      if (shouldDisplayRequestedChannel(requestedChannel)) channel = requestedChannel;
    } else {
      channel = defaultDisplayedChannel.value;
    }
    openedChannel.value = channel;
    sessionChannelUuid.value = channel?.uuid;
    if (!channel && (cosignerChoices.value.length > 1 || !hasChannelOverviewContent.value)) {
      isShowingChannelForm.value = true;
    }
  } catch (error) {
    if (!cancelled && sessionKey === channelSessionKey) {
      channelLoadError.value = error instanceof Error ? error.message : 'Unable to load Bitcoin channels.';
    }
  } finally {
    if (!cancelled && sessionKey === channelSessionKey) isLoadingChannels.value = false;
  }
}

async function retryLoadChannels(): Promise<void> {
  void bitcoinLocks.load().catch(() => undefined);
  await loadChannels();
}

function shouldDisplayRequestedChannel(channel: IBitcoinLockRecord): boolean {
  if (props.mode === 'insurance') return true;
  if (channel.status === BitcoinLockStatus.LockFailed) return true;
  if (props.wallet.hasActiveSecuritizationHold(channel)) return true;
  return bitcoinLocks.utxoTracking.getObservedFundingUtxos(channel).length > 0;
}

async function updateMaximumInsurance(vault: Vault | undefined, onCleanup: (cleanup: () => void) => void) {
  maxValue.value = 0n;
  if (!vault) return;

  let cancelled = false;
  onCleanup(() => (cancelled = true));

  try {
    const availableLiquidityMicrogons = await props.wallet.getMaximumChannelLiquidity(vault);
    if (cancelled) return;

    maxValue.value = availableLiquidityMicrogons;
    if (insuranceAmount.value > availableLiquidityMicrogons) {
      insuranceAmount.value = availableLiquidityMicrogons;
    }
  } catch (error) {
    if (!cancelled) console.warn('Unable to load the Bitcoin channel capacity:', error);
  }
}

async function createChannel() {
  const vault = defaultVault.value;
  const liquidityMicrogons = isOwnedDefaultVault.value ? 0n : insuranceAmount.value;
  if (!vault || liquidityMicrogons < 0n || isCreatingChannel.value) return;

  const sessionKey = channelSessionKey;
  const coupon = channelCouponCreditMicrogons.value > 0n ? operatorCoupon.value : undefined;
  isCreatingChannelRequest.value = true;
  formError.value = '';
  try {
    const channel = await props.wallet.createChannel({
      vault,
      liquidityMicrogons,
      txSigner: await walletKeys.getLiquidLockingKeypair(),
      operatorCoupon: coupon,
      isOwnedVault: isOwnedDefaultVault.value,
    });
    if (props.open && sessionKey === channelSessionKey) {
      openedChannel.value = channel;
      sessionChannelUuid.value = channel.uuid;
    }
  } catch (error) {
    if (props.open && sessionKey === channelSessionKey) {
      formError.value = error instanceof Error ? error.message : 'Unable to create the Bitcoin channel.';
    }
  } finally {
    if (coupon) {
      void bitcoinLockCoupons.refresh().catch(error => {
        console.warn('Unable to refresh the Bitcoin fee coupon after channel creation', error);
      });
    }
    isCreatingChannelRequest.value = false;
  }
}

function showChannelForm() {
  sessionChannelUuid.value = undefined;
  openedChannel.value = undefined;
  if (!props.vaultId && cosignerChoices.value.length > 1) selectedVaultId.value = '';
  isShowingChannelForm.value = true;
  isShowingArchivedChannels.value = false;
  shouldReturnToArchivedChannels.value = false;
}

function selectCosigner(choice: (typeof cosignerChoices.value)[number]): void {
  selectedVaultId.value = choice.vault.vaultId.toString();
  if (choice.channel) showChannel(choice.channel);
}

function showChannel(channel: IBitcoinLockRecord, returnToArchivedChannels = false) {
  openedChannel.value = channel;
  sessionChannelUuid.value = channel.uuid;
  isShowingChannelForm.value = false;
  isShowingArchivedChannels.value = false;
  shouldReturnToArchivedChannels.value = returnToArchivedChannels;
  stopAddingInsurance();
}

function showArchivedChannels() {
  sessionChannelUuid.value = undefined;
  openedChannel.value = undefined;
  isShowingChannelForm.value = false;
  isShowingArchivedChannels.value = true;
  shouldReturnToArchivedChannels.value = false;
  stopAddingInsurance();
}

function showChannels() {
  sessionChannelUuid.value = undefined;
  openedChannel.value = undefined;
  if (!props.vaultId && cosignerChoices.value.length > 1) selectedVaultId.value = '';
  isShowingChannelForm.value = !props.vaultId && cosignerChoices.value.length > 1;
  isShowingArchivedChannels.value = false;
  shouldReturnToArchivedChannels.value = false;
  stopAddingInsurance();
}

function navigateBack(): void {
  if (shouldReturnToArchivedChannels.value) {
    showArchivedChannels();
  } else if (isShowingArchivedChannels.value) {
    showChannels();
  } else if (canReturnToCosignerChoices.value) {
    showChannelForm();
  } else {
    showChannels();
  }
}

function stopAddingInsurance(): void {
  isAddingInsurance.value = false;
  isLoadingAddInsuranceTerms.value = false;
  unsubscribeInsuranceTicks?.();
  unsubscribeInsuranceTicks = undefined;
}

async function beginAddInsurance(): Promise<void> {
  const channel = displayedChannel.value;
  if (!channel || channel.lockId == null) return;

  const pendingTxInfo = bitcoinLockResecuritize.getPendingResecuritizationTxInfo(channel.lockId);
  if (pendingTxInfo) {
    trackAddInsuranceTransaction(pendingTxInfo);
    return;
  }

  isAddingInsurance.value = true;
  isLoadingAddInsuranceTerms.value = true;
  addInsuranceError.value = '';
  addInsuranceTargetCoverageMicrogons.value = channel.securitizationCoverageMicrogons ?? 0n;
  void bitcoinLockCoupons
    .refresh()
    .then(() => {
      if (isAddingInsurance.value) updateAddInsuranceFee();
    })
    .catch(error => {
      console.warn('Unable to refresh the Bitcoin insurance fee gift', error);
    });
  try {
    await miningFrames.load();
    await refreshAddInsuranceTerms();
    updateAddInsuranceFee();
    unsubscribeInsuranceTicks?.();
    unsubscribeInsuranceTicks = miningFrames.onTick(() => {
      if (
        !isAddingInsurance.value ||
        isAddingInsuranceTransaction.value ||
        (insuranceQuoteTick !== undefined && miningFrames.currentTick - insuranceQuoteTick < 10)
      ) {
        return;
      }

      void refreshAddInsuranceTerms()
        .then(() => {
          updateAddInsuranceFee();
        })
        .catch(error => {
          addInsuranceError.value =
            error instanceof Error ? error.message : 'Unable to refresh current insurance terms.';
        });
    }).unsubscribe;
  } catch (error) {
    addInsuranceError.value = error instanceof Error ? error.message : 'Unable to load current insurance terms.';
  } finally {
    isLoadingAddInsuranceTerms.value = false;
  }
}

async function refreshAddInsuranceTerms(): Promise<void> {
  const channel = displayedChannel.value;
  if (!channel || channel.lockId == null) throw new Error('This Bitcoin channel is unavailable.');

  const client = await getMainchainClient(false);
  const [, rates, vault, currentLock] = await Promise.all([
    currency.fetchMainchainRates(client, { ignoreCache: true, updateOffchainRates: false }),
    client.query.bitcoinLocks.microgonPerBtcHistory(),
    vaults.refreshVault(channel.vaultId),
    BitcoinLock.get(client, channel.lockId),
  ]);
  const eligibleRate = rates?.at(-1);
  if (!eligibleRate || !vault || !currentLock) throw new Error('Current insurance terms are unavailable.');
  const [rateTick, rate] = eligibleRate;

  await (await bitcoinLocks.getTable()).updateFromCurrentLock(channel, currentLock);

  addInsuranceRateMicrogonsPerBtc.value = bigIntMax(rate, channel.microgonsAtTargetPerBtc ?? 0n);
  currentBitcoinPriceMicrogonsPerBtc.value = rate;
  insuranceQuoteTick = Number(rateTick);
  const currentCoverage = channel.securitizationCoverageMicrogons ?? 0n;
  const availableCoverage = vault.availableBitcoinSpace(channel.ownerAccount);
  const maximumCoverageAtCurrentRate = BitcoinLock.calculateLiquidityPromised({
    priceIndex: currency.priceIndex,
    satoshis: channel.fundedSatoshis,
    microgonsAtTargetPerBtc: addInsuranceRateMicrogonsPerBtc.value,
  });
  const maximumCoverage =
    currentCoverage + availableCoverage < maximumCoverageAtCurrentRate
      ? currentCoverage + availableCoverage
      : maximumCoverageAtCurrentRate;
  maximumInsuranceCoverageMicrogons.value = bigIntMax(maximumCoverage, currentCoverage);
}

function updateAddInsuranceFee(): void {
  const channel = displayedChannel.value;
  const vault = channel ? vaults.vaultsById[channel.vaultId] : undefined;
  if (!channel || !vault || !channel.scriptDetails || !addInsuranceRateMicrogonsPerBtc.value) {
    addInsuranceFeeMicrogons.value = 0n;
    addInsuranceCouponCreditMicrogons.value = 0n;
    return;
  }

  const totalFee = BitcoinLock.calculateResecuritizationFee({
    vault,
    currentCoverageMicrogons: channel.securitizationCoverageMicrogons ?? 0n,
    replacementCoverageMicrogons: addInsuranceTargetCoverageMicrogons.value,
    createdAtBitcoinHeight: channel.scriptDetails.createdAtHeight,
    vaultClaimBitcoinHeight: channel.scriptDetails.vaultClaimHeight,
    currentBitcoinHeight: bitcoinLocks.data.oracleBitcoinBlockHeight,
  });
  const coupon = getAddInsuranceCoupon(channel);
  const pendingCredit =
    coupon?.uses?.find(use => use.status === 'Prepared' && use.utxoId === channel.lockId && use.feeCoupon)
      ?.feeCreditMicrogons ?? 0n;
  addInsuranceCouponCreditMicrogons.value = bigIntMin(
    totalFee,
    (coupon?.remainingFeeCreditMicrogons ?? 0n) + pendingCredit,
  );
  addInsuranceFeeMicrogons.value =
    walletKeys.defaultArgonAddress === vault.operatorAccountId
      ? 0n
      : totalFee - addInsuranceCouponCreditMicrogons.value;
}

async function submitAddInsurance(): Promise<void> {
  const channel = displayedChannel.value;
  if (!channel || isAddingInsuranceTransaction.value) return;

  isAddingInsuranceTransaction.value = true;
  addInsuranceError.value = '';
  cleanupAddInsuranceProgress();
  try {
    await refreshAddInsuranceTerms();
    if (addInsuranceTargetCoverageMicrogons.value > maximumInsuranceCoverageMicrogons.value) {
      addInsuranceTargetCoverageMicrogons.value = maximumInsuranceCoverageMicrogons.value;
      updateAddInsuranceFee();
      throw new Error(`${channelCosignerLabel(channel)} capacity changed. Review the updated maximum and try again.`);
    }
    const vault = vaults.vaultsById[channel.vaultId];
    if (!vault) {
      throw new Error(`${channelCosignerLabel(channel)} is currently unavailable.`);
    }

    const securitizedSatoshis = bigIntMin(
      channel.fundedSatoshis,
      await bitcoinLocks.satoshisForArgonLiquidity(
        addInsuranceTargetCoverageMicrogons.value,
        addInsuranceRateMicrogonsPerBtc.value,
      ),
    );
    const txInfo = await bitcoinLockResecuritize.submit({
      lock: channel,
      vault,
      securitizedSatoshis,
      microgonsAtTargetPerBtc: addInsuranceRateMicrogonsPerBtc.value,
      txSigner: await walletKeys.getLiquidLockingKeypair(),
      operatorCoupon: getAddInsuranceCoupon(channel),
    });
    trackAddInsuranceTransaction(txInfo);
  } catch (error) {
    isAddingInsuranceTransaction.value = false;
    addInsuranceError.value = error instanceof Error ? error.message : 'Unable to add Bitcoin insurance.';
  }
}

function trackAddInsuranceTransaction(txInfo: TransactionInfo<IBitcoinResecuritizationMetadata>): void {
  isAddingInsurance.value = true;
  if (trackedAddInsuranceTransactionId === txInfo.tx.id && isAddingInsuranceTransaction.value) return;

  cleanupAddInsuranceProgress();
  trackedAddInsuranceTransactionId = txInfo.tx.id;
  addInsuranceProgressPct.value = txInfo.getStatus().progressPct;
  trackTransactionProgress({
    txInfos: [txInfo],
    isSubmitting: isAddingInsuranceTransaction,
    progressPct: addInsuranceProgressPct,
    progressLabel: addInsuranceProgressLabel,
    error: addInsuranceError,
    onComplete: () => {
      cleanupAddInsuranceProgress();
      emit('update:open', false);
    },
    onCleanup: cleanup => addInsuranceProgressCleanupFns.push(cleanup),
  });
}

function cleanupAddInsuranceProgress(): void {
  trackedAddInsuranceTransactionId = undefined;
  addInsuranceProgressCleanupFns.forEach(cleanup => cleanup());
  addInsuranceProgressCleanupFns = [];
}

function getAddInsuranceCoupon(channel: IBitcoinLockRecord) {
  return [bitcoinLockCoupons.currentCoupon, bitcoinLockCoupons.resumableCoupon].find(
    coupon => coupon?.coupon.vaultId === channel.vaultId,
  );
}

function channelCosignerLabel(channel: IBitcoinLockRecord): string {
  if (channel.vaultId === (myVault.createdVault?.vaultId ?? myVault.vaultId)) return 'Your Vault';
  return vaults.operatorNamesByVaultId[channel.vaultId] ?? upstreamOperatorName.value;
}

function keepOpenForRelatedConnector(event: PointerDownOutsideEvent) {
  const target = event.detail.originalEvent.target;
  if (!(target instanceof Element)) return;

  const connectorId = target.closest('[data-wallet-connector-id]')?.getAttribute('data-wallet-connector-id');
  if (connectorId && connectorId === props.connectorId) event.preventDefault();
}

Vue.onUnmounted(() => {
  if (progressRefreshInterval) clearInterval(progressRefreshInterval);
  unsubscribeInsuranceTicks?.();
  cleanupAddInsuranceProgress();
});
</script>
