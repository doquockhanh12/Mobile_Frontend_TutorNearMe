
/**
 * TutorNearMe — Supabase Auth Client
 *
 * Shared authentication identity for Android and iOS.
 *
 * Responsibilities:
 * - Connect to the existing Supabase Auth project.
 * - Persist sessions using native SecureStore.
 * - Restore an existing session after app restart.
 * - Refresh access tokens while the app is active.
 *
 * Business authorization belongs to NestJS.
 * This module must never decide KYC verification status.
 */

import './cryptoPolyfill.js';
import 'react-native-url-polyfill/auto';

import { AppState, Platform } from 'react-native';
import { createClient } from '@supabase/supabase-js';

import {
  secureSessionStorage,
} from './secureSessionStorage.js';

const STORAGE_KEY = 'tnm.auth.session';

// Development-build deep link for Supabase email confirmation. The app scheme is
// declared in app.json. Keep redirect destinations allowlisted on Supabase.
const EMAIL_CONFIRM_REDIRECT = 'tutornearme://auth/callback';
const consumedConfirmationCodes = new Set();

const SUPABASE_URL =
  process.env.EXPO_PUBLIC_SUPABASE_URL;

const SUPABASE_PUBLISHABLE_KEY =
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

/**
 * Validate public client configuration before
 * creating the authentication client.
 *
 * Never embed a Supabase service_role or secret key
 * in a mobile application.
 */
function validateConfiguration() {
  if (
    Platform.OS !== 'android' &&
    Platform.OS !== 'ios'
  ) {
    throw new Error(
      'TutorNearMe mobile authentication requires Android or iOS',
    );
  }

  if (
    typeof SUPABASE_URL !== 'string' ||
    !SUPABASE_URL
  ) {
    throw new Error(
      'Missing EXPO_PUBLIC_SUPABASE_URL',
    );
  }

  if (
    typeof SUPABASE_PUBLISHABLE_KEY !== 'string' ||
    !SUPABASE_PUBLISHABLE_KEY.trim()
  ) {
    throw new Error(
      'Missing EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    );
  }

  let url;

  try {
    url = new URL(SUPABASE_URL);
  } catch {
    throw new Error(
      'Invalid Supabase URL',
    );
  }

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href !== `${url.origin}/`
  ) {
    throw new Error(
      'Supabase URL must be a valid HTTPS origin',
    );
  }

  return {
    url: url.origin,
    publishableKey: SUPABASE_PUBLISHABLE_KEY,
  };
}

const configuration = validateConfiguration();

/**
 * Create a single Supabase client instance.
 *
 * SecureStore persists authentication sessions.
 * No AsyncStorage or plaintext fallback.
 */
export const supabase = createClient(
  configuration.url,
  configuration.publishableKey,
  {
    auth: {
      storage: secureSessionStorage,
      storageKey: STORAGE_KEY,

      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,

      // Supports a future OAuth/deep-link flow.
      flowType: 'pkce',
    },
  },
);

/**
 * Only refresh sessions automatically while
 * the application is in the foreground.
 *
 * A single module-level listener avoids creating
 * duplicate refresh timers on each screen render.
 */
function configureAutoRefresh() {
  const updateRefreshState = (state) => {
    if (state === 'active') {
      supabase.auth.startAutoRefresh();
    } else {
      supabase.auth.stopAutoRefresh();
    }
  };

  updateRefreshState(AppState.currentState);

  return AppState.addEventListener(
    'change',
    updateRefreshState,
  );
}

const appStateSubscription = configureAutoRefresh();

/**
 * Explicit cleanup, useful for tests or
 * controlled application shutdown.
 *
 * Do not call during ordinary screen navigation.
 */
export function disposeSupabaseAuthLifecycle() {
  appStateSubscription.remove();
  supabase.auth.stopAutoRefresh();
}

/**
 * Returns the current Supabase session.
 *
 * This is a client-side session lookup,
 * not an authoritative backend authorization check.
 */
export async function getSupabaseSession() {
  const { data, error } =
    await supabase.auth.getSession();

  if (error) {
    throw error;
  }

  return data.session;
}

/**
 * Sign in through the existing Supabase project.
 */
export async function signInWithEmail(
  email,
  password,
) {
  const { data, error } =
    await supabase.auth.signInWithPassword({
      email,
      password,
    });

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Register an Auth identity using the user's own password on-device.
 * Application Learner role must be separately provisioned by NestJS.
 * A null session means email confirmation is required before sign-in.
 */
export async function signUpWithEmail(email, password) {
  if (typeof email !== 'string' || !email.trim() ||
      typeof password !== 'string' || password.length < 8) {
    throw new Error('INVALID_REGISTRATION_INPUT');
  }
  const { data, error } = await supabase.auth.signUp({
    email: email.trim(),
    password,
    options: { emailRedirectTo: EMAIL_CONFIRM_REDIRECT },
  });
  if (error) throw error;
  return { userCreated: !!data?.user, session: data?.session ?? null };
}

/**
 * Exchange a PKCE authorization code received by the installed Android/iOS
 * development build. A code opened on a different device cannot access the
 * verifier held in this device's SecureStore.
 * Returns false for unrelated app links.
 */
export async function finishEmailConfirmation(url) {
  if (typeof url !== 'string' || url.length > 2048) return false;
  let callback;
  try { callback = new URL(url); } catch { return false; }
  if (callback.protocol !== 'tutornearme:' || callback.hostname !== 'auth'
      || callback.pathname !== '/callback') return false;
  const code = callback.searchParams.get('code');
  const errorCode = callback.searchParams.get('error_code');
  if (errorCode) throw new Error('EMAIL_CONFIRMATION_FAILED');
  if (!code || !/^[A-Za-z0-9_-]{10,256}$/.test(code)) {
    throw new Error('EMAIL_CONFIRMATION_CODE_MISSING');
  }
  if (consumedConfirmationCodes.has(code)) return true;
  consumedConfirmationCodes.add(code);
  try {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw new Error('EMAIL_CONFIRMATION_EXCHANGE_FAILED');
  } catch (error) {
    consumedConfirmationCodes.delete(code);
    throw error;
  }
  return true;
}

/**
 * Sign out from the current Supabase session.
 *
 * scope: 'local' limits sign-out to the current
 * session rather than all of the user's devices.
 */
export async function signOutCurrentDevice() {
  const { error } = await supabase.auth.signOut({
    scope: 'local',
  });

  if (error) {
    throw error;
  }
}

/**
 * Subscribe to authentication state changes.
 *
 * The caller must unsubscribe when no longer needed.
 *
 * Avoid async Supabase Auth calls directly inside
 * the callback to prevent auth-lock reentrancy.
 */
export function subscribeToAuthChanges(callback) {
  if (typeof callback !== 'function') {
    throw new TypeError(
      'Auth state callback must be a function',
    );
  }

  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange(
    (event, session) => {
      callback(event, session);
    },
  );

  return () => {
    subscription.unsubscribe();
  };
}