import sodium from 'libsodium-wrappers';

let ready = null;

export function initCrypto() {
  if (!ready) ready = sodium.ready;
  return ready.then(() => sodium);
}

export function generateClientKeypair() {
  return sodium.crypto_kx_keypair();
}

export function toB64(bytes) {
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
}

export function fromB64(str) {
  return sodium.from_base64(str, sodium.base64_variants.URLSAFE_NO_PADDING);
}

// Client derives its rx/tx keys from its own keypair + the server's public key.
export function deriveClientSessionKeys(clientKeypair, serverPublicKeyB64) {
  const serverPublicKey = fromB64(serverPublicKeyB64);
  const { sharedRx, sharedTx } = sodium.crypto_kx_client_session_keys(
    clientKeypair.publicKey,
    clientKeypair.privateKey,
    serverPublicKey,
  );
  return { rx: sharedRx, tx: sharedTx };
}

export function encrypt(key, plaintextObj) {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const plaintext = sodium.from_string(JSON.stringify(plaintextObj));
  const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, key);
  return { nonce: toB64(nonce), ciphertext: toB64(ciphertext) };
}

export function decrypt(key, frame) {
  const nonce = fromB64(frame.nonce);
  const ciphertext = fromB64(frame.ciphertext);
  const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
  return JSON.parse(sodium.to_string(plaintext));
}
