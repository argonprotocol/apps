export const LOCAL_NODE_URL = process.env.ARGON_LOCAL_NODE;
export const MAIN_NODE_URL = process.env.ARGON_ARCHIVE_NODE;
export const VAULT_OPERATOR_ADDRESS = process.env.VAULT_OPERATOR_ADDRESS;
export const ADMIN_OPERATOR_ACCOUNT_ID = process.env.OPERATOR_ACCOUNT_ID;
export const ROUTER_AUTH_SESSION_TTL_SECONDS = process.env.ROUTER_AUTH_SESSION_TTL_SECONDS;
export const PORT = process.env.PORT || 8080;

export const ARGON_CHAIN = process.env.ARGON_CHAIN;
export const BITCOIN_CHAIN = process.env.BITCOIN_CHAIN;
export const BITCOIN_RPC_URL = process.env.BITCOIN_RPC_URL;
export const BITCOIN_CONFIG = process.env.BITCOIN_CONFIG;
export const SERVER_ROOT = process.env.SERVER_ROOT;
export const LOGS_DIR = process.env.LOGS_DIR;
export const DATADIR = process.env.DATADIR || '/data';

export const ROUTER_DB_PATH = process.env.ROUTER_DB_PATH || `${DATADIR}/router.sqlite`;
