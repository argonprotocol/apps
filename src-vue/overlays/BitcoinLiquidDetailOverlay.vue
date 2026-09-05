<template>
  <OverlayBase
    :isOpen="true"
    title="Locked Bitcoin Details"
    class="min-h-60 w-240"
    @close="closeOverlay"
    @pressEsc="closeOverlay"
  >
    <template #default="{ floatingZIndex }">
      <div class="px-10 py-5">
        <PopoverRoot>
          <div class="group relative flex w-fit flex-wrap items-baseline gap-x-2">
            <h1 class="text-2xl font-bold text-slate-700 group-hover:text-slate-600">
              {{ satToBtcNm(liquid.satoshis).format('0,0.[00000000]') }} BTC Locked
            </h1>
            <PopoverAnchor as-child>
              <span class="inline-flex items-center gap-x-2">
                <template v-if="lockedBitcoinSourceLabel">
                  <span class="text-2xl font-light text-slate-400">&middot;</span>
                  <span class="text-2xl font-light text-slate-500 group-hover:text-slate-600">
                    {{ lockedBitcoinSourceLabel }}
                  </span>
                </template>
                <ChevronDownIcon class="-ml-1 size-5 text-slate-400 group-hover:text-slate-600" />
              </span>
            </PopoverAnchor>
            <PopoverTrigger as-child>
              <button class="absolute inset-0 z-10 cursor-pointer" title="Show locked Bitcoin details" />
            </PopoverTrigger>
          </div>
          <PopoverPortal>
            <PopoverContent
              side="bottom"
              :sideOffset="8"
              :collisionPadding="24"
              :style="{ zIndex: floatingZIndex }"
              class="w-110 rounded-md border border-gray-800/20 bg-white px-5 py-4 text-sm text-slate-600 shadow-xl"
            >
              <h2 class="border-b border-slate-200 pb-2 font-bold text-slate-700">Locked Bitcoin</h2>
              <div>
                <div
                  v-for="lockedBitcoin in lockedBitcoinRows"
                  :key="lockedBitcoin.utxoId"
                  class="flex items-center border-b border-slate-200 py-3 last:border-b-0"
                >
                  <span class="grow">
                    <template v-if="lockedBitcoin.isMyVault">In my Vault</template>
                    <template v-else>Cosigner: {{ lockedBitcoin.cosigner }}</template>
                  </span>
                  <span>{{ satToBtcNm(lockedBitcoin.satoshis).format('0,0.[00000000]') }} BTC</span>
                </div>
              </div>
              <PopoverArrow :width="24" :height="12" class="-mt-px fill-white stroke-gray-400/30" />
            </PopoverContent>
          </PopoverPortal>
        </PopoverRoot>

        <section class="border-argon-600/30 mt-6 rounded-md border">
          <div class="flex flex-row py-6 text-center">
            <div class="w-1/3 px-3">
              <header class="text-sm font-bold opacity-40">LIQUIDITY RECEIVED</header>
              <div class="py-1 text-2xl font-bold text-slate-600">
                {{ argonSymbol }}{{ microgonToArgonNm(liquid.receivedLiquidity).format('0,0.00') }}
              </div>
              <TooltipProvider v-if="liquid.pendingLiquidity" :delayDuration="100">
                <TooltipRoot>
                  <TooltipTrigger as-child>
                    <button
                      class="inline-flex cursor-pointer items-center gap-x-1 text-sm text-slate-500 hover:text-slate-700"
                    >
                      {{ argonSymbol }}{{ microgonToArgonNm(liquid.pendingLiquidity).format('0,0.00') }} still minting
                      <InformationCircleIcon class="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipPortal>
                    <TooltipContent
                      side="bottom"
                      align="start"
                      :sideOffset="8"
                      :collisionPadding="24"
                      :style="{ zIndex: floatingZIndex }"
                      class="w-90 rounded-md border border-gray-800/20 bg-white px-5 py-4 text-left text-sm text-slate-600 shadow-xl"
                    >
                      <h2 class="border-b border-slate-200 pb-2 font-bold text-slate-700">Pending mint schedule</h2>
                      <div class="mt-3 flex items-baseline justify-between gap-6">
                        <span class="text-slate-500">Next daily payout</span>
                        <span class="font-medium whitespace-nowrap text-slate-600">
                          {{ argonSymbol }}{{ microgonToArgonNm(liquid.expectedMintPerFrame).format('0,0.00') }}
                        </span>
                      </div>
                      <div v-if="liquid.estimatedMintFramesRemaining" class="mt-1 flex justify-between gap-6">
                        <span class="text-slate-500">
                          {{ liquid.estimatedMintFramesRemaining }} daily
                          {{ liquid.estimatedMintFramesRemaining === 1 ? 'payout' : 'payouts' }} remaining
                        </span>
                        <span class="font-medium whitespace-nowrap text-slate-600">
                          About {{ estimatedMintCompletionDate }}
                        </span>
                      </div>
                      <p class="mt-3 border-t border-slate-200 pt-3 text-xs text-slate-500">
                        Network minting capacity can delay payouts.
                      </p>
                      <TooltipArrow :width="24" :height="12" class="-mt-px fill-white stroke-gray-400/30" />
                    </TooltipContent>
                  </TooltipPortal>
                </TooltipRoot>
              </TooltipProvider>
              <div v-else class="text-sm text-slate-500">Added to your wallet</div>
            </div>
            <div class="min-h-full min-w-px bg-slate-600/20" />
            <div class="w-1/3 px-3">
              <header class="text-sm font-bold opacity-40">RETURN TO DATE</header>
              <div v-if="financialPosition?.totalReturn !== undefined" class="py-1 text-2xl font-bold text-slate-600">
                {{ numeral(financialPosition.totalReturn).format('0,0.[00]') }}%
              </div>
              <div v-else class="py-1 text-2xl font-bold text-slate-400">&mdash;</div>
              <div class="text-sm text-slate-500">Since this Liquid opened</div>
            </div>
            <div class="min-h-full min-w-px bg-slate-600/20" />
            <div class="w-1/3 px-3">
              <header class="text-sm font-bold opacity-40">TOTAL FEES</header>
              <div v-if="financialPosition?.totalFees !== undefined" class="py-1 text-2xl font-bold text-slate-600">
                {{ argonSymbol }}{{ microgonToArgonNm(financialPosition.totalFees).format('0,0.00') }}
              </div>
              <div v-else class="py-1 text-2xl font-bold text-slate-400">&mdash;</div>
              <div class="text-sm text-slate-500">Recorded costs to date</div>
            </div>
          </div>
        </section>

        <section v-if="!isClosed" class="mt-6">
          <div class="flex items-center gap-x-1 border-b border-slate-200 pb-2">
            <h2 class="text-sm font-bold opacity-40">RATCHET OPPORTUNITY</h2>
            <TooltipProvider :delayDuration="100">
              <TooltipRoot>
                <TooltipTrigger as-child>
                  <button
                    type="button"
                    class="cursor-help text-slate-400 hover:text-slate-600"
                    title="What is a ratchet?"
                  >
                    <InformationCircleIcon class="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipPortal>
                  <TooltipContent
                    side="bottom"
                    :sideOffset="0"
                    :collisionPadding="24"
                    :style="{ zIndex: floatingZIndex }"
                    class="w-80 rounded-md border border-gray-800/20 bg-white px-4 py-3 text-sm text-slate-600 shadow-xl"
                  >
                    A ratchet updates the Liquid to Bitcoin's latest price. A higher price can unlock more Argons; a
                    lower price lets you keep the difference and restores room for a future upward ratchet.
                    <TooltipArrow :width="18" :height="9" class="-mt-px fill-white stroke-gray-400/30" />
                  </TooltipContent>
                </TooltipPortal>
              </TooltipRoot>
            </TooltipProvider>
          </div>
          <article class="border-b border-slate-200 py-3">
            <PopoverRoot v-model:open="ratchetPopoverOpen">
              <div class="flex items-start gap-x-5">
                <div class="min-w-0 grow">
                  <div class="flex items-baseline gap-x-2">
                    <strong class="text-slate-700">
                      {{ argonSymbol }}{{ microgonToArgonNm(prospectiveLiquidity).format('0,0.00') }}
                    </strong>
                    <span class="text-sm text-slate-400">
                      (BTC change {{ ratchetPercent > 0 ? '+' : '' }}{{ numeral(ratchetPercent).format('0,0.[00]') }}%)
                    </span>
                  </div>
                </div>
                <div v-if="ratchetPreview || ratchetTransaction.status !== 'idle'" class="text-right text-sm">
                  <div class="flex justify-end gap-x-2 font-semibold">
                    <span v-if="ratchetPreview?.amountToMint" class="text-slate-600">
                      Would unlock
                      {{ argonSymbol }}{{ microgonToArgonNm(ratchetPreview.amountToMint).format('0,0.00') }}
                    </span>
                    <span v-else-if="ratchetPocketed" class="text-slate-600">
                      Would pocket {{ argonSymbol }}{{ microgonToArgonNm(ratchetPocketed).format('0,0.00') }}
                    </span>
                    <span
                      v-if="ratchetPreview?.canRatchet && (ratchetPreview.amountToMint || ratchetPocketed)"
                      class="text-slate-400"
                    >
                      &middot;
                    </span>
                    <span
                      v-if="ratchetPreview?.canRatchet && ratchetQuoteState.status === 'loading'"
                      class="font-normal text-slate-400"
                    >
                      Calculating fees...
                    </span>
                    <span v-else-if="ratchetPreview?.canRatchet && ratchetQuote" class="font-normal text-slate-500">
                      {{ argonSymbol }}{{ microgonToArgonNm(ratchetQuote.feeMicrogons).format('0,0.00') }} fees
                    </span>
                    <span
                      v-else-if="ratchetPreview?.canRatchet && (ratchetPreview.amountToMint || ratchetPocketed)"
                      class="font-normal text-slate-500"
                    >
                      Fees unavailable
                    </span>
                  </div>
                  <PopoverPortal>
                    <PopoverContent
                      side="top"
                      align="end"
                      :sideOffset="10"
                      :collisionPadding="24"
                      :style="{ zIndex: floatingZIndex }"
                      class="border-argon-600/30 w-110 rounded-md border bg-white px-6 py-4 text-sm text-slate-700 shadow-2xl"
                    >
                      <template v-if="ratchetTransaction.status === 'pending'">
                        <h2 class="font-bold text-slate-700">Ratcheting Liquid</h2>
                        <ProgressBar :progress="ratchetTransaction.progressPct" class="mt-3" />
                        <div class="mt-2 text-sm text-slate-500">{{ ratchetTransaction.progressLabel }}</div>
                        <div class="mt-1 text-sm text-slate-400">
                          You can close this window without stopping the transaction.
                        </div>
                      </template>
                      <template v-else-if="ratchetTransaction.status === 'error'">
                        <h2 class="font-bold text-slate-700">
                          {{
                            ratchetTransaction.retryAction === 'resume'
                              ? 'Ratchet completed on-chain'
                              : 'Ratchet failed'
                          }}
                        </h2>
                        <p class="mt-2 text-red-700">{{ ratchetTransaction.error }}</p>
                        <button
                          :disabled="ratchetTransaction.retryAction !== 'resume' && !canSubmitRatchet"
                          class="bg-argon-600 hover:bg-argon-700 mt-4 w-full cursor-pointer rounded-md px-5 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                          @click="retryRatchet"
                        >
                          {{ ratchetTransaction.retryAction === 'resume' ? 'Finish Ratchet' : 'Try Again' }}
                        </button>
                      </template>
                      <template v-else-if="ratchetPreview">
                        <h2 class="font-bold text-slate-700">Review this ratchet</h2>
                        <p v-if="ratchetPreview.amountToMint" class="mt-2">
                          Unlock
                          <strong>
                            {{ argonSymbol }}{{ microgonToArgonNm(ratchetPreview.amountToMint).format('0,0.00') }}
                          </strong>
                          additional liquidity at the new Bitcoin price.
                        </p>
                        <p v-else-if="ratchetPocketed" class="mt-2">
                          Keep
                          <strong>{{ argonSymbol }}{{ microgonToArgonNm(ratchetPocketed).format('0,0.00') }}</strong>
                          and reset this Liquid to the lower Bitcoin floor.
                        </p>
                        <p v-if="ratchetPreview.amountToBurn" class="mt-3 text-slate-500">
                          A downward ratchet requires
                          <strong class="font-semibold text-slate-700">
                            {{ argonSymbol }}{{ microgonToArgonNm(ratchetPreview.amountToBurn).format('0,0.00') }}
                          </strong>
                          in your wallet to be burned and re-minted at the lower Liquid amount.
                        </p>
                        <p v-if="ratchetQuoteState.status !== 'error'" class="mt-3 text-slate-500">
                          <template v-if="ratchetQuote">
                            This ratchet costs
                            <strong class="font-semibold text-slate-700">
                              {{ argonSymbol }}{{ microgonToArgonNm(ratchetQuote.feeMicrogons).format('0,0.00') }}
                            </strong>
                            in fees.
                          </template>
                          <template v-else>Calculating transaction cost...</template>
                        </p>
                        <p v-if="ratchetQuoteState.status === 'error'" class="mt-3 text-red-700">
                          {{ ratchetQuoteState.error }}
                        </p>
                        <button
                          v-if="ratchetQuoteState.status === 'error'"
                          class="border-argon-600 text-argon-600 hover:bg-argon-600/5 mt-3 w-full cursor-pointer rounded-md border px-5 py-2 font-semibold"
                          @click="retryRatchetQuote"
                        >
                          Retry fee estimate
                        </button>
                        <p v-if="ratchetWalletIsInsufficient" class="mt-3 text-red-700">
                          Your Internal App Wallet needs
                          {{ argonSymbol
                          }}{{ microgonToArgonNm(ratchetQuote!.requiredWalletBalanceMicrogons).format('0,0.00') }}
                          to continue. It currently has
                          {{ argonSymbol
                          }}{{ microgonToArgonNm(ratchetQuote!.availableWalletBalanceMicrogons).format('0,0.00') }}
                          available.
                        </p>
                        <p v-if="ratchetPreview.skippedFissionIds.length" class="mt-3 text-slate-500">
                          This ratchet uses only the locked Bitcoin that currently meets the minimum price change.
                        </p>
                        <p v-if="ratchetPreview.lockChanges.length" class="mt-3 text-slate-500">
                          {{ ratchetPreview.lockChanges.length }} lock{{
                            ratchetPreview.lockChanges.length === 1 ? '' : 's'
                          }}
                          will be resecuritized as part of this ratchet.
                        </p>
                        <button
                          :disabled="!canSubmitRatchet"
                          class="bg-argon-600 hover:bg-argon-700 mt-4 w-full cursor-pointer rounded-md px-5 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                          @click="confirmRatchet"
                        >
                          Confirm Ratchet
                        </button>
                      </template>
                      <PopoverArrow :width="26" :height="12" class="stroke-argon-600/15 -mt-px fill-white" />
                    </PopoverContent>
                  </PopoverPortal>
                </div>
              </div>
              <div class="flex items-end gap-x-5" :class="ratchetPreview ? 'mt-1' : ''">
                <p v-if="ratchetState.status === 'loading'" class="min-w-0 grow text-sm text-slate-500">
                  Checking the latest price, eligible locked Bitcoin, and cosigner capacity.
                </p>
                <p v-else-if="!isRatchetAvailable" class="min-w-0 grow text-sm text-slate-500">
                  {{ ratchetUnavailableReason }}
                </p>
                <p v-else-if="ratchetPercent > 0" class="min-w-0 grow text-sm text-slate-500">
                  Bitcoin's higher price lets the same locked Bitcoin unlock more liquidity.
                </p>
                <p v-else class="min-w-0 grow text-sm text-slate-500">
                  A lower floor lets you keep the difference and restores room for a future upward ratchet.
                </p>
                <TooltipProvider :delayDuration="100">
                  <TooltipRoot>
                    <TooltipTrigger as-child>
                      <span class="inline-flex">
                        <PopoverTrigger as-child>
                          <button
                            data-testid="BitcoinLiquidDetailOverlay.openRatchetReview"
                            :disabled="
                              (!isRatchetAvailable || !ratchetPreview) && ratchetTransaction.status !== 'pending'
                            "
                            class="border-argon-600 text-argon-600 hover:bg-argon-600/5 inline-flex cursor-pointer items-center gap-x-1 rounded border px-3 text-sm leading-5 font-semibold whitespace-nowrap disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-300"
                          >
                            {{ ratchetTransaction.status === 'pending' ? 'Ratcheting...' : 'Start Ratchet' }}
                            <InformationCircleIcon
                              v-if="!isRatchetAvailable && ratchetState.status !== 'loading'"
                              class="size-4"
                            />
                          </button>
                        </PopoverTrigger>
                      </span>
                    </TooltipTrigger>
                    <TooltipPortal v-if="!isRatchetAvailable && ratchetState.status !== 'loading'">
                      <TooltipContent
                        side="top"
                        align="end"
                        :sideOffset="8"
                        :collisionPadding="24"
                        :style="{ zIndex: floatingZIndex }"
                        class="w-80 rounded-md border border-gray-800/20 bg-white px-4 py-3 text-sm text-slate-600 shadow-xl"
                      >
                        {{ ratchetUnavailableReason }}
                        <TooltipArrow :width="18" :height="9" class="-mt-px fill-white stroke-gray-400/30" />
                      </TooltipContent>
                    </TooltipPortal>
                  </TooltipRoot>
                </TooltipProvider>
              </div>
            </PopoverRoot>
          </article>
        </section>

        <section v-if="closeHistoryEntry || recentHistory.length" class="mt-6 border-b border-slate-200">
          <h2 class="pb-2 text-sm font-bold opacity-40">HISTORY</h2>
          <div class="border-t border-slate-200">
            <BitcoinLiquidHistoryRow
              v-if="closeHistoryEntry"
              :entry="closeHistoryEntry"
              :totalFissionCount="liquid.fissions.length"
              :zIndex="floatingZIndex"
              detailsMode="hover"
            />
            <BitcoinLiquidHistoryRow
              v-for="entry in recentHistory"
              :key="entry.key"
              :entry="entry"
              :totalFissionCount="liquid.fissions.length"
              :zIndex="floatingZIndex"
              detailsMode="hover"
            />
          </div>
        </section>

        <div v-if="fullHistory.length > 3 || !isClosed" class="mt-7 flex items-center justify-between gap-x-3">
          <PopoverRoot v-if="fullHistory.length > 3">
            <PopoverTrigger as-child>
              <button class="text-argon-600 cursor-pointer text-sm">Show full history</button>
            </PopoverTrigger>
            <PopoverPortal>
              <PopoverContent
                side="top"
                align="start"
                :sideOffset="8"
                :collisionPadding="24"
                :style="{ zIndex: floatingZIndex }"
                class="max-h-[var(--reka-popover-content-available-height)] w-150 overflow-y-auto rounded-md border border-gray-800/20 bg-white px-6 py-4 shadow-xl"
              >
                <h2 class="border-b border-slate-200 pb-2 font-bold text-slate-700">Full history</h2>
                <BitcoinLiquidHistoryRow
                  v-for="entry in fullHistory"
                  :key="entry.key"
                  :entry="entry"
                  :totalFissionCount="liquid.fissions.length"
                  :zIndex="floatingZIndex + 1"
                  detailsMode="inline"
                />
                <PopoverArrow :width="24" :height="12" class="-mt-px fill-white stroke-gray-400/30" />
              </PopoverContent>
            </PopoverPortal>
          </PopoverRoot>
          <span v-else />
          <PopoverRoot v-if="!isClosed" v-model:open="closePopoverOpen">
            <PopoverTrigger as-child>
              <button
                data-testid="BitcoinLiquidDetailOverlay.openCloseReview"
                class="border-argon-600 text-argon-600 hover:bg-argon-600/5 cursor-pointer rounded-md border px-5 py-2 font-semibold whitespace-nowrap"
              >
                <template v-if="closeTransaction.status === 'pending'">Closing Liquid...</template>
                <template v-else>
                  Repay {{ argonSymbol }}{{ microgonToArgonNm(repaymentAmount).format('0,0.00') }} &amp; Close Liquid
                </template>
              </button>
            </PopoverTrigger>
            <PopoverPortal>
              <PopoverContent
                side="top"
                align="end"
                :sideOffset="10"
                :collisionPadding="24"
                :style="{ zIndex: floatingZIndex }"
                class="border-argon-600/30 w-110 rounded-md border bg-white px-6 py-4 text-sm text-slate-700 shadow-2xl"
              >
                <template v-if="closeTransaction.status === 'pending'">
                  <h2 class="font-bold text-slate-700">Closing Liquid</h2>
                  <ProgressBar :progress="closeTransaction.progressPct" class="mt-3" />
                  <div class="mt-2 text-sm text-slate-500">{{ closeTransaction.progressLabel }}</div>
                  <div class="mt-1 text-sm text-slate-400">
                    You can close this window without stopping the transaction.
                  </div>
                </template>
                <template v-else-if="closeTransaction.status === 'error'">
                  <h2 class="font-bold text-slate-700">
                    {{
                      closeTransaction.retryAction === 'resume' ? 'Liquid closed on-chain' : 'Unable to close Liquid'
                    }}
                  </h2>
                  <p class="mt-2 text-red-700">{{ closeTransaction.error }}</p>
                  <button
                    class="bg-argon-600 hover:bg-argon-700 mt-4 w-full cursor-pointer rounded-md px-5 py-2 font-semibold text-white"
                    @click="retryClose"
                  >
                    {{ closeTransaction.retryAction === 'resume' ? 'Finish Closing Liquid' : 'Try Again' }}
                  </button>
                </template>
                <template v-else>
                  <h2 class="font-bold text-slate-700">Close this Liquid</h2>
                  <p class="mt-2">
                    Repay {{ argonSymbol }}{{ microgonToArgonNm(repaymentAmount).format('0,0.00') }} to re-fuse this
                    Liquid and unlock {{ satToBtcNm(liquid.satoshis).format('0,0.[00000000]') }} BTC in your Bitcoin
                    wallet.
                  </p>
                  <dl class="mt-3 grid grid-cols-[1fr_auto] gap-x-5 gap-y-1.5">
                    <dt>Repayment amount</dt>
                    <dd v-if="closeQuote" class="text-right font-mono tabular-nums">
                      {{ argonSymbol
                      }}{{
                        microgonToArgonNm(closeQuote.requiredWalletBalanceMicrogons - closeQuote.feeMicrogons).format(
                          '0,0.000000',
                        )
                      }}
                    </dd>
                    <dd v-else-if="closeQuoteState.status === 'loading'" class="text-right">Calculating...</dd>
                    <dd v-else class="text-right">Unavailable</dd>
                    <dt>Estimated fees</dt>
                    <dd v-if="closeQuote" class="text-right font-mono tabular-nums">
                      {{ argonSymbol }}{{ microgonToArgonNm(closeQuote.feeMicrogons).format('0,0.000000') }}
                    </dd>
                    <dd v-else-if="closeQuoteState.status === 'loading'" class="text-right">Calculating...</dd>
                    <dd v-else class="text-right">Unavailable</dd>
                    <template v-if="closeQuote">
                      <dt class="mt-1 border-t border-slate-200 pt-2 font-semibold">Amount removed from wallet</dt>
                      <dd class="mt-1 border-t border-slate-200 pt-2 text-right font-mono font-semibold tabular-nums">
                        {{ argonSymbol
                        }}{{ microgonToArgonNm(closeQuote.requiredWalletBalanceMicrogons).format('0,0.000000') }}
                      </dd>
                    </template>
                  </dl>
                  <p v-if="closeQuoteState.status === 'error'" class="mt-3 text-red-700">
                    {{ closeQuoteState.error }}
                  </p>
                  <button
                    v-if="closeQuoteState.status === 'error'"
                    class="border-argon-600 text-argon-600 hover:bg-argon-600/5 mt-3 w-full cursor-pointer rounded-md border px-5 py-2 font-semibold"
                    @click="retryCloseQuote"
                  >
                    Retry fee estimate
                  </button>
                  <p v-if="closeWalletIsInsufficient" class="mt-3 text-red-700">
                    Your Internal App Wallet needs
                    {{ argonSymbol
                    }}{{ microgonToArgonNm(closeQuote!.requiredWalletBalanceMicrogons).format('0,0.00') }} to continue.
                    It currently has {{ argonSymbol
                    }}{{ microgonToArgonNm(closeQuote!.availableWalletBalanceMicrogons).format('0,0.00') }} available.
                  </p>
                  <button
                    :disabled="!canSubmitClose"
                    class="bg-argon-600 hover:bg-argon-700 mt-4 w-full cursor-pointer rounded-md px-5 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                    @click="confirmClose"
                  >
                    Repay &amp; Close Liquid
                  </button>
                </template>
                <PopoverArrow :width="26" :height="12" class="stroke-argon-600/15 -mt-px fill-white" />
              </PopoverContent>
            </PopoverPortal>
          </PopoverRoot>
        </div>
      </div>
    </template>
  </OverlayBase>
