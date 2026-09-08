import { createRequire } from 'node:module';

// libsodium-wrappers' published ESM build has a broken relative import
// (dist/modules-esm/libsodium-wrappers.mjs references a sibling file that
// isn't actually shipped there), so we load the CJS build directly instead.
const require = createRequire(import.meta.url);
const sodiumWrapper = require('libsodium-wrappers');

let sodium = null;

export async function initCrypto() {
  await sodiumWrapper.ready;
  sodium = sodiumWrapper;
  return sodium;
}

export function generateServerKeypair() {
  return sodium.crypto_kx_keypair();
}

export function generatePairingToken() {
  return sodium.to_base64(
    sodium.randombytes_buf(24),
    sodium.base64_variants.URLSAFE_NO_PADDING,
  );
}

// Server derives its rx/tx keys from its own keypair + the client's public key.
export function deriveServerSessionKeys(serverKeypair, clientPublicKeyB64) {
  const clientPublicKey = sodium.from_base64(
    clientPublicKeyB64,
    sodium.base64_variants.URLSAFE_NO_PADDING,
  );
  const { sharedRx, sharedTx } = sodium.crypto_kx_server_session_keys(
    serverKeypair.publicKey,
    serverKeypair.privateKey,
    clientPublicKey,
  );
  // sharedRx: key for decrypting messages FROM the client
  // sharedTx: key for encrypting messages TO the client
  return { rx: sharedRx, tx: sharedTx };
}

export function encrypt(key, plaintextObj) {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const plaintext = sodium.from_string(JSON.stringify(plaintextObj));
  const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, key);
  return {
    nonce: sodium.to_base64(nonce, sodium.base64_variants.URLSAFE_NO_PADDING),
    ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING),
  };
}

export function decrypt(key, frame) {
  const nonce = sodium.from_base64(frame.nonce, sodium.base64_variants.URLSAFE_NO_PADDING);
  const ciphertext = sodium.from_base64(frame.ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING);
  const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
  return JSON.parse(sodium.to_string(plaintext));
}

export function publicKeyToB64(keypair) {
  return sodium.to_base64(keypair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
}
