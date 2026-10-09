<template>
  <OverlayBase
    :isOpen="isOpen"
    :disallowClose="!!feeEditorPosition || isSubmitting"
    title="Configure Vault Settings"
    class="bg-argon-menu-bg w-240"
    v-slot="{ floatingZIndex }"
    @close="closeOverlay"
  >
    <PopoverRoot v-model:open="fundingPopoverOpen">
      <div v-if="vault" ref="editBoxParent" class="relative px-10 py-5">
        <p class="mb-5 font-light text-gray-600">
          The following settings control how your vault operates, allocates capital, and earns revenue.
        </p>
        <section class="my-2 flex text-center">
          <div
            ref="argonPosition"
            class="group hover:bg-argon-20 relative flex w-1/3 flex-col items-center px-4"
            data-testid="settings-argn-position"
          >
            <button
              type="button"
              aria-label="Edit Argon securitization"
              :disabled="
                !!pendingTransaction && pendingTransaction.tx.metadataJson.securitizationMicrogons === undefined
              "
              class="focus-visible:outline-argon-600 absolute inset-0 z-10 cursor-pointer rounded-md focus-visible:outline-2 disabled:cursor-default"
              @click="openFundingEditor('ARGN')"
            ></button>
            <div class="group-hover:text-argon-600/70 inline-flex items-center gap-1 text-lg font-bold text-[#a08fb7]">
              Argon Securitization
              <Tooltip as-child side="top">
                <button
                  type="button"
                  class="relative z-20 inline-flex cursor-help"
                  aria-label="Argon securitization details"
                >
                  <InformationCircleIcon class="size-3.5" />
                </button>
                <template #content>Argon securitization supports Bitcoin locks and treasury bonds.</template>
              </Tooltip>
            </div>
            <div
              class="text-argon-700/80 my-1.5 w-full border-y border-dashed border-slate-500/30 py-1 font-mono text-lg font-bold"
            >
              <span class="inline-flex items-center gap-2">
                <span data-testid="Vault.settings.argn">
                  {{ microgonToArgonNm(vault?.securitization ?? 0n).format('0,0.[0]') }} ARGN
                </span>
                <template v-if="displayedTransaction?.tx.metadataJson.securitizationMicrogons !== undefined">
                  <span
                    v-if="failedTransaction || getTransactionFailureMessage(displayedTransaction ?? undefined)"
                    class="font-sans text-xs text-red-700"
                  >
                    Failed
                  </span>
                  <span
                    v-else
                    aria-label="Argon securitization transaction in progress"
                    class="border-t-argon-600 size-3 animate-spin rounded-full border-2 border-slate-300"
                  />
                </template>
                <EditIcon
                  v-else
                  class="text-argon-600/50 h-4.5 w-4.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                />
              </span>
            </div>
            <div class="font-mono text-sm text-gray-500/60">
              <span
                v-if="vaultingBreakdown.bitcoinFundingShortfallMicrogons > 0n"
                class="inline-flex items-center gap-1 text-yellow-800"
              >
                <AlertIcon class="h-4 shrink-0" />
                Add {{ microgonToArgonNm(vaultingBreakdown.bitcoinFundingShortfallMicrogons).format('0,0', Math.ceil) }}
                ARGN
              </span>
              <template v-else>
                {{
                  numeral(currency.convertMicrogonTo(bitcoinCapacityMicrogons, UnitOfMeasurement.BTC)).format(
                    '0,0.[0000]',
                  )
                }}
                BTC Capacity
              </template>
            </div>
          </div>
          <div class="mx-2 w-px bg-slate-300" />
          <div ref="argonotPosition" class="group hover:bg-argon-20 relative flex w-1/3 flex-col items-center px-4">
            <button
              type="button"
              aria-label="Edit Argonot securitization"
              :disabled="!!pendingTransaction && pendingTransaction.tx.metadataJson.committedMicronots === undefined"
              class="focus-visible:outline-argon-600 absolute inset-0 z-10 cursor-pointer rounded-md focus-visible:outline-2 disabled:cursor-default"
              @click="openFundingEditor('ARGNOT')"
            ></button>
            <div class="group-hover:text-argon-600/70 inline-flex items-center gap-1 text-lg font-bold text-[#a08fb7]">
              Argonot Securitization
              <Tooltip as-child side="top">
                <button
                  type="button"
                  class="relative z-20 inline-flex cursor-help"
                  aria-label="Argonot securitization details"
                >
                  <InformationCircleIcon class="size-3.5" />
                </button>
                <template #content>
                  Argonot securitization maximizes your vault’s share of network revenue.
                  <p class="mt-2">
                    {{ micronotToArgonotNm(myVault.data.argonotCommitment.committedMicronots).format('0,0.[0]') }}
                    ARGNOT committed to vault rewards.
                  </p>
                  <p v-if="myVault.mintingAuthorities.data.authorities.length > 0" class="mt-2">
                    {{ micronotToArgonotNm(myVault.data.argonotCommitment.encumberedMicronots).format('0,0.[0]') }}
                    ARGNOT encumbered by minting. These amounts can overlap.
                  </p>
                </template>
              </Tooltip>
            </div>
            <div
              class="text-argon-700/80 my-1.5 w-full border-y border-dashed border-slate-500/30 py-1 font-mono text-lg font-bold"
            >
              <span class="inline-flex items-center gap-2">
                <span data-testid="Vault.settings.argnot">
                  {{ micronotToArgonotNm(myVault.data.argonotCommitment.heldMicronots).format('0,0.[0]') }} ARGNOT
                </span>
                <template v-if="displayedTransaction?.tx.metadataJson.committedMicronots !== undefined">
                  <span
                    v-if="failedTransaction || getTransactionFailureMessage(displayedTransaction ?? undefined)"
                    class="font-sans text-xs text-red-700"
                  >
                    Failed
                  </span>
                  <span
                    v-else
                    aria-label="Argonot securitization transaction in progress"
                    class="border-t-argon-600 size-3 animate-spin rounded-full border-2 border-slate-300"
                  />
                </template>
                <EditIcon
                  v-else
                  class="text-argon-600/50 h-4.5 w-4.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                />
              </span>
            </div>
            <div class="font-mono text-sm text-gray-500/60">
              <Tooltip v-if="rewardBacking && rewardBacking.additionalMicronots > 0n" as-child side="top">
                <span class="relative z-20 inline-flex cursor-help items-center gap-1 text-yellow-800" tabindex="0">
                  <AlertIcon class="h-4 shrink-0" />
                  +{{ micronotToArgonotNm(rewardBacking.additionalMicronots).format('0,0.[0]') }} for Max Returns
                </span>
                <template #content>
                  Add {{ micronotToArgonotNm(rewardBacking.additionalMicronots).format('0,0.[0]') }} ARGNOT to maximize
                  your vault’s earnings.
                </template>
              </Tooltip>
              <template v-else-if="rewardBacking">
                {{ micronotToArgonotNm(rewardBacking.totalMicronots).format('0,0.[0]') }} for Max Returns
              </template>
              <template v-else>Max Returns unavailable</template>
            </div>
          </div>
          <div class="mx-2 w-px bg-slate-300" />
          <div class="group hover:bg-argon-20 relative flex w-1/3 flex-col items-center px-4">
            <button
              type="button"
              aria-label="Edit Bitcoin locking fee"
              :disabled="!!pendingTransaction || isSubmitting"
              @click="openFeeEditor"
              class="focus-visible:outline-argon-600 absolute inset-0 z-10 cursor-pointer rounded-md focus-visible:outline-2"
            ></button>
            <div class="group-hover:text-argon-600/70 inline-flex items-center gap-1 text-lg font-bold text-[#a08fb7]">
              Bitcoin Locking Fee
              <Tooltip as-child side="top">
                <button
                  type="button"
                  class="relative z-20 inline-flex cursor-help"
                  aria-label="Bitcoin locking fee details"
                >
                  <InformationCircleIcon class="size-3.5" />
                </button>
                <template #content>
                  Paid to your vault when someone locks Bitcoin. Includes a flat ARGN fee and an annual percentage fee
                  for the duration of the lock.
                </template>
              </Tooltip>
            </div>
            <div
              ref="feeEditAnchor"
              class="text-argon-700/80 my-1.5 w-full border-y border-dashed border-slate-500/30 py-1 font-mono text-lg font-bold"
            >
              <span class="inline-flex items-center gap-2">
                {{ currency.symbol }}{{ microgonToMoneyNm(bitcoinTerms?.bitcoinBaseFee ?? 0n).format('0,0.00') }} +
                {{ numeral(bitcoinTerms?.bitcoinAnnualPercentRate.times(100).toNumber() ?? 0).format('0.[00]') }}%
                <EditIcon
                  class="text-argon-600/50 h-4.5 w-4.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                />
              </span>
            </div>
            <div class="font-mono text-sm text-gray-500/60">Per Transaction</div>
          </div>
        </section>
        <div class="mt-5 border-t border-slate-300 pt-4">
          <div class="flex items-center justify-between">
            <h3 class="font-semibold text-slate-700">Exit Schedule</h3>
            <div class="inline-flex items-center gap-1 text-sm text-slate-500">
              1 Year Withdrawal Notice
              <Tooltip as-child side="top">
                <button
                  type="button"
                  class="relative z-20 inline-flex cursor-help"
                  aria-label="Withdrawal notice details"
                >
                  <InformationCircleIcon class="size-3.5" />
                </button>
                <template #content>
                  Withdrawals require a one year exit notice. ARGNOT above max rewards are available for immediate
                  withdrawal.
                </template>
              </Tooltip>
            </div>
          </div>
          <p
            v-if="!pendingArgonWithdrawals.size && !pendingArgonotWithdrawals.size"
            class="mt-3 text-sm text-slate-500"
          >
            No withdrawals requested.
          </p>
          <div
            v-for="[height, amount] in pendingArgonWithdrawals"
            :key="`argon:${height}`"
            class="flex items-center justify-between border-b border-slate-200 py-2.5 text-sm last:border-b-0"
          >
            <span>{{ microgonToArgonNm(amount).format('0,0.[0]') }} ARGN</span>
            <span class="text-slate-500">
              <template v-if="height <= bitcoinLocks.data.oracleBitcoinBlockHeight">Awaiting Release</template>
              <template v-else>
                Eligible
                {{
                  new Date(
                    Date.now() + (height - bitcoinLocks.data.oracleBitcoinBlockHeight) * BITCOIN_BLOCK_MILLIS,
                  ).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
                }}
              </template>
            </span>
          </div>
          <div
            v-for="[height, amount] in pendingArgonotWithdrawals"
            :key="`argonot:${height}`"
            class="flex items-center justify-between border-b border-slate-200 py-2.5 text-sm last:border-b-0"
          >
            <span>{{ micronotToArgonotNm(amount).format('0,0.[0]') }} ARGNOT</span>
            <span class="text-slate-500">
              <template v-if="height <= bitcoinLocks.data.oracleBitcoinBlockHeight">Awaiting Release</template>
              <template v-else>
                Eligible
                {{
                  new Date(
                    Date.now() + (height - bitcoinLocks.data.oracleBitcoinBlockHeight) * BITCOIN_BLOCK_MILLIS,
                  ).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
                }}
              </template>
            </span>
          </div>
        </div>
        <EditBoxOverlay
          v-if="feeEditorPosition"
          id="btcLockingFees"
          :position="feeEditorPosition"
          @close="feeEditorPosition = undefined"
        />
        <div class="mt-5 flex justify-end gap-3 border-t border-slate-200 pt-4">
          <button
            type="button"
            class="cursor-pointer rounded-md border border-slate-300 px-10 py-2 text-slate-600 hover:bg-slate-50"
            @click="closeOverlay"
          >
            Close
          </button>
        </div>
      </div>
      <div v-else class="px-10 py-10 text-center text-slate-500">Loading vault settings…</div>
      <PopoverAnchor :reference="fundingAsset === 'ARGN' ? argonPosition : argonotPosition" />
      <PopoverPortal>
        <PopoverContent
          side="bottom"
          align="center"
          :sideOffset="8"
          :collisionPadding="24"
          :style="{ zIndex: floatingZIndex }"
          class="w-96 rounded-md border border-gray-800/20 bg-white text-slate-600 shadow-lg"
          aria-label="Securitization editor"
        >
          <div v-if="selectedTransaction" class="px-5 pt-4">
            <p class="mb-1 font-bold text-slate-700">
              <template v-if="transactionChange === undefined">Changing {{ fundingAsset }} securitization</template>
              <template v-else>
                {{ transactionChange < 0n ? 'Withdrawing' : 'Adding' }}
                {{
                  microgonToArgonNm(transactionChange < 0n ? -transactionChange : transactionChange).format('0,0.[0]')
                }}
                ARGN
              </template>
            </p>
            <p v-if="transactionSecuritization !== undefined" class="text-sm text-slate-500">
              Securitization after change:
              <template v-if="fundingAsset === 'ARGN'">
                {{ microgonToArgonNm(transactionSecuritization).format('0,0.[0]') }}
              </template>
              <template v-else>{{ micronotToArgonotNm(transactionSecuritization).format('0,0.[0]') }}</template>
              {{ fundingAsset }}
            </p>
            <div class="mt-4 border-t border-slate-300 pt-4">
              <ProgressBar
                :progress="progressPct"
                :hasError="!!transactionError"
                :class="transactionError ? '' : 'opacity-60'"
              />
              <p class="mt-2 text-sm" :class="transactionError ? 'text-red-700' : 'text-slate-500'">
                {{ transactionError || progressLabel }}
              </p>
              <p v-if="!transactionError" class="mt-4 text-sm text-slate-500">
                You can close this popover while the transaction finishes.
              </p>
            </div>
          </div>
          <div v-else class="px-5 pt-4">
            <fieldset
              class="mb-4 flex gap-6 border-b border-slate-300 pb-3"
              aria-label="Securitization action"
              :disabled="isSubmitting"
            >
              <label class="flex cursor-pointer items-center gap-2 font-semibold">
                <input
                  v-model="fundingAction"
                  type="radio"
                  name="vault-funding-action"
                  value="add"
                  class="accent-argon-600 size-4 cursor-pointer"
                  @change="changeAmount = 0n"
                />
                Add
              </label>
              <label class="flex cursor-pointer items-center gap-2 font-semibold">
                <input
                  v-model="fundingAction"
                  type="radio"
                  name="vault-funding-action"
                  value="withdraw"
                  class="accent-argon-600 size-4 cursor-pointer"
                  @change="changeAmount = 0n"
                />
                Withdraw
              </label>
            </fieldset>
            <div
              v-if="
                fundingAsset === 'ARGN' &&
                fundingAction === 'add' &&
                vaultingBreakdown.bitcoinFundingShortfallMicrogons > 0n
              "
              role="alert"
              class="mb-4 flex items-center rounded border border-yellow-400/70 bg-yellow-100 px-3 py-3 text-sm text-yellow-900"
            >
              <AlertIcon class="mr-2 h-4 shrink-0 text-yellow-700" />
              <span>
                Add
                {{
                  microgonToMoneyNm(vaultingBreakdown.bitcoinFundingShortfallMicrogons).formatCurrency(currency.symbol)
                }}
                in securitization to fully back your Bitcoin for rewards.
              </span>
            </div>
            <div class="mb-2 flex items-center justify-between text-sm">
              <label class="font-bold text-gray-600/60">
                Amount to {{ fundingAction === 'add' ? 'Add' : 'Withdraw' }}
              </label>
              <button
                v-if="
                  fundingAsset === 'ARGN' &&
                  fundingAction === 'add' &&
                  vaultingBreakdown.bitcoinFundingShortfallMicrogons > 0n
                "
                type="button"
                :disabled="isSubmitting"
                class="text-argon-600 cursor-pointer disabled:text-gray-400"
                @click="changeAmount = vaultingBreakdown.bitcoinFundingShortfallMicrogons"
              >
                Full Securitization
              </button>
              <button
                v-if="fundingAsset === 'ARGNOT' && fundingAction === 'add'"
                type="button"
                :disabled="!rewardBacking || isSubmitting"
                class="text-argon-600 cursor-pointer disabled:text-gray-400"
                @click="
                  changeAmount = rewardBacking
                    ? bigIntMax(0n, rewardBacking.totalMicronots - selectedSecuritization)
                    : 0n
                "
              >
                Max Returns
              </button>
            </div>
            <InputToken
              v-model="changeAmount"
              :min="0n"
              :max="fundingAction === 'withdraw' ? maximumChange : undefined"
              :suffix="` ${fundingAsset}`"
              :minDecimals="0"
              :maxDecimals="6"
              :disabled="isSubmitting"
              data-testid="settings-funding-amount"
            />
            <SliderRoot
              v-model="fundingSlider"
              class="relative mt-1 flex h-5 w-full touch-none items-center select-none"
              :min="0"
              :max="100"
              :step="0.01"
              :disabled="isSubmitting || maximumChange === 0n"
              data-testid="settings-funding-slider"
            >
              <SliderTrack class="relative h-2 grow rounded-full bg-gray-500/30">
                <SliderRange class="bg-argon-600/50 absolute h-full rounded-full" />
              </SliderTrack>
              <SliderThumb
                :aria-label="`${fundingAsset} amount to ${fundingAction === 'add' ? 'add' : 'withdraw'}`"
                class="block h-5 w-5 rounded-full border border-gray-400 bg-white shadow-sm focus:outline-none"
              />
            </SliderRoot>
            <div class="mt-1 flex justify-between text-sm text-slate-500">
              <span>0 {{ fundingAsset }}</span>
              <span>
                <template v-if="fundingAsset === 'ARGN'">
                  {{ microgonToArgonNm(maximumChange).format('0,0.[0]') }}
                </template>
                <template v-else>{{ micronotToArgonotNm(maximumChange).format('0,0.[0]') }}</template>
                {{ fundingAsset }}
              </span>
            </div>
            <p v-if="fundingAction === 'withdraw'" class="mt-2 text-sm text-slate-500">
              Available now:
              <template v-if="fundingAsset === 'ARGN'">
                {{ microgonToArgonNm(availableImmediateWithdrawal).format('0,0.[0]') }}
              </template>
              <template v-else>{{ micronotToArgonotNm(availableImmediateWithdrawal).format('0,0.[0]') }}</template>
              {{ fundingAsset }}
            </p>
            <WalletFundingCallout
              v-if="walletShortfall > 0n || argonotWalletShortfall > 0n"
              :showArrow="false"
              @open-wallet="openWallet"
            >
              <span class="text-sm">
                <template v-if="argonotWalletShortfall > 0n">
                  Add {{ micronotToArgonotNm(argonotWalletShortfall).format('0,0.[00]') }} ARGNOT to your wallet.
                </template>
                <template v-if="walletShortfall > 0n">
                  Add {{ microgonToArgonNm(walletShortfall).format('0,0.[00]') }} ARGN for this change and its
                  transaction fee.
                </template>
              </span>
            </WalletFundingCallout>
            <p v-if="transactionError" role="alert" class="mt-3 text-sm text-red-700">
              {{ transactionError }}
              <button
                type="button"
                :disabled="isSubmitting || isCheckingFee"
                class="cursor-pointer underline"
                @click="updateFee"
              >
                Retry
              </button>
            </p>
            <div class="mt-4 border-t border-slate-200 pt-3 text-sm">
              <div class="flex items-center justify-between">
                <span>Securitization after change</span>
                <strong>
                  <template v-if="fundingAsset === 'ARGN'">
                    {{ microgonToArgonNm(proposedSecuritization).format('0,0.[0]') }}
                  </template>
                  <template v-else>{{ micronotToArgonotNm(proposedSecuritization).format('0,0.[0]') }}</template>
                  {{ fundingAsset }}
                </strong>
              </div>
              <div v-if="fundingAsset === 'ARGN'" class="mt-2 flex items-center justify-between text-slate-500">
                <span>Bitcoin capacity</span>
                <span>
                  {{
                    numeral(
                      currency.convertMicrogonTo(
                        bigNumberToBigInt(BigNumber(proposedSecuritization).div(vault?.securitizationRatio ?? 1)),
                        UnitOfMeasurement.BTC,
                      ),
                    ).format('0,0.[0000]')
                  }}
                  BTC
                </span>
              </div>
              <template v-if="fundingAction === 'withdraw' && changeAmount > 0n">
                <div class="mt-3 flex items-center justify-between border-t border-slate-200 pt-3">
                  <span>Returned immediately</span>
                  <span>
                    <template v-if="fundingAsset === 'ARGN'">
                      {{ microgonToArgonNm(immediateReturn).format('0,0.[0]') }}
                    </template>
                    <template v-else>{{ micronotToArgonotNm(immediateReturn).format('0,0.[0]') }}</template>
                    {{ fundingAsset }}
                  </span>
                </div>
                <p
                  v-if="
                    fundingAsset === 'ARGN' &&
                    vault?.operationalMinimumReleaseTick != null &&
                    currentTick < vault.operationalMinimumReleaseTick &&
                    proposedSecuritization < vault.operationalMinimumMicrogons
                  "
                  class="mt-2 text-slate-500"
                >
                  Certification minimum remains held until
                  {{
                    new Date(vault.operationalMinimumReleaseTick * vault.tickDuration).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })
                  }}.
                </p>
                <div
                  v-for="[height, amount] in proposedWithdrawals"
                  :key="height"
                  class="mt-2 flex items-center justify-between text-slate-500"
                >
                  <span>
                    <template v-if="fundingAsset === 'ARGN'">
                      {{ microgonToArgonNm(amount).format('0,0.[0]') }}
                    </template>
                    <template v-else>{{ micronotToArgonotNm(amount).format('0,0.[0]') }}</template>
                    {{ fundingAsset }}
                  </span>
                  <span>
                    <template v-if="height <= bitcoinLocks.data.oracleBitcoinBlockHeight">Awaiting Release</template>
                    <template v-else>
                      Eligible
                      {{
                        new Date(
                          Date.now() + (height - bitcoinLocks.data.oracleBitcoinBlockHeight) * BITCOIN_BLOCK_MILLIS,
                        ).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
                      }}
                    </template>
                  </span>
                </div>
              </template>
              <p v-if="withdrawalCancellation > 0n" class="mt-3 text-slate-500">
                Cancels
                <template v-if="fundingAsset === 'ARGN'">
                  {{ microgonToArgonNm(withdrawalCancellation).format('0,0.[0]') }}
                </template>
                <template v-else>{{ micronotToArgonotNm(withdrawalCancellation).format('0,0.[0]') }}</template>
                {{ fundingAsset }} of pending withdrawals.
              </p>
            </div>
          </div>
          <div class="mx-2 mt-5 flex justify-end gap-3 border-t border-slate-400/50 pt-3 pr-3 pb-3">
            <button
              type="button"
              class="cursor-pointer rounded-md border border-slate-400 px-3 text-sm text-slate-800/70"
              :disabled="isSubmitting"
              @click="fundingPopoverOpen = false"
            >
              {{ selectedTransaction ? 'Close' : 'Cancel' }}
            </button>
            <button
              v-if="!selectedTransaction"
              type="button"
              :disabled="
                changeAmount <= 0n ||
                !!pendingTransaction ||
                isSubmitting ||
                isCheckingFee ||
                !!transactionError ||
                walletShortfall > 0n ||
                argonotWalletShortfall > 0n
              "
              class="bg-argon-button border-argon-600 cursor-pointer rounded-md border px-3 text-sm text-white disabled:opacity-40"
              @click="submitChange"
            >
              <template v-if="isSubmitting">Submitting…</template>
              <template v-else-if="fundingAction === 'add'">Add Funds</template>
              <template v-else>Request Withdrawal</template>
            </button>
            <button
              v-else-if="transactionError"
              type="button"
              :disabled="isSubmitting"
              class="bg-argon-button border-argon-600 cursor-pointer rounded-md border px-3 text-sm text-white disabled:opacity-40"
              @click="retryChange"
            >
              {{
                selectedTransaction.getStatus().isFinalized && !getTransactionFailureMessage(selectedTransaction)
                  ? 'Try Again'
                  : 'Edit Change'
              }}
            </button>
          </div>
          <PopoverPanelArrow class="-translate-y-px" />
        </PopoverContent>
      </PopoverPortal>
    </PopoverRoot>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import BigNumber from 'bignumber.js';
