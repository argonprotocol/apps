import { addressBytesHex, BitcoinNetwork } from '@argonprotocol/bitcoin';

export function validateBitcoinAddressForNetwork(
  address: string,
  network: BitcoinNetwork,
  args: { disallowAddress?: string } = {},
): string {
  const trimmedAddress = address.trim();
  if (!trimmedAddress) return '';
  if (args.disallowAddress && trimmedAddress.toLowerCase() === args.disallowAddress.trim().toLowerCase()) {
    return 'Enter a different Bitcoin address that you control. Do not reuse the current lock address.';
  }
  if (!looksLikeBitcoinAddress(trimmedAddress, network)) {
    return getBitcoinAddressValidationMessage(network);
  }
  try {
    addressBytesHex(trimmedAddress, network);
    return '';
  } catch {
    return getBitcoinAddressValidationMessage(network);
  }
}

export function getBitcoinNetworkName(network: BitcoinNetwork): string {
  switch (network) {
    case BitcoinNetwork.Bitcoin:
      return 'Bitcoin';
    case BitcoinNetwork.Testnet:
      return 'Bitcoin testnet';
    case BitcoinNetwork.Signet:
      return 'Bitcoin signet';
    default:
      return 'Bitcoin regtest';
  }
}

function looksLikeBitcoinAddress(address: string, network: BitcoinNetwork): boolean {
  const lowerAddress = address.toLowerCase();
  const prefixes = getBitcoinAddressPrefixes(network);
  return prefixes.some(prefix => lowerAddress.startsWith(prefix));
}

function getBitcoinAddressPrefixes(network: BitcoinNetwork): string[] {
  switch (network) {
    case BitcoinNetwork.Bitcoin:
      return ['bc1', '1', '3'];
    case BitcoinNetwork.Testnet:
    case BitcoinNetwork.Signet:
      return ['tb1', 'm', 'n', '2'];
    default:
      return ['bcrt1', 'm', 'n', '2'];
  }
}

function getBitcoinAddressValidationMessage(network: BitcoinNetwork): string {
  return `Enter a valid ${getBitcoinNetworkName(network)} address you control.`;
}
