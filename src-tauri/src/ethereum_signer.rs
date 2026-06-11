use alloy_primitives::{Address, Bytes, U256};
use alloy_rlp::{Decodable, RlpDecodable};
use alloy_sol_types::{Eip712Domain, SolCall, SolStruct, sol};
use anyhow::{Result, ensure};
use bip32::XPrv;
use secp256k1::{Message as Secp256k1Message, Secp256k1, SecretKey};
use std::str::FromStr;

const ETHEREUM_HD_PATH_PREFIX: &str = "m/44'/60'/";

sol! {
    function startTransferToArgon(address token, uint128 amount, bytes32 argonAccountId, uint256 deadline, uint8 v, bytes32 r, bytes32 s);
    struct CouncilSnapshot {
        address[] signers;
        uint256[] weights;
    }
    struct GatewayUpdate {
        uint64 queueNonce;
        uint8 kind;
        bytes payload;
        bytes[] signatures;
    }
    function applyGatewayUpdates(CouncilSnapshot currentCouncil, GatewayUpdate[] updates, bytes32 relayerArgonAccountId);
    struct TransferOutOfArgonRequest {
        bytes32 argonAccountId;
        uint64 argonTransferNonce;
        uint64 chainId;
        uint128 microgonsPerArgonot;
        address recipient;
        uint64 validUntilBlock;
        address token;
        uint128 amount;
        uint128 mintingAuthorityTip;
    }
    struct MintingAuthorization {
        uint128 microgonCollateral;
        uint128 micronotCollateral;
        bytes signature;
    }
    struct TransferOutOfArgonProof {
        MintingAuthorization[] authorizations;
    }
    function finalizeTransferOutOfArgon(TransferOutOfArgonRequest request, TransferOutOfArgonProof proof);
    struct Permit {
        address owner;
        address spender;
        uint256 value;
        uint256 nonce;
        uint256 deadline;
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EthereumSignerPolicyRequest {
    pub chain_id: u64,
    pub gateway_address: String,
    pub token_addresses: Vec<String>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct EthereumSignerPolicy {
    pub chain_id: u64,
    pub gateway_address: [u8; 20],
    pub token_addresses: Vec<[u8; 20]>,
    pub allowed_destinations: Vec<[u8; 32]>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EthereumTransactionRequest {
    pub unsigned_transaction: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EthereumTransactionSignature {
    pub y_parity: u8,
    pub r: String,
    pub s: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EthereumPermitRequest {
    pub token_address: String,
    pub token_name: String,
    pub value: String,
    pub nonce: String,
    pub deadline: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EthereumPermitSignature {
    pub v: u8,
    pub r: String,
    pub s: String,
}

pub fn derive_address_at_path(mnemonic: &str, hd_path: &str) -> Result<String> {
    derive_ethereum_address_from_hd_key(derive_hd_key_with_path(mnemonic, hd_path)?)
}

pub fn export_private_key_at_path(mnemonic: &str, hd_path: &str) -> Result<String> {
    let hd_key = derive_hd_key_with_path(mnemonic, hd_path)?;
    Ok(format!(
        "0x{}",
        hex::encode(hd_key.private_key().to_bytes())
    ))
}

pub fn derive_addresses(mnemonic: &str, hd_paths: &[String]) -> Result<Vec<String>> {
    ensure!(
        hd_paths.len() <= 64,
        "Ethereum address derivations are limited to 64 paths at a time"
    );

    hd_paths
        .iter()
        .map(|hd_path| derive_address_at_path(mnemonic, hd_path))
        .collect()
}

fn derive_hd_key_with_path(mnemonic: &str, path: &str) -> Result<XPrv> {
    ensure!(
        path.starts_with(ETHEREUM_HD_PATH_PREFIX),
        "Ethereum derivations must use an m/44'/60'/... path"
    );

    let suffix = &path[ETHEREUM_HD_PATH_PREFIX.len()..];
    ensure!(
        !suffix.is_empty() && suffix.split('/').all(|part| part.ends_with('\'')),
        "Ethereum custom derivations must use hardened segments after m/44'/60'/"
    );

    let seed = bip39::Mnemonic::from_str(mnemonic)?.to_seed("");
    let path = bip32::DerivationPath::from_str(path)?;
    Ok(bip32::XPrv::derive_from_path(seed, &path)?)
}

pub fn sign_personal_message_at_path(
    mnemonic: &str,
    hd_path: &str,
    message: &str,
) -> Result<String> {
    sign_personal_message_with_hd_key(derive_hd_key_with_path(mnemonic, hd_path)?, message)
}

fn sign_personal_message_with_hd_key(hd_key: XPrv, message: &str) -> Result<String> {
    let secret_key = SecretKey::from_slice(&hd_key.private_key().to_bytes())?;
    let message_bytes = decode_ethereum_message(message)?;
    let digest = ethereum_personal_message_digest(&message_bytes);
    let signature = Secp256k1::new()
        .sign_ecdsa_recoverable(&Secp256k1Message::from_digest(digest), &secret_key);
    let (recovery_id, compact) = signature.serialize_compact();

    let mut signature_bytes = [0u8; 65];
    signature_bytes[..64].copy_from_slice(&compact);
    signature_bytes[64] = recovery_id.to_i32() as u8 + 27;

    Ok(format!("0x{}", hex::encode(signature_bytes)))
}

pub fn sign_permit(
    mnemonic: &str,
    hd_path: &str,
    policy: &EthereumSignerPolicy,
    request: &EthereumPermitRequest,
) -> Result<EthereumPermitSignature> {
    let token_address = parse_ethereum_address(&request.token_address)?;
    ensure!(
        policy
            .token_addresses
            .iter()
            .any(|allowed| allowed == &token_address),
        "Ethereum permit token is not allowed"
    );

    let value = parse_u256(&request.value)?;
    let nonce = parse_u256(&request.nonce)?;
    let deadline = parse_u256(&request.deadline)?;
    let domain = Eip712Domain::new(
        Some(request.token_name.clone().into()),
        Some("1".into()),
        Some(U256::from(policy.chain_id)),
        Some(Address::from(token_address)),
        None,
    );
    let permit = Permit {
        owner: Address::from(derive_ethereum_address_bytes(mnemonic, hd_path)?),
        spender: Address::from(policy.gateway_address),
        value,
        nonce,
        deadline,
    };
    let signature = sign_digest(
        mnemonic,
        hd_path,
        permit.eip712_signing_hash(&domain).into(),
    )?;

    Ok(EthereumPermitSignature {
        v: signature.0,
        r: signature.1,
        s: signature.2,
    })
}

pub fn set_policy(
    current_policy: &mut Option<EthereumSignerPolicy>,
    request: &EthereumSignerPolicyRequest,
    allowed_destinations: Vec<[u8; 32]>,
) -> Result<()> {
    let mut token_addresses = request
        .token_addresses
        .iter()
        .map(|address| parse_ethereum_address(address))
        .collect::<Result<Vec<_>>>()?;
    token_addresses.sort_unstable();
    token_addresses.dedup();

    let mut allowed_destinations = allowed_destinations;
    allowed_destinations.sort_unstable();
    allowed_destinations.dedup();

    let next_policy = EthereumSignerPolicy {
        chain_id: request.chain_id,
        gateway_address: parse_ethereum_address(&request.gateway_address)?,
        token_addresses,
        allowed_destinations,
    };

    *current_policy = Some(next_policy);
    Ok(())
}

pub fn sign_transaction(
    mnemonic: &str,
    hd_path: &str,
    policy: &EthereumSignerPolicy,
    request: &EthereumTransactionRequest,
) -> Result<EthereumTransactionSignature> {
    let unsigned_transaction = decode_hex(&request.unsigned_transaction)?;
    let parsed_transaction = parse_unsigned_eip1559_transaction(&unsigned_transaction)?;
    ensure!(
        parsed_transaction.chain_id == policy.chain_id,
        "Ethereum transaction chain ID does not match the configured signer policy"
    );
    validate_ethereum_call(policy, &parsed_transaction.to, &parsed_transaction.data)?;
    sign_transaction_bytes(mnemonic, hd_path, &unsigned_transaction)
}

fn sign_transaction_bytes(
    mnemonic: &str,
    hd_path: &str,
    unsigned_transaction: &[u8],
) -> Result<EthereumTransactionSignature> {
    let hd_key = derive_hd_key_with_path(mnemonic, hd_path)?;
    let secret_key = SecretKey::from_slice(&hd_key.private_key().to_bytes())?;
    let digest = sp_core::hashing::keccak_256(unsigned_transaction);
    let signature = Secp256k1::new()
        .sign_ecdsa_recoverable(&Secp256k1Message::from_digest(digest), &secret_key);
    let (recovery_id, compact) = signature.serialize_compact();

    Ok(EthereumTransactionSignature {
        y_parity: recovery_id.to_i32() as u8,
        r: format!("0x{}", hex::encode(&compact[..32])),
        s: format!("0x{}", hex::encode(&compact[32..])),
    })
}

fn validate_ethereum_call(policy: &EthereumSignerPolicy, to: &[u8; 20], data: &[u8]) -> Result<()> {
    if *to == policy.gateway_address {
        if let Ok(transfer_call) = startTransferToArgonCall::abi_decode_validate(data) {
            ensure!(
                policy
                    .token_addresses
                    .iter()
                    .any(|allowed| allowed.as_slice() == transfer_call.token.as_slice()),
                "Ethereum startTransferToArgon token is not allowed"
            );
            ensure!(
                policy
                    .allowed_destinations
                    .iter()
                    .any(|allowed| allowed.as_slice() == transfer_call.argonAccountId.as_slice()),
                "Ethereum startTransferToArgon destination is not one of this wallet's Argon accounts"
            );
            return Ok(());
        }

        if let Ok(update_call) = applyGatewayUpdatesCall::abi_decode_validate(data) {
            ensure!(
                policy
                    .allowed_destinations
                    .iter()
                    .any(|allowed| allowed.as_slice()
                        == update_call.relayerArgonAccountId.as_slice()),
                "Ethereum applyGatewayUpdates relayer is not one of this wallet's Argon accounts"
            );
            return Ok(());
        }

        if let Ok(finalize_call) = finalizeTransferOutOfArgonCall::abi_decode_validate(data) {
            ensure!(
                policy
                    .token_addresses
                    .iter()
                    .any(|allowed| allowed.as_slice() == finalize_call.request.token.as_slice()),
                "Ethereum finalizeTransferOutOfArgon token is not allowed"
            );
            return Ok(());
        }

        anyhow::bail!(
            "Ethereum signer only allows startTransferToArgon, applyGatewayUpdates, or finalizeTransferOutOfArgon on the gateway contract"
        );
    }

    anyhow::bail!("Ethereum signer does not allow this contract address")
}

struct ParsedUnsignedTransaction {
    chain_id: u64,
    to: [u8; 20],
    data: Vec<u8>,
}

#[derive(RlpDecodable)]
struct DecodedUnsignedTransaction {
    chain_id: u64,
    _nonce: Bytes,
    _max_priority_fee_per_gas: Bytes,
    _max_fee_per_gas: Bytes,
    _gas: Bytes,
    to: Bytes,
    value: Bytes,
    data: Bytes,
    access_list: Vec<DecodedAccessListItem>,
}

#[derive(RlpDecodable)]
struct DecodedAccessListItem {
    _address: Bytes,
    _storage_keys: Vec<Bytes>,
}

fn parse_unsigned_eip1559_transaction(
    unsigned_transaction: &[u8],
) -> Result<ParsedUnsignedTransaction> {
    ensure!(
        unsigned_transaction.first() == Some(&0x02),
        "Ethereum signer only supports unsigned EIP-1559 transactions"
    );

    let mut payload = &unsigned_transaction[1..];
    let decoded = DecodedUnsignedTransaction::decode(&mut payload)
        .map_err(|_| anyhow::anyhow!("Unsigned Ethereum transaction could not be decoded"))?;

    ensure!(
        payload.is_empty(),
        "Unsigned Ethereum transaction had trailing bytes"
    );
    ensure!(
        decoded.to.len() == 20,
        "Ethereum transaction destination must be 20 bytes"
    );
    ensure!(
        decoded.value.iter().all(|byte| *byte == 0),
        "Ethereum signer only allows zero-value contract calls"
    );
    ensure!(
        decoded.access_list.is_empty(),
        "Ethereum signer only allows empty access lists"
    );

    let mut to_bytes = [0u8; 20];
    to_bytes.copy_from_slice(decoded.to.as_ref());

    Ok(ParsedUnsignedTransaction {
        chain_id: decoded.chain_id,
        to: to_bytes,
        data: decoded.data.to_vec(),
    })
}

fn parse_ethereum_address(value: &str) -> Result<[u8; 20]> {
    let bytes = decode_hex(value)?;
    ensure!(bytes.len() == 20, "Ethereum address must be 20 bytes");
    let mut address = [0u8; 20];
    address.copy_from_slice(&bytes);
    Ok(address)
}

fn decode_hex(value: &str) -> Result<Vec<u8>> {
    let trimmed = value.trim();
    let hex_value = trimmed.strip_prefix("0x").unwrap_or(trimmed);
    Ok(hex::decode(hex_value)?)
}

fn decode_ethereum_message(message: &str) -> Result<Vec<u8>> {
    let trimmed = message.trim();
    if let Some(hex_value) = trimmed.strip_prefix("0x") {
        return Ok(hex::decode(hex_value)?);
    }

    Ok(trimmed.as_bytes().to_vec())
}

fn ethereum_personal_message_digest(message: &[u8]) -> [u8; 32] {
    let prefix = format!("\x19Ethereum Signed Message:\n{}", message.len());
    let mut payload = prefix.into_bytes();
    payload.extend_from_slice(message);
    sp_core::hashing::keccak_256(&payload)
}

fn parse_u256(value: &str) -> Result<U256> {
    Ok(U256::from_str(value.trim())?)
}

fn derive_ethereum_address_bytes(mnemonic: &str, hd_path: &str) -> Result<[u8; 20]> {
    derive_ethereum_address_bytes_from_hd_key(derive_hd_key_with_path(mnemonic, hd_path)?)
}

fn derive_ethereum_address_bytes_from_hd_key(hd_key: XPrv) -> Result<[u8; 20]> {
    let public_key = hd_key.private_key().verifying_key();
    let encoded = public_key.to_encoded_point(false);
    let public_key_bytes = encoded.as_bytes();
    let hash = sp_core::hashing::keccak_256(&public_key_bytes[1..]);
    let mut address = [0u8; 20];
    address.copy_from_slice(&hash[12..]);
    Ok(address)
}

fn derive_ethereum_address_from_hd_key(hd_key: XPrv) -> Result<String> {
    let address = derive_ethereum_address_bytes_from_hd_key(hd_key)?;
    Ok(to_checksummed_ethereum_address(&address))
}

fn to_checksummed_ethereum_address(address_bytes: &[u8]) -> String {
    let address_hex = hex::encode(address_bytes);
    let hash_hex = hex::encode(sp_core::hashing::keccak_256(address_hex.as_bytes()));
    let mut checksummed = String::with_capacity(42);
    checksummed.push_str("0x");

    for (address_char, hash_char) in address_hex.chars().zip(hash_hex.chars()) {
        if address_char.is_ascii_digit() {
            checksummed.push(address_char);
            continue;
        }

        let nibble = hash_char.to_digit(16).unwrap_or_default();
        if nibble >= 8 {
            checksummed.push(address_char.to_ascii_uppercase());
        } else {
            checksummed.push(address_char);
        }
    }

    checksummed
}

fn sign_digest(mnemonic: &str, hd_path: &str, digest: [u8; 32]) -> Result<(u8, String, String)> {
    let hd_key = derive_hd_key_with_path(mnemonic, hd_path)?;
    let secret_key = SecretKey::from_slice(&hd_key.private_key().to_bytes())?;
    let signature = Secp256k1::new()
        .sign_ecdsa_recoverable(&Secp256k1Message::from_digest(digest), &secret_key);
    let (recovery_id, compact) = signature.serialize_compact();

    Ok((
        recovery_id.to_i32() as u8 + 27,
        format!("0x{}", hex::encode(&compact[..32])),
        format!("0x{}", hex::encode(&compact[32..])),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_policy_allows_reordered_lists() {
        let mut current_policy = None;
        let first_request = EthereumSignerPolicyRequest {
            chain_id: 1,
            gateway_address: "0x1111111111111111111111111111111111111111".to_string(),
            token_addresses: vec![
                "0x2222222222222222222222222222222222222222".to_string(),
                "0x3333333333333333333333333333333333333333".to_string(),
            ],
        };

        set_policy(
            &mut current_policy,
            &first_request,
            vec![[2u8; 32], [1u8; 32], [2u8; 32]],
        )
        .unwrap();

        let reordered_request = EthereumSignerPolicyRequest {
            chain_id: 1,
            gateway_address: "0x1111111111111111111111111111111111111111".to_string(),
            token_addresses: vec![
                "0x3333333333333333333333333333333333333333".to_string(),
                "0x2222222222222222222222222222222222222222".to_string(),
                "0x2222222222222222222222222222222222222222".to_string(),
            ],
        };

        set_policy(
            &mut current_policy,
            &reordered_request,
            vec![[1u8; 32], [2u8; 32]],
        )
        .unwrap();
    }

    #[test]
    fn set_policy_overwrites_changed_policy() {
        let mut current_policy = None;
        let request = EthereumSignerPolicyRequest {
            chain_id: 1,
            gateway_address: "0x1111111111111111111111111111111111111111".to_string(),
            token_addresses: vec!["0x2222222222222222222222222222222222222222".to_string()],
        };

        set_policy(&mut current_policy, &request, vec![[1u8; 32]]).unwrap();
        set_policy(&mut current_policy, &request, vec![[9u8; 32]]).unwrap();

        assert_eq!(
            current_policy.unwrap().allowed_destinations,
            vec![[9u8; 32]]
        );
    }

    #[test]
    fn validate_apply_gateway_updates_allows_known_relayer() {
        let policy = EthereumSignerPolicy {
            chain_id: 1,
            gateway_address: [0x11; 20],
            token_addresses: vec![],
            allowed_destinations: vec![[0x22; 32]],
        };
        let call = applyGatewayUpdatesCall {
            currentCouncil: CouncilSnapshot {
                signers: vec![],
                weights: vec![],
            },
            updates: vec![],
            relayerArgonAccountId: [0x22; 32].into(),
        };

        validate_ethereum_call(&policy, &policy.gateway_address, &call.abi_encode())
            .expect("known relayer should be allowed");
    }

    #[test]
    fn validate_apply_gateway_updates_rejects_unknown_relayer() {
        let policy = EthereumSignerPolicy {
            chain_id: 1,
            gateway_address: [0x11; 20],
            token_addresses: vec![],
            allowed_destinations: vec![[0x22; 32]],
        };
        let call = applyGatewayUpdatesCall {
            currentCouncil: CouncilSnapshot {
                signers: vec![],
                weights: vec![],
            },
            updates: vec![],
            relayerArgonAccountId: [0x33; 32].into(),
        };

        let err = validate_ethereum_call(&policy, &policy.gateway_address, &call.abi_encode())
            .expect_err("unknown relayer should be rejected");

        assert_eq!(
            err.to_string(),
            "Ethereum applyGatewayUpdates relayer is not one of this wallet's Argon accounts"
        );
    }

    #[test]
    fn validate_finalize_transfer_out_allows_known_token() {
        let policy = EthereumSignerPolicy {
            chain_id: 1,
            gateway_address: [0x11; 20],
            token_addresses: vec![[0x44; 20]],
            allowed_destinations: vec![],
        };
        let call = finalizeTransferOutOfArgonCall {
            request: TransferOutOfArgonRequest {
                argonAccountId: [0x22; 32].into(),
                argonTransferNonce: 1,
                chainId: 1,
                microgonsPerArgonot: 7,
                recipient: Address::from([0x55; 20]),
                validUntilBlock: 10,
                token: Address::from([0x44; 20]),
                amount: 25,
                mintingAuthorityTip: 1,
            },
            proof: TransferOutOfArgonProof {
                authorizations: vec![],
            },
        };

        validate_ethereum_call(&policy, &policy.gateway_address, &call.abi_encode())
            .expect("known finalize token should be allowed");
    }

    #[test]
    fn validate_finalize_transfer_out_allows_current_viem_calldata() {
        let policy = EthereumSignerPolicy {
            chain_id: 1,
            gateway_address: [0x11; 20],
            token_addresses: vec![[0x44; 20]],
            allowed_destinations: vec![],
        };
        let calldata = finalizeTransferOutOfArgonCall {
            request: TransferOutOfArgonRequest {
                argonAccountId: [0x22; 32].into(),
                argonTransferNonce: 1,
                chainId: 1,
                microgonsPerArgonot: 7,
                recipient: Address::from([0x55; 20]),
                validUntilBlock: 10,
                token: Address::from([0x44; 20]),
                amount: 25,
                mintingAuthorityTip: 1,
            },
            proof: TransferOutOfArgonProof {
                authorizations: vec![MintingAuthorization {
                    microgonCollateral: 16,
                    micronotCollateral: 0,
                    signature: Bytes::from(vec![0x33; 65]),
                }],
            },
        }
        .abi_encode();

        assert_eq!(
            format!("0x{}", hex::encode(&calldata)),
            "0x138f878122222222222222222222222222222222222222222222222222222222222222220000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000070000000000000000000000005555555555555555555555555555555555555555000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000044444444444444444444444444444444444444440000000000000000000000000000000000000000000000000000000000000019000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000001400000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000041333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333300000000000000000000000000000000000000000000000000000000000000"
        );

        validate_ethereum_call(&policy, &policy.gateway_address, &calldata)
            .expect("current viem finalize calldata should be allowed");
    }

    #[test]
    fn minting_authority_addresses_use_a_separate_derivation_lane() {
        let mnemonic = "test test test test test test test test test test test junk";

        let primary_address = to_checksummed_ethereum_address(
            &derive_ethereum_address_bytes(mnemonic, "m/44'/60'/0'/0'/0'")
                .expect("primary address should derive"),
        );
        let council_address = derive_address_at_path(mnemonic, "m/44'/60'/1'/0'/0'")
            .expect("council address should derive");
        let first_authority_address = derive_address_at_path(mnemonic, "m/44'/60'/2'/0'/0'")
            .expect("authority address should derive");
        let second_authority_address = derive_address_at_path(mnemonic, "m/44'/60'/2'/0'/1'")
            .expect("authority address should derive");

        assert_ne!(primary_address, council_address);
        assert_ne!(council_address, first_authority_address);
        assert_ne!(primary_address, first_authority_address);
        assert_ne!(first_authority_address, second_authority_address);
    }

    #[test]
    fn rejects_unhardened_custom_ethereum_paths() {
        let mnemonic = "test test test test test test test test test test test junk";

        let error = derive_address_at_path(mnemonic, "m/44'/60'/0'/1/0")
            .expect_err("unhardened custom path should fail");

        assert!(
            error
                .to_string()
                .contains("Ethereum custom derivations must use hardened segments"),
        );
    }

    #[test]
    fn parses_viem_unsigned_eip1559_approve_transaction() {
        let unsigned_transaction = decode_hex(
            "0x02f8678330282480010982db70949fe46736679d2d9a65f0992f2272de9f3c7fa6e080b844095ea7b3000000000000000000000000e7f1725e7734ce288f8367e1bb143e90eeb172480000000000000000000000000000000000000000000000000000000000000001c0",
        )
        .unwrap();

        let parsed = parse_unsigned_eip1559_transaction(&unsigned_transaction).unwrap();

        assert_eq!(parsed.chain_id, 3_156_004);
        assert_eq!(
            parsed.to,
            parse_ethereum_address("0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0").unwrap()
        );
        assert_eq!(
            parsed.data,
            decode_hex(
                "0x095ea7b3000000000000000000000000e7f1725e7734ce288f8367e1bb143e90eeb172480000000000000000000000000000000000000000000000000000000000000001",
            )
            .unwrap()
        );
    }
}