import { InformationCircleIcon } from '@heroicons/vue/24/outline';
import { bigIntMax, bigIntMin, bigNumberToBigInt, UnitOfMeasurement } from '@argonprotocol/apps-core';
import AlertIcon from '../assets/alert.svg?component';
import EditIcon from '../assets/edit.svg?component';
import {
  PopoverAnchor,
  PopoverContent,
  PopoverPortal,
  PopoverRoot,
  SliderRange,
  SliderRoot,
  SliderThumb,
  SliderTrack,
} from 'reka-ui';
import InputToken from '../components/InputToken.vue';
import ProgressBar from '../components/ProgressBar.vue';
import PopoverPanelArrow from '../components/PopoverPanelArrow.vue';
import Tooltip from '../components/Tooltip.vue';
import { BITCOIN_BLOCK_MILLIS } from '../lib/Env.ts';
import type { MyVault } from '../lib/MyVault.ts';
import basicEmitter from '../emitters/basicEmitter.ts';
import WalletFundingCallout from '../components/WalletFundingCallout.vue';
import { existentialDepositMicronots } from '../lib/WalletForArgon.ts';
import { getConfig } from '../stores/config.ts';
import { getMiningFrames } from '../stores/mainchain.ts';
import { getTransactionFailureMessage } from '../lib/TransactionInfo.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import EditBoxOverlay from '../overlays/EditBoxOverlay.vue';
import OverlayBase from '../overlays/OverlayBase.vue';
import { getArgonBonds } from '../stores/argonBonds.ts';
import { getBitcoinLocks } from '../stores/bitcoin.ts';
import { getCurrency } from '../stores/currency.ts';
import { getMyVault } from '../stores/vaults.ts';
import { useVaultingAssetBreakdown } from '../stores/vaultingAssetBreakdown.ts';
import { useWallets } from '../stores/wallets.ts';

