export default interface ISecurity {
  sshPublicKey: string;
  miningHoldAddress: string;
  miningBotAddress: string;
  vaultingAddress: string;
  investmentAddress: string;
  operationalAddress: string;
  ethereumAddress: string;
  ethereumHdPrefixes: {
    primary: `m/44'/60'/${string}`;
    councilSigner: `m/44'/60'/${string}`;
    mintingAuthority: `m/44'/60'/${string}`;
  };
}