</template>

<script setup lang="ts">
import { bigIntMax, SATOSHIS_PER_BITCOIN, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { ChevronDownIcon, InformationCircleIcon } from '@heroicons/vue/24/outline';
import dayjs from 'dayjs';
import {
  PopoverAnchor,
  PopoverArrow,
  PopoverContent,
  PopoverPortal,
  PopoverRoot,
  PopoverTrigger,
  TooltipArrow,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
} from 'reka-ui';
import * as Vue from 'vue';

import BitcoinLiquidHistoryRow from '../components/BitcoinLiquidHistoryRow.vue';
import ProgressBar from '../components/ProgressBar.vue';
import type { IBitcoinLiquidFinancialPosition } from '../interfaces/IFinancialPosition.ts';
import type { BitcoinLiquid } from '../lib/BitcoinLiquid.ts';
import { getTransactionFailureMessage, type TransactionInfo } from '../lib/TransactionInfo.ts';
import type { IBitcoinLiquidRatchetPreview } from '../lib/txs/BitcoinLiquid.ratchet.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import numeral from '../lib/numeral.ts';
import { getCurrency } from '../stores/currency.ts';
import { useFinancials } from '../stores/financials.ts';
import { getBitcoinFissions, getBitcoinTransactionOperations } from '../stores/bitcoin.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { getMyVault, getVaults } from '../stores/vaults.ts';
import { getWalletKeys } from '../stores/wallets.ts';
import OverlayBase from './OverlayBase.vue';

type LiquidDetailsLoadState<Value> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; value: Value }
  | { status: 'error'; error: string };