const myVault = getMyVault();
const currency = getCurrency();
const wallets = useWallets();
const argonBonds = getArgonBonds();
const vaultingBreakdown = useVaultingAssetBreakdown();
const bitcoinLocks = getBitcoinLocks();
const miningFrames = getMiningFrames();
const currentTick = Vue.ref(miningFrames.currentTick);
const tickSubscription = miningFrames.onTick(tick => {
  currentTick.value = tick;
});
const config = getConfig();
const { microgonToArgonNm, micronotToArgonotNm, microgonToMoneyNm } = createNumeralHelpers(currency);

// Current vault positions and exit schedule.
const vault = Vue.computed(() => myVault.createdVault);
const bitcoinTerms = Vue.computed(() => vault.value?.pendingTerms?.[1] ?? vault.value?.terms);

const bitcoinCapacityMicrogons = Vue.computed(() =>
  bigNumberToBigInt(BigNumber(vault.value?.securitization ?? 0n).div(vault.value?.securitizationRatio ?? 1)),
);

const rewardBacking = Vue.computed(() =>
  vault.value
    ? argonBonds.argonotRewardBacking({
        vault: vault.value,
        argonotSecuritization: myVault.data.argonotCommitment,
        securitizationMicrogons: vault.value.securitizationTarget,
      })
    : undefined,
);

