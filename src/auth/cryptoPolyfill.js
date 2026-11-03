import * as Crypto from 'expo-crypto';

if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = {};
}

if (typeof globalThis.crypto.getRandomValues !== 'function') {
  globalThis.crypto.getRandomValues = (array) => Crypto.getRandomValues(array);
}

if (!globalThis.crypto.subtle) {
  globalThis.crypto.subtle = {
    digest: async (algorithm, data) => {
      const name = typeof algorithm === 'string' ? algorithm : algorithm?.name;
      const normalized = (name || 'SHA-256').toUpperCase();
      let algoEnum;
      if (normalized === 'SHA-256' || normalized === 'SHA256') {
        algoEnum = Crypto.CryptoDigestAlgorithm.SHA256;
      } else if (normalized === 'SHA-384' || normalized === 'SHA384') {
        algoEnum = Crypto.CryptoDigestAlgorithm.SHA384;
      } else if (normalized === 'SHA-512' || normalized === 'SHA512') {
        algoEnum = Crypto.CryptoDigestAlgorithm.SHA512;
      } else if (normalized === 'SHA-1' || normalized === 'SHA1') {
        algoEnum = Crypto.CryptoDigestAlgorithm.SHA1;
      } else {
        algoEnum = Crypto.CryptoDigestAlgorithm.SHA256;
      }
      return Crypto.digest(algoEnum, data);
    },
  };
}