type LiquidDetailsTransactionState =
  | { status: 'idle' }
  | { status: 'pending'; progressPct: number; progressLabel: string }
  | { status: 'error'; error: string; retryAction: 'resubmit' | 'resume' };

interface BitcoinLiquidRatchetDetails {
  rate: bigint;
  preview: IBitcoinLiquidRatchetPreview;
}

interface BitcoinLiquidTransactionQuote {
  feeMicrogons: bigint;
  requiredWalletBalanceMicrogons: bigint;
  availableWalletBalanceMicrogons: bigint;
}

const props = defineProps<{
  liquid: BitcoinLiquid;
}>();

const emit = defineEmits<{
  close: [];
}>();

const currency = getCurrency();
const financials = useFinancials();
const bitcoinFissions = getBitcoinFissions();
const { bitcoinLiquidClose, bitcoinLiquidRatchet } = getBitcoinTransactionOperations();
const vaults = getVaults();
const myVault = getMyVault();
const walletKeys = getWalletKeys();
const { microgonToArgonNm, satToBtcNm } = createNumeralHelpers(currency);
const argonSymbol = currency.recordsByKey[UnitOfMeasurement.ARGN].symbol;

const liquid = Vue.toRef(props, 'liquid');
const isClosed = Vue.computed(() => liquid.value.isClosed);
const financialPosition = Vue.computed(() =>
  financials.financialPositionAggregate.groupSummaries.bitcoin.positions.find(
    (position): position is IBitcoinLiquidFinancialPosition =>
      position.kind === 'bitcoin-liquid' && position.liquidId === liquid.value.liquidId,
  ),
);
const closeHistoryEntry = Vue.computed(
  () => financialPosition.value?.liquid.closeHistoryEntry ?? liquid.value.closeHistoryEntry,
);
const fullHistory = Vue.computed(() =>
  [...(financialPosition.value?.liquid.history ?? liquid.value.history)].reverse(),
);
const recentHistory = Vue.computed(() => fullHistory.value.slice(0, 3));
const repaymentAmount = Vue.computed(() => liquid.value.getRepaymentAmount(currency.priceIndex));
const estimatedMintCompletionDate = Vue.computed(() =>
  dayjs()
    .add(liquid.value.estimatedMintFramesRemaining ?? 0, 'day')
    .format('MMM D'),
);