const pendingArgonWithdrawals = Vue.computed(
  () =>
    vault.value?.previewArgonWithdrawals(
      vault.value.securitizationTarget,
      bitcoinLocks.data.oracleBitcoinBlockHeight,
      currentTick.value,
    ) ?? new Map<number, bigint>(),
);

const pendingArgonotWithdrawals = Vue.computed(
  () =>
    vault.value?.previewArgonotWithdrawals(
      myVault.argonotSecuritizationTarget,
      myVault.data.argonotCommitment,
      bitcoinLocks.data.oracleBitcoinBlockHeight,
    ) ?? new Map<number, bigint>(),
);

// Overlay visibility and editor anchors.
const isOpen = Vue.ref(false);
const returnToInvite = Vue.ref(false);
const argonPosition = Vue.ref<HTMLElement>();
const argonotPosition = Vue.ref<HTMLElement>();
const editBoxParent = Vue.ref<HTMLElement>();
const feeEditAnchor = Vue.ref<HTMLElement>();
const feeEditorPosition = Vue.ref<{ top: number; left: number; width: number }>();
const fundingPopoverOpen = Vue.ref(false);

// Funding draft and available capital.
const fundingAsset = Vue.ref<'ARGN' | 'ARGNOT'>('ARGN');
const fundingAction = Vue.ref<'add' | 'withdraw'>('add');
const changeAmount = Vue.ref(0n);
const txFee = Vue.ref(0n);
const isCheckingFee = Vue.ref(false);
const isSubmitting = Vue.ref(false);
let feeRequest = 0;

