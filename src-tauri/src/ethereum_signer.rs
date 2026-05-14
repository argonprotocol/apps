use alloy_primitives::Bytes;
use alloy_rlp::{Decodable, RlpDecodable};
use alloy_sol_types::{SolCall, sol};
use anyhow::{Result, ensure};
use bip32::XPrv;
use secp256k1::{Message as Secp256k1Message, Secp256k1, SecretKey};
use std::str::FromStr;

sol! {
    function approve(address spender, uint256 amount);
    function burnForTransfer(address token, uint256 amountBaseUnits, bytes32 argonDestination);
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

pub fn derive_hd_key(mnemonic: &str) -> Result<XPrv> {
    let seed = bip39::Mnemonic::from_str(mnemonic)?.to_seed("");
    let path = bip32::DerivationPath::from_str("m/44'/60'/0'/0/0")?;
    Ok(bip32::XPrv::derive_from_path(seed, &path)?)
}

pub fn sign_personal_message(mnemonic: &str, message: &str) -> Result<String> {
    let hd_key = derive_hd_key(mnemonic)?;
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

    if let Some(existing_policy) = current_policy {
        ensure!(
            existing_policy == &next_policy,
            "Ethereum signer policy is already configured and cannot be overwritten"
        );
        return Ok(());
    }

    *current_policy = Some(next_policy);
    Ok(())
}

pub fn sign_transaction(
    mnemonic: &str,
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
    sign_transaction_bytes(mnemonic, &unsigned_transaction)
}

fn sign_transaction_bytes(
    mnemonic: &str,
    unsigned_transaction: &[u8],
) -> Result<EthereumTransactionSignature> {
    let hd_key = derive_hd_key(mnemonic)?;
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
    if policy.token_addresses.iter().any(|token| token == to) {
        let approve_call = approveCall::abi_decode_validate(data).map_err(|_| {
            anyhow::anyhow!("Ethereum signer only allows approve calls on token contracts")
        })?;

        ensure!(
            approve_call.spender.as_slice() == policy.gateway_address.as_slice(),
            "Ethereum approve spender is not the configured gateway"
        );
        return Ok(());
    }

    if *to == policy.gateway_address {
        let burn_call = burnForTransferCall::abi_decode_validate(data).map_err(|_| {
            anyhow::anyhow!("Ethereum signer only allows burnForTransfer on the gateway contract")
        })?;

        ensure!(
            policy
                .token_addresses
                .iter()
                .any(|allowed| allowed.as_slice() == burn_call.token.as_slice()),
            "Ethereum burnForTransfer token is not allowed"
        );
        ensure!(
            policy
                .allowed_destinations
                .iter()
                .any(|allowed| allowed.as_slice() == burn_call.argonDestination.as_slice()),
            "Ethereum burnForTransfer destination is not one of this wallet's Argon accounts"
        );
        return Ok(());
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
    fn set_policy_rejects_changed_policy() {
        let mut current_policy = None;
        let request = EthereumSignerPolicyRequest {
            chain_id: 1,
            gateway_address: "0x1111111111111111111111111111111111111111".to_string(),
            token_addresses: vec!["0x2222222222222222222222222222222222222222".to_string()],
        };

        set_policy(&mut current_policy, &request, vec![[1u8; 32]]).unwrap();

        let err = set_policy(&mut current_policy, &request, vec![[9u8; 32]]).unwrap_err();
        assert_eq!(
            err.to_string(),
            "Ethereum signer policy is already configured and cannot be overwritten"
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