const lockSummaries = Vue.computed(() => {
  const utxoIds = new Set(liquid.value.fissions.map(fission => fission.utxoId));
  return financials.bitcoinLockDisplayRecords.filter(
    summary => summary.utxoId !== undefined && utxoIds.has(summary.utxoId),
  );
});
const lockedBitcoinRows = Vue.computed(() => {
  const byUtxoId = new Map<number, { utxoId: number; satoshis: bigint; cosigner: string; isMyVault: boolean }>();

  for (const fission of liquid.value.fissions) {
    const existing = byUtxoId.get(fission.utxoId);
    if (existing) {
      existing.satoshis += fission.satoshis;
      continue;
    }

    const vaultId = lockSummaries.value.find(summary => summary.utxoId === fission.utxoId)?.record.vaultId;
    byUtxoId.set(fission.utxoId, {
      utxoId: fission.utxoId,
      satoshis: fission.satoshis,
      isMyVault: vaultId === myVault.vaultId,
      cosigner:
        vaultId === undefined ? 'Unknown cosigner' : (vaults.operatorNamesByVaultId[vaultId] ?? `Vault ${vaultId}`),
    });
  }

  return [...byUtxoId.values()];
});
const lockedBitcoinSourceLabel = Vue.computed(() => {
  const rows = lockedBitcoinRows.value;
  const cosigners = [...new Set(rows.filter(row => !row.isMyVault).map(row => row.cosigner))];
  const isInMyVault = rows.some(row => row.isMyVault);
  if (isInMyVault && !cosigners.length) return 'In my Vault';
  if (!isInMyVault && cosigners.length === 1) return `Cosigner: ${cosigners[0]}`;
  if (isInMyVault) return `Vaults: ${new Intl.ListFormat('en').format([...cosigners, 'my Vault'])}`;
  if (cosigners.length) return `Cosigners: ${new Intl.ListFormat('en').format(cosigners)}`;
});