const selectedSecuritization = Vue.computed(() =>
  fundingAsset.value === 'ARGN' ? (vault.value?.securitizationTarget ?? 0n) : myVault.argonotSecuritizationTarget,
);

const selectedHeld = Vue.computed(() =>
  fundingAsset.value === 'ARGN' ? (vault.value?.securitization ?? 0n) : myVault.data.argonotCommitment.heldMicronots,
);

const proposedSecuritization = Vue.computed(() =>
  fundingAction.value === 'add'
    ? selectedSecuritization.value + changeAmount.value
    : bigIntMax(0n, selectedSecuritization.value - changeAmount.value),
);

const maximumChange = Vue.computed(() => {
  if (fundingAction.value === 'withdraw') {
    if (fundingAsset.value === 'ARGN') return selectedSecuritization.value;
    return bigIntMax(0n, selectedSecuritization.value - myVault.data.argonotCommitment.encumberedMicronots);
  }
  if (fundingAsset.value === 'ARGN')
    return bigIntMax(
      0n,
      selectedHeld.value + wallets.defaultArgonSpendableMicrogons - txFee.value - selectedSecuritization.value,
    );
  return bigIntMax(
    0n,
    selectedHeld.value +
      bigIntMax(0n, wallets.defaultArgonWallet.availableMicronots - existentialDepositMicronots) -
      selectedSecuritization.value,
  );
});

