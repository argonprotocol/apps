declare global {
  namespace NodeJS {
    interface ProcessEnv {
      PORT: string;
      KEYPAIR_PATH: string;
      KEYPAIR_PASSPHRASE?: string;
      LOCAL_RPC_URL: string;
      ARCHIVE_NODE_URL: string;
      BIDDING_RULES_PATH: string;
      DATADIR: string;
      SESSION_MINI_SECRET: string;
      OLDEST_FRAME_ID_TO_SYNC?: string;
      ARGON_LOG_STORAGE?: string;
      ARGON_LOG_APIS?: string;
    }
  }
}