const ratchetState = Vue.ref<LiquidDetailsLoadState<BitcoinLiquidRatchetDetails>>({ status: 'idle' });
const ratchetQuoteState = Vue.shallowRef<
  LiquidDetailsLoadState<
    BitcoinLiquidTransactionQuote & { prepared: Awaited<ReturnType<typeof bitcoinLiquidRatchet.prepare>> }
  >
>({ status: 'idle' });
const ratchetTransaction = Vue.ref<LiquidDetailsTransactionState>({ status: 'idle' });
const ratchetPopoverOpen = Vue.ref(false);

const ratchetDetails = Vue.computed(() =>
  ratchetState.value.status === 'ready' ? ratchetState.value.value : undefined,
);
const ratchetPreview = Vue.computed(() => ratchetDetails.value?.preview);
const ratchetQuote = Vue.computed(() =>
  ratchetQuoteState.value.status === 'ready' ? ratchetQuoteState.value.value : undefined,
);
const ratchetRate = Vue.computed(() => {
  if (ratchetDetails.value) return ratchetDetails.value.rate;
  if (!currency.priceIndex.btcUsdPrice) return 0n;

  return currency.priceIndex.getSatoshiPriceInTargetMicrogons(SATOSHIS_PER_BITCOIN);
});
const ratchetPercent = Vue.computed(() =>
  ratchetRate.value
    ? liquid.value.getRatchetStatus({
        microgonsAtTargetPerBtc: ratchetRate.value,
        minimumRatchetPercent: bitcoinFissions.data.minimumRatchetPercent,
      }).percent
    : 0,
);
const isRatchetAvailable = Vue.computed(() => ratchetPreview.value?.canRatchet ?? false);
const ratchetUnavailableReason = Vue.computed(() => {
  if (ratchetState.value.status === 'error') return ratchetState.value.error;
  if (ratchetState.value.status !== 'ready' || ratchetState.value.value.preview.canRatchet) return '';

  return (
    ratchetState.value.value.preview.errors[0] ??
    `No locked Bitcoin has reached the minimum ${bitcoinFissions.data.minimumRatchetPercent}% price change.`
  );
});
const ratchetPocketed = Vue.computed(() => {
  const preview = ratchetPreview.value;
  if (!preview || preview.newLiquidity >= preview.sourceLiquidity) return 0n;

  return preview.sourceLiquidity - preview.newLiquidity;
});
const prospectiveLiquidity = Vue.computed(() => {
  const preview = ratchetPreview.value;
  if (!preview) return liquid.value.liquidityPromised;
  return liquid.value.liquidityPromised - preview.sourceLiquidity + preview.newLiquidity;
});
const ratchetWalletIsInsufficient = Vue.computed(
  () =>
    !!ratchetQuote.value &&
    ratchetQuote.value.availableWalletBalanceMicrogons < ratchetQuote.value.requiredWalletBalanceMicrogons,
);
const canSubmitRatchet = Vue.computed(
  () => isRatchetAvailable.value && !!ratchetQuote.value && !ratchetWalletIsInsufficient.value,
);