const fundingSlider = Vue.computed<number[]>({
  get: () => {
    if (maximumChange.value === 0n) return [0];
    return [Math.min(100, BigNumber(changeAmount.value).div(maximumChange.value).times(100).toNumber())];
  },
  set: ([percent = 0]) => {
    changeAmount.value = bigNumberToBigInt(
      BigNumber(maximumChange.value)
        .times(Math.max(0, Math.min(100, percent)))
        .div(100),
    );
  },
});

const fundingChange = Vue.computed<Parameters<MyVault['estimateSecuritizationFee']>[0]>(() => {
  if (fundingAsset.value === 'ARGN') return { securitizationMicrogons: proposedSecuritization.value };
  return { committedMicronots: proposedSecuritization.value };
});

const walletDeposit = Vue.computed(() => {
  if (fundingAction.value === 'withdraw') return 0n;
  return bigIntMax(0n, proposedSecuritization.value - selectedHeld.value);
});

const walletShortfall = Vue.computed(() => {
  const deposit = fundingAsset.value === 'ARGN' ? walletDeposit.value : 0n;
  return bigIntMax(0n, deposit + txFee.value - wallets.defaultArgonSpendableMicrogons);
});

const argonotWalletShortfall = Vue.computed(() => {
  if (fundingAsset.value !== 'ARGNOT') return 0n;
  return bigIntMax(
    0n,
    walletDeposit.value - bigIntMax(0n, wallets.defaultArgonWallet.availableMicronots - existentialDepositMicronots),
  );
});

