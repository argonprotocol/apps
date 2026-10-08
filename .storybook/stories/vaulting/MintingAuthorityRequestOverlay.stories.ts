import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { Keyring } from '@argonprotocol/mainchain';
import { minimumVaultDelegateBalance } from '@argonprotocol/apps-core';
import * as Vue from 'vue';
import { fn, mocked, spyOn, userEvent, within } from 'storybook/test';
import basicEmitter from '../../../src-vue/emitters/basicEmitter.ts';
import { TopTab } from '../../../src-vue/interfaces/IConfig.ts';
import { MyVault } from '../../../src-vue/lib/MyVault.ts';
import MintingAuthorityRequestOverlay from '../../../src-vue/overlays/MintingAuthorityRequestOverlay.vue';
import VaultSettingsPanel from '../../../src-vue/panels/VaultSettingsPanel.vue';
import { getBitcoinLocks } from '../../../src-vue/stores/bitcoin.ts';
import { getCurrency } from '../../../src-vue/stores/currency.ts';
import { getFinalizedClient, getMainchainClient } from '../../../src-vue/stores/mainchain.ts';
import { useVaultingAssetBreakdown } from '../../../src-vue/stores/vaultingAssetBreakdown.ts';
import { getMyVault } from '../../../src-vue/stores/vaults.ts';
import { getWalletKeys } from '../../../src-vue/stores/wallets.ts';
import AppScreen from '../../components/AppScreen.vue';
import { createScenarioVault } from '../../scenarios/createScenarioVault.ts';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';

const meta = {
  title: 'Vaulting/Minting authority request',
  component: MintingAuthorityRequestOverlay,
  beforeEach: () => {
    const dateNow = Date.now;
    Date.now = () => Date.UTC(2026, 8, 16, 12);
    return () => {
      Date.now = dateNow;
    };
  },
  render: () => ({
    components: { AppScreen, MintingAuthorityRequestOverlay, VaultSettingsPanel },
    setup() {
      Vue.onMounted(() => basicEmitter.emit('openMintingAuthorityRequestOverlay'));
    },
    template:
      '<AppScreen scenarioLabel="Fixed minting authority preview" /><MintingAuthorityRequestOverlay /><VaultSettingsPanel />',
  }),
  play: async () => {
    await within(document.body).findByRole('button', { name: 'Manage' });
    document.querySelector('[role="dialog"]')?.setAttribute('inert', '');
  },
} satisfies Meta<typeof MintingAuthorityRequestOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NoArgonotsEncumbered: Story = {
  beforeEach: () => setupMintingAuthorityRequest(0n),
};

export const SomeArgonotsEncumbered: Story = {
  beforeEach: () => setupMintingAuthorityRequest(500_000_000n, true),
};

export const AllArgonotsEncumbered: Story = {
  beforeEach: () => setupMintingAuthorityRequest(2_000_000_000n),
};

export const ManageWithPendingWithdrawal: Story = {
  beforeEach: () => setupMintingAuthorityRequest(500_000_000n, true),
  play: async () => {
    await userEvent.click(await within(document.body).findByRole('button', { name: 'Manage' }));
    await within(document.body).findByRole('button', { name: 'Edit Argonot securitization' });
    document.querySelector('[role="dialog"]')?.setAttribute('inert', '');
  },
};

function setupMintingAuthorityRequest(encumberedMicronots: bigint, hasPendingWithdrawal = false) {
  const { wallets } = setupAppScenario({ selectedTab: TopTab.Vaulting, myVaultId: 7 });
  const myVault = getMyVault();
  const delegate = new Keyring({ type: 'sr25519' }).addFromUri('//StorybookVaultDelegate');
  const delegateAddress = delegate.address;
  const vault = createScenarioVault({ delegateAccountId: delegateAddress });
  const commitment = { heldMicronots: 2_000_000_000n, committedMicronots: 2_000_000_000n, encumberedMicronots };
  if (hasPendingWithdrawal) {
    vault.securitizationReleaseSchedule.set(860_720, {
      lockedCommitments: 0n,
      relockableCommitments: 0n,
      argonWithdrawals: 0n,
      argonotWithdrawals: 400_000_000n,
    });
  }
  myVault.data.createdVault = vault;
  myVault.data.argonotCommitment = commitment;
  Object.defineProperty(
    myVault,
    'argonotSecuritizationTarget',
    Object.getOwnPropertyDescriptor(MyVault.prototype, 'argonotSecuritizationTarget')!,
  );
  wallets.defaultArgonWallet.availableMicronots = 1_000_000_000n;
  wallets.defaultArgonSpendableMicrogons = 1_000_000_000n;
  const keys = getWalletKeys();
  keys.getEthereumAddresses = fn(async () => ['0x1111111111111111111111111111111111111111']);
  keys.getVaultDelegateKeypair = fn(async () => delegate);
  spyOn(myVault.mintingAuthorities, 'refresh').mockResolvedValue([]);
  spyOn(myVault.mintingAuthorities, 'getNextSigner').mockResolvedValue({
    signer: '0x2222222222222222222222222222222222222222',
    authorityIndex: 1,
  });
  spyOn(myVault.globalCouncil, 'refresh').mockResolvedValue([]);
  const client = {
    raw: { query: { vaults: { argonotSecuritizationByVaultId: fn() } } },
    consts: { treasury: { minimumArgonsPerContributor: 1_000_000n } },
    query: {
      vaults: { argonotSecuritizationByVaultId: fn(async () => commitment) },
      treasury: {
        bondLotsByVault: fn(async () => ({
          regularBonds: 0,
          flexibleBonds: 0,
          reservedBondSpace: 0,
          displacedFlexibleBonds: 0,
          lockedFrameTerms: null,
        })),
        bondLotIdsByVault: { keys: fn(async () => []) },
        bondLotIdsByAccount: { keys: fn(async () => []) },
        encumberedBondMicrogonsByAccount: fn(async () => 0n),
      },
      crosschainTransfer: {
        activeGlobalIssuanceCouncilByDestinationChain: fn(async () => '0xsyntheticCouncil'),
        minimumMintingAuthorityValueByDestinationChain: fn(async () => 10_000_000_000n),
        globalIssuanceCouncilByHash: fn(async () => ({ epochMicrogonsPerArgonot: 2_000_000n })),
      },
      system: { account: fn(async () => ({ data: { free: minimumVaultDelegateBalance } })) },
    },
  };
  mocked(getFinalizedClient).mockResolvedValue(client as Awaited<ReturnType<typeof getFinalizedClient>>);
  mocked(getMainchainClient, { partial: true, deep: true }).mockResolvedValue({});
  mocked(useVaultingAssetBreakdown, { partial: true }).mockReturnValue(
    Vue.reactive({ securityMicrogons: vault.securitization, securityMicronots: commitment.heldMicronots }),
  );
  getBitcoinLocks().data = Vue.reactive({
    ...getBitcoinLocks().data,
    oracleBitcoinBlockHeight: 860_000,
  });
  getCurrency().fetchMicrogonsInCirculation = fn(async () => 10_000_000_000n);
  getCurrency().fetchMicronotsInCirculation = fn(async () => 5_000_000_000n);
}