const closeQuoteState = Vue.shallowRef<
  LiquidDetailsLoadState<
    BitcoinLiquidTransactionQuote & { prepared: Awaited<ReturnType<typeof bitcoinLiquidClose.prepare>> }
  >
>({ status: 'idle' });
const closeTransaction = Vue.ref<LiquidDetailsTransactionState>({ status: 'idle' });
const closePopoverOpen = Vue.ref(false);

const closeQuote = Vue.computed(() =>
  closeQuoteState.value.status === 'ready' ? closeQuoteState.value.value : undefined,
);
const closeWalletIsInsufficient = Vue.computed(
  () =>
    !!closeQuote.value &&
    closeQuote.value.availableWalletBalanceMicrogons < closeQuote.value.requiredWalletBalanceMicrogons,
);
const canSubmitClose = Vue.computed(() => !!closeQuote.value && !closeWalletIsInsufficient.value);

let loadId = 0;
let timeout: ReturnType<typeof setTimeout> | undefined;
const transactionCleanupByState = new Map<Vue.Ref<LiquidDetailsTransactionState>, VoidFunction>();

Vue.watch(
  () => ratchetTransaction.value.status,
  status => {
    if (status !== 'idle') ratchetPopoverOpen.value = true;
  },
);
Vue.watch(
  () => closeTransaction.value.status,
  status => {
    if (status !== 'idle') closePopoverOpen.value = true;
  },
);
Vue.watch(
  () => [currency.priceIndex.btcUsdPrice?.toString(), currency.priceIndex.argonUsdTargetPrice?.toString()],
  () => {
    if (
      ratchetState.value.status === 'loading' ||
      ratchetQuoteState.value.status === 'loading' ||
      closeQuoteState.value.status === 'loading'
    ) {
      return;
    }
    initializeActions(true);
  },
);