// Withdrawal preview for the draft.
const proposedWithdrawals = Vue.computed(() => {
  if (!vault.value) return new Map<number, bigint>();
  if (fundingAsset.value === 'ARGN')
    return vault.value.previewArgonWithdrawals(
      proposedSecuritization.value,
      bitcoinLocks.data.oracleBitcoinBlockHeight,
      currentTick.value,
    );
  return vault.value.previewArgonotWithdrawals(
    proposedSecuritization.value,
    myVault.data.argonotCommitment,
    bitcoinLocks.data.oracleBitcoinBlockHeight,
  );
});

const availableImmediateWithdrawal = Vue.computed(() => {
  if (!vault.value || fundingAction.value !== 'withdraw') return 0n;
  if (fundingAsset.value === 'ARGN')
    return bigIntMin(maximumChange.value, vault.value.availableArgonWithdrawal(currentTick.value));
  return bigIntMin(maximumChange.value, vault.value.availableArgonotWithdrawal(myVault.data.argonotCommitment));
});

const immediateReturn = Vue.computed(() =>
  fundingAction.value === 'withdraw' ? bigIntMin(changeAmount.value, availableImmediateWithdrawal.value) : 0n,
);

const withdrawalCancellation = Vue.computed(() =>
  fundingAction.value === 'add'
    ? bigIntMin(changeAmount.value, bigIntMax(0n, selectedHeld.value - selectedSecuritization.value))
    : 0n,
);

// Submitted transaction and progress.
const pendingTransaction = Vue.computed(() => myVault.data.pendingAllocateTxInfo);

// Retain a failed result for this mounted workflow after MyVault clears its pending command.
const failedTransaction = Vue.shallowRef<MyVault['data']['pendingAllocateTxInfo']>();
const failedTransactionError = Vue.ref('');
const displayedTransaction = Vue.computed(() => pendingTransaction.value ?? failedTransaction.value);

const selectedTransaction = Vue.computed(() => {
  const transaction = displayedTransaction.value;
  if (fundingAsset.value === 'ARGN' && transaction?.tx.metadataJson.securitizationMicrogons !== undefined)
    return transaction;
  if (fundingAsset.value === 'ARGNOT' && transaction?.tx.metadataJson.committedMicronots !== undefined)
    return transaction;
});

const transactionChange = Vue.computed(() => {
  if (fundingAsset.value !== 'ARGN') return;
  return selectedTransaction.value?.tx.metadataJson.securitizationTargetChangeMicrogons;
});

const transactionSecuritization = Vue.computed(() => {
  const metadata = selectedTransaction.value?.tx.metadataJson;
  return fundingAsset.value === 'ARGN' ? metadata?.securitizationMicrogons : metadata?.committedMicronots;
});

const progressPct = Vue.ref(0);
const progressLabel = Vue.ref('');
const transactionError = Vue.ref('');

// Opening and closing editors.
async function openOverlay(request?: { returnToInvite?: boolean; fundingAsset?: typeof fundingAsset.value }) {
  returnToInvite.value = request?.returnToInvite ?? false;
  isOpen.value = true;
  if (request?.fundingAsset) {
    await Vue.nextTick();
    openFundingEditor(request.fundingAsset);
  }
}

function closeOverlay() {
  if (feeEditorPosition.value || isSubmitting.value) return;

  fundingPopoverOpen.value = false;
  isOpen.value = false;
  feeRequest += 1;
  if (returnToInvite.value) basicEmitter.emit('openMemberInviteOverlay', { preserveDraft: true });
}

function openFundingEditor(asset: typeof fundingAsset.value) {
  fundingAsset.value = asset;
  fundingAction.value = 'add';
  changeAmount.value = 0n;
  txFee.value = 0n;
  transactionError.value = selectedTransaction.value
    ? (getTransactionFailureMessage(selectedTransaction.value) ?? failedTransactionError.value)
    : '';
  fundingPopoverOpen.value = true;
}

