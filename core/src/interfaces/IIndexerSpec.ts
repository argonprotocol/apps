export interface IIndexerSpec {
  '/transfer/:address': {
    responseType: {
      transfers: {
        blockNumber: number;
        source: 'transfer' | 'faucet' | 'tokenGateway';
        currency: 'argon' | 'argonot';
        toAddress: string;
        fromAddress: string | null;
      }[];
      asOfBlock: number;
    };
  };
  '/vault-collects/:address': {
    responseType: {
      vaultCollects: {
        vaultAddress: string;
        blockNumber: number;
      }[];
      asOfBlock: number;
    };
  };
}