function confirmRatchet(): void {
  if (!canSubmitRatchet.value) return;
  void submitRatchet();
}

function confirmClose(): void {
  if (!canSubmitClose.value) return;
  void submitClose();
}

function retryRatchet(): void {
  if (ratchetTransaction.value.status !== 'error') return;
  if (ratchetTransaction.value.retryAction === 'resume') {
    const txInfo = bitcoinLiquidRatchet.getPendingRatchetTxInfo(liquid.value.liquidId);
    if (txInfo) {
      bitcoinLiquidRatchet.resume(txInfo);
      trackTransaction(txInfo, ratchetTransaction);
      return;
    }
  }
  confirmRatchet();
}

function retryClose(): void {
  if (closeTransaction.value.status !== 'error') return;
  if (closeTransaction.value.retryAction === 'resume') {
    const txInfo = bitcoinLiquidClose.getPendingLiquidTxInfo(liquid.value.liquidId);
    if (txInfo) {
      bitcoinLiquidClose.resume(txInfo);
      trackTransaction(txInfo, closeTransaction);
      return;
    }
  }
  confirmClose();
}

function retryRatchetQuote(): void {
  const details = ratchetDetails.value;
  if (!details || ratchetQuoteState.value.status === 'loading') return;

  void loadRatchetQuote(liquid.value, details.rate, details.preview, loadId);
}

function retryCloseQuote(): void {
  if (closeQuoteState.value.status === 'loading') return;

  void loadCloseQuote(liquid.value, loadId);
}

function initializeActions(preserveLoadedState = false): void {
  if (preserveLoadedState && (ratchetTransaction.value.status !== 'idle' || closeTransaction.value.status !== 'idle')) {
    return;
  }
  if (preserveLoadedState) {
    loadId += 1;
    if (timeout) clearTimeout(timeout);
    timeout = undefined;
  } else {
    stopTracking();
  }
  if (liquid.value.isClosed) return;

  const pendingClose = bitcoinLiquidClose.getPendingLiquidTxInfo(liquid.value.liquidId);
  if (pendingClose) {
    trackTransaction(pendingClose, closeTransaction);
    return;
  }

  const pendingRatchet = bitcoinLiquidRatchet.getPendingRatchetTxInfo(liquid.value.liquidId);
  if (pendingRatchet) {
    trackTransaction(pendingRatchet, ratchetTransaction);
    return;
  }

  if (ratchetState.value.status !== 'ready') ratchetState.value = { status: 'loading' };
  const currentLiquid = liquid.value;
  const currentLoadId = ++loadId;
  void loadRatchet(currentLiquid, currentLoadId);
  void loadCloseQuote(currentLiquid, currentLoadId);

  timeout = setTimeout(() => {
    if (currentLoadId !== loadId) return;
    if (ratchetState.value.status === 'loading') {
      ratchetState.value = { status: 'error', error: 'The latest ratchet availability check did not respond.' };
    }
    if (ratchetQuoteState.value.status === 'loading') {
      ratchetQuoteState.value = { status: 'error', error: 'The ratchet transaction quote did not respond.' };
    }
    if (closeQuoteState.value.status === 'loading') {
      closeQuoteState.value = { status: 'error', error: 'The close transaction quote did not respond.' };
    }
  }, 10_000);
}

async function submitRatchet(): Promise<void> {
  const currentLiquid = liquid.value;
  const ratchetDetailsValue = ratchetState.value.status === 'ready' ? ratchetState.value.value : undefined;
  if (!ratchetDetailsValue?.preview.canRatchet || ratchetTransaction.value.status === 'pending') return;

  ratchetTransaction.value = { status: 'pending', progressPct: 0, progressLabel: 'Preparing transaction...' };
  try {
    const txInfo = await bitcoinLiquidRatchet.submit(
      {
        liquidId: currentLiquid.liquidId,
        microgonsAtTargetPerBtc: ratchetDetailsValue.rate,
        txSigner: ratchetQuote.value!.prepared.txSigner,
      },
      ratchetQuote.value!.prepared,
    );
    if (liquid.value.liquidId !== currentLiquid.liquidId) return;
    trackTransaction(txInfo, ratchetTransaction);
  } catch (error) {
    if (liquid.value.liquidId !== currentLiquid.liquidId) return;
    ratchetTransaction.value = {
      status: 'error',
      error: error instanceof Error ? error.message : 'Unable to ratchet this Liquid.',
      retryAction: 'resubmit',
    };
  }
}

async function submitClose(): Promise<void> {
  const currentLiquid = liquid.value;
  if (closeTransaction.value.status === 'pending') return;

  closeTransaction.value = { status: 'pending', progressPct: 0, progressLabel: 'Preparing transaction...' };
  try {
    const txInfo = await bitcoinLiquidClose.submit(
      {
        liquidId: currentLiquid.liquidId,
        txSigner: closeQuote.value!.prepared.txSigner,
      },
      closeQuote.value!.prepared,
    );
    if (liquid.value.liquidId !== currentLiquid.liquidId) return;
    trackTransaction(txInfo, closeTransaction);
  } catch (error) {
    if (liquid.value.liquidId !== currentLiquid.liquidId) return;
    closeTransaction.value = {
      status: 'error',
      error: error instanceof Error ? error.message : 'Unable to close this Liquid.',
      retryAction: 'resubmit',
    };
  }
}

async function loadRatchet(currentLiquid: BitcoinLiquid, currentLoadId: number): Promise<void> {
  const previousState = ratchetState.value;
  try {
    const client = await getMainchainClient(false);
    const rates = await client.query.bitcoinLocks.microgonPerBtcHistory();
    const rate = rates.at(-1)?.[1];
    if (rate === undefined) throw new Error('Network Bitcoin pricing is currently unavailable.');

    const preview = await bitcoinLiquidRatchet.previewRatchet(currentLiquid.liquidId, rate, client);
    if (!isCurrent(currentLiquid, currentLoadId)) return;

    ratchetState.value = { status: 'ready', value: { rate, preview } };
    if (!preview.canRatchet) {
      ratchetQuoteState.value = { status: 'idle' };
      return;
    }

    await loadRatchetQuote(currentLiquid, rate, preview, currentLoadId);
  } catch (error) {
    if (!isCurrent(currentLiquid, currentLoadId)) return;
    if (previousState.status === 'ready') return;
    ratchetState.value = {
      status: 'error',
      error: error instanceof Error ? error.message : 'Unable to check ratchet availability.',
    };
  }
}