function openWallet() {
  closeOverlay();
  basicEmitter.emit('openWalletOverlay', { wallet: wallets.argonWallets.defaultArgonWallet });
}

function openFeeEditor() {
  const terms = bitcoinTerms.value!;
  config.vaultSetup.btcFlatFee = terms.bitcoinBaseFee;
  config.vaultSetup.btcPctFee = terms.bitcoinAnnualPercentRate.times(100).toNumber();

  const parent = editBoxParent.value!.getBoundingClientRect();
  const anchor = feeEditAnchor.value!.getBoundingClientRect();
  feeEditorPosition.value = { top: anchor.top - parent.top, left: anchor.left - parent.left, width: parent.width / 2 };
}

// Estimating and submitting funding changes.
async function updateFee() {
  const request = ++feeRequest;
  if (!isOpen.value || !fundingPopoverOpen.value || changeAmount.value <= 0n || selectedTransaction.value) {
    txFee.value = 0n;
    isCheckingFee.value = false;
    return;
  }

  const change = fundingChange.value;
  const usingWalletMaximum = fundingAction.value === 'add' && changeAmount.value === maximumChange.value;
  isCheckingFee.value = true;
  transactionError.value = '';

  try {
    const fee = await myVault.estimateSecuritizationFee(change, wallets.defaultArgonWallet.address);
    if (request !== feeRequest) return;
    txFee.value = fee;
    if (usingWalletMaximum) changeAmount.value = maximumChange.value;
  } catch (error) {
    if (request !== feeRequest) return;
    txFee.value = 0n;
    transactionError.value = error instanceof Error ? error.message : 'Unable to calculate the transaction fee.';
  } finally {
    if (request === feeRequest) isCheckingFee.value = false;
  }
}

async function submitChange() {
  if (pendingTransaction.value || isSubmitting.value || changeAmount.value <= 0n) return;

  isSubmitting.value = true;
  try {
    await updateFee();
    if (transactionError.value || walletShortfall.value > 0n || argonotWalletShortfall.value > 0n) return;
    if (fundingAction.value === 'withdraw' && changeAmount.value > maximumChange.value) return;

    failedTransaction.value = undefined;
    failedTransactionError.value = '';
    const info = await myVault.setVaultSecuritization(fundingChange.value);
    isSubmitting.value = false;
    // MyVault publishes the finalized vault and exit schedule before resolving this promise.
    await info.waitForPostProcessing;
  } catch (error) {
    transactionError.value = error instanceof Error ? error.message : 'Unable to update securitization.';
  } finally {
    isSubmitting.value = false;
  }
}

async function retryChange() {
  const info = selectedTransaction.value;
  if (!info || pendingTransaction.value || isSubmitting.value) return;

  if (!info.getStatus().isFinalized || getTransactionFailureMessage(info)) {
    failedTransaction.value = undefined;
    failedTransactionError.value = '';
    transactionError.value = '';
    changeAmount.value = 0n;
    return;
  }

  // A finalized command must be reconciled, not submitted a second time.
  isSubmitting.value = true;
  try {
    await myVault.recordFinalizedVaultCapital(info);
    failedTransaction.value = undefined;
    failedTransactionError.value = '';
    transactionError.value = '';
    fundingPopoverOpen.value = false;
  } catch (error) {
    transactionError.value = error instanceof Error ? error.message : 'Unable to refresh securitization.';
  } finally {
    isSubmitting.value = false;
  }
}

// Synchronize draft fees and submitted transaction progress.
Vue.watch([fundingChange, fundingPopoverOpen], () => {
  if (!isSubmitting.value) void updateFee();
});

Vue.watch(
  pendingTransaction,
  (info, _, onCleanup) => {
    if (!info) return;
    failedTransaction.value = undefined;
    failedTransactionError.value = '';
    transactionError.value = getTransactionFailureMessage(info) ?? '';
    progressPct.value = info.getStatus().progressPct;
    progressLabel.value = 'Waiting for transaction finalization…';

    const unsubscribe = info.subscribeToProgress((progress, error) => {
      progressPct.value = progress.progressPct;
      progressLabel.value = progress.progressMessage;
      transactionError.value = error?.message ?? getTransactionFailureMessage(info) ?? '';
    });

    void info.waitForPostProcessing.then(
      () => {
        if (pendingTransaction.value && pendingTransaction.value.tx.id !== info.tx.id) return;
        failedTransaction.value = undefined;
        failedTransactionError.value = '';
        transactionError.value = '';
        changeAmount.value = 0n;
        fundingPopoverOpen.value = false;
      },
      error => {
        if (pendingTransaction.value && pendingTransaction.value.tx.id !== info.tx.id) return;
        failedTransaction.value = info;
        failedTransactionError.value = error instanceof Error ? error.message : 'Unable to finish securitization.';
        transactionError.value = failedTransactionError.value;
      },
    );
    onCleanup(unsubscribe);
  },
  { immediate: true },
);

basicEmitter.on('openVaultSettingsOverlay', openOverlay);
Vue.onBeforeUnmount(() => {
  tickSubscription.unsubscribe();
  feeRequest += 1;
  basicEmitter.off('openVaultSettingsOverlay', openOverlay);
});
</script>
