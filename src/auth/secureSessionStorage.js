
/**
 * Supabase Auth storage for native Expo (Android / iOS).
 * No AsyncStorage or plaintext filesystem fallback.
 *
 * Uses two encrypted SecureStore banks and commits a small manifest last,
 * so an interrupted token rotation cannot overwrite the last committed bank.
 * This does not itself verify JWT validity; the Supabase server and NestJS do.
 */
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const PREFIX = 'tnm.auth.v1';
const CHUNK_BYTES = 1024;
const MAX_CHUNKS = 64;
const KEY_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;
const STORE_OPTIONS = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  requireAuthentication: false,
};
const queues = new Map();

function assertKey(key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    throw new Error('Invalid secure session storage key');
  }
}

async function ensureNativeStore() {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
    throw new Error('Secure session storage requires Android or iOS');
  }
  if (!(await SecureStore.isAvailableAsync())) {
    throw new Error('Secure session storage is unavailable');
  }
}

function entry(key, suffix) {
  return `${PREFIX}.${key}.${suffix}`;
}

function chunkKey(key, bank, index) {
  return entry(key, `${bank}.${index}`);
}

function splitUtf8(value) {
  const result = [];
  let chunk = '';
  let bytes = 0;
  for (const char of value) {
    const point = char.codePointAt(0);
    const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes + size > CHUNK_BYTES) {
      result.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += char;
    bytes += size;
  }
  result.push(chunk);
  if (result.length > MAX_CHUNKS) {
    throw new Error('Secure session exceeds the storage size limit');
  }
  return result;
}

// Non-cryptographic corruption check, not an authentication primitive.
function checksum(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function parseManifest(raw) {
  if (raw === null) return null;
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new Error('Secure session metadata is corrupted');
  }
  if (manifest?.v !== 1) {
    throw new Error('Unsupported secure session metadata');
  }
  if (manifest.deleted === true) return { deleted: true };
  if (
    !['a', 'b'].includes(manifest.bank) ||
    !Number.isSafeInteger(manifest.count) ||
    manifest.count < 1 ||
    manifest.count > MAX_CHUNKS ||
    !Number.isSafeInteger(manifest.length) ||
    manifest.length < 0 ||
    !/^[0-9a-f]{8}$/.test(manifest.hash)
  ) {
    throw new Error('Secure session metadata is invalid');
  }
  return manifest;
}

function serialized(key, fn) {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(fn);
  queues.set(key, current);
  return current.finally(() => {
    if (queues.get(key) === current) queues.delete(key);
  });
}

async function readManifest(key) {
  return parseManifest(
    await SecureStore.getItemAsync(entry(key, 'manifest'), STORE_OPTIONS),
  );
}

async function deleteBank(key, bank, count) {
  for (let from = 0; from < count; from += 8) {
    const tasks = [];
    for (let i = from; i < Math.min(count, from + 8); i += 1) {
      tasks.push(SecureStore.deleteItemAsync(chunkKey(key, bank, i), STORE_OPTIONS));
    }
    const outcomes = await Promise.allSettled(tasks);
    if (outcomes.some((outcome) => outcome.status === 'rejected')) {
      throw new Error('Could not erase all secure session records');
    }
  }
}

export const secureSessionStorage = {
  async getItem(key) {
    assertKey(key);
    return serialized(key, async () => {
      await ensureNativeStore();
      const manifest = await readManifest(key);
      if (!manifest || manifest.deleted) return null;
      const chunks = [];
      for (let i = 0; i < manifest.count; i += 1) {
        const part = await SecureStore.getItemAsync(
          chunkKey(key, manifest.bank, i), STORE_OPTIONS,
        );
        if (part === null) {
          throw new Error('Secure session is incomplete; sign in again');
        }
        chunks.push(part);
      }
      const value = chunks.join('');
      if (value.length !== manifest.length || checksum(value) !== manifest.hash) {
        throw new Error('Secure session integrity check failed');
      }
      return value;
    });
  },

  async setItem(key, value) {
    assertKey(key);
    if (typeof value !== 'string') {
      throw new TypeError('Secure session value must be a string');
    }
    const chunks = splitUtf8(value);
    return serialized(key, async () => {
      await ensureNativeStore();
      const previous = await readManifest(key);
      const nextBank = previous && !previous.deleted && previous.bank === 'a' ? 'b' : 'a';

      // Write into the inactive bank only. Until manifest commit succeeds,
      // the previous session remains readable after an interrupted write.
      for (let i = 0; i < chunks.length; i += 1) {
        await SecureStore.setItemAsync(
          chunkKey(key, nextBank, i), chunks[i], STORE_OPTIONS,
        );
      }
      await SecureStore.setItemAsync(
        entry(key, 'manifest'),
        JSON.stringify({
          v: 1,
          bank: nextBank,
          count: chunks.length,
          length: value.length,
          hash: checksum(value),
        }),
        STORE_OPTIONS,
      );

      // Cleanup is best-effort *after* commit. A failed cleanup must not
      // turn a successful refresh-token rotation into a client-side failure.
      if (previous && !previous.deleted) {
        try {
          await deleteBank(key, previous.bank, previous.count);
        } catch {
          // Logout removes all possible chunks in both banks.
        }
      }
    });
  },

  async removeItem(key) {
    assertKey(key);
    return serialized(key, async () => {
      await ensureNativeStore();
      // Commit deletion before cleanup; crash recovery never restores a
      // stale session merely because a chunk still exists.
      await SecureStore.setItemAsync(
        entry(key, 'manifest'),
        JSON.stringify({ v: 1, deleted: true }),
        STORE_OPTIONS,
      );
      await deleteBank(key, 'a', MAX_CHUNKS);
      await deleteBank(key, 'b', MAX_CHUNKS);
      await SecureStore.deleteItemAsync(entry(key, 'manifest'), STORE_OPTIONS);
    });
  },
};