async function loadRatchetQuote(
  currentLiquid: BitcoinLiquid,
  rate: bigint,
  preview: IBitcoinLiquidRatchetPreview,
  currentLoadId: number,
): Promise<void> {
  const loadingState = { status: 'loading' } as const;
  const preserveLoadedState = ratchetQuoteState.value.status === 'ready';
  if (!preserveLoadedState) ratchetQuoteState.value = loadingState;
  try {
    const prepared = await bitcoinLiquidRatchet.prepare({
      liquidId: currentLiquid.liquidId,
      microgonsAtTargetPerBtc: rate,
      txSigner: await walletKeys.getLiquidLockingKeypair(),
    });
    if (!isCurrent(currentLiquid, currentLoadId)) return;

    const unavailableBalance = prepared.unavailableBalance ?? 0n;
    const existentialDeposit = prepared.includeExistentialDeposit
      ? prepared.client.consts.balances.existentialDeposit.toBigInt()
      : 0n;
    ratchetQuoteState.value = {
      status: 'ready',
      value: {
        feeMicrogons: bigIntMax(unavailableBalance - preview.amountToBurn, 0n) + prepared.txFeePlusTip,
        requiredWalletBalanceMicrogons: unavailableBalance + prepared.txFeePlusTip + existentialDeposit,
        availableWalletBalanceMicrogons: prepared.availableBalance,
        prepared,
      },
    };
  } catch (error) {
    if (!isCurrent(currentLiquid, currentLoadId) || preserveLoadedState) return;
    ratchetQuoteState.value = {
      status: 'error',
      error: error instanceof Error ? error.message : 'Unable to quote this ratchet.',
    };
  }
}

async function loadCloseQuote(currentLiquid: BitcoinLiquid, currentLoadId: number): Promise<void> {
  const loadingState = { status: 'loading' } as const;
  const preserveLoadedState = closeQuoteState.value.status === 'ready';
  if (!preserveLoadedState) closeQuoteState.value = loadingState;
  try {
    const prepared = await bitcoinLiquidClose.prepare({
      liquidId: currentLiquid.liquidId,
      txSigner: await walletKeys.getLiquidLockingKeypair(),
    });
    if (!isCurrent(currentLiquid, currentLoadId)) return;

    closeQuoteState.value = {
      status: 'ready',
      value: {
        feeMicrogons: prepared.txFeePlusTip,
        requiredWalletBalanceMicrogons: (prepared.unavailableBalance ?? 0n) + prepared.txFeePlusTip,
        availableWalletBalanceMicrogons: prepared.availableBalance,
        prepared,
      },
    };
  } catch (error) {
    if (!isCurrent(currentLiquid, currentLoadId) || preserveLoadedState) return;
    closeQuoteState.value = {
      status: 'error',
      error: error instanceof Error ? error.message : 'Unable to quote closing this Liquid.',
    };
  }
}

function trackTransaction<Metadata>(
  txInfo: TransactionInfo<Metadata>,
  state: Vue.Ref<LiquidDetailsTransactionState>,
): void {
  transactionCleanupByState.get(state)?.();

  state.value = { status: 'pending', progressPct: 0, progressLabel: 'Preparing transaction...' };
  const unsubscribe = txInfo.subscribeToProgress((progress, error) => {
    state.value = error
      ? { status: 'error', error: error.message, retryAction: 'resubmit' }
      : { status: 'pending', progressPct: progress.progressPct, progressLabel: progress.progressMessage };
  });

  let isCurrentTransaction = true;
  transactionCleanupByState.set(state, () => {
    unsubscribe();
    isCurrentTransaction = false;
  });
  void txInfo.waitForPostProcessing.then(
    () => {
      if (!isCurrentTransaction) return;
      const error = txInfo.getStatus().error;
      if (error) {
        state.value = { status: 'error', error: error.message, retryAction: 'resubmit' };
        return;
      }
      closeOverlay();
    },
    error => {
      if (!isCurrentTransaction) return;
      const shouldResume = txInfo.hasFailedPostProcessing && !getTransactionFailureMessage(txInfo);
      let errorMessage: string;
      if (shouldResume) {
        errorMessage = `The transaction finalized, but the app could not finish updating it. ${error instanceof Error ? error.message : String(error)}`;
      } else if (error instanceof Error) {
        errorMessage = error.message;
      } else {
        errorMessage = 'The transaction did not complete.';
      }

      state.value = {
        status: 'error',
        error: errorMessage,
        retryAction: shouldResume ? 'resume' : 'resubmit',
      };
    },
  );
}

function stopTracking(): void {
  loadId += 1;
  if (timeout) clearTimeout(timeout);
  timeout = undefined;
  transactionCleanupByState.forEach(cleanup => cleanup());
  transactionCleanupByState.clear();
  ratchetState.value = { status: 'idle' };
  ratchetQuoteState.value = { status: 'idle' };
  ratchetTransaction.value = { status: 'idle' };
  closeQuoteState.value = { status: 'idle' };
  closeTransaction.value = { status: 'idle' };
}

function isCurrent(currentLiquid: BitcoinLiquid, currentLoadId: number): boolean {
  return loadId === currentLoadId && liquid.value.liquidId === currentLiquid.liquidId;
}

function closeOverlay(): void {
  stopTracking();
  emit('close');
}

Vue.watch(
  () => liquid.value.liquidId,
  () => initializeActions(),
);
Vue.watch(isClosed, closed => {
  if (closed) stopTracking();
});
Vue.onMounted(initializeActions);
Vue.onUnmounted(stopTracking);
</script>
