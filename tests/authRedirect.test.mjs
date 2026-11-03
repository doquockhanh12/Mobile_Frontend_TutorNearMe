import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';

const raw = readFileSync(new URL('../src/auth/supabaseClient.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../App.js', import.meta.url), 'utf8');
const demoEmail = 'example@example.test';

function harness() {
  const signupCalls = [];
  const exchanges = [];
  const auth = {
    signUp: async body => {
      signupCalls.push(body);
      return { data: { user: { id: 'fixture-id' }, session: null }, error: null };
    },
    exchangeCodeForSession: async code => {
      exchanges.push(code);
      return { data: { session: { access_token: 'fixture-token' } }, error: null };
    },
    startAutoRefresh() {},
    stopAutoRefresh() {},
  };
  const createClient = () => ({ auth });
  const AppState = { currentState: 'active', addEventListener: () => ({ remove() {} }) };
  const source = raw.replace(/^import[\s\S]*?;\r?$/gm, '').replace(/^export /gm, '');
  const api = new Function('AppState', 'Platform', 'secureSessionStorage', 'createClient', 'process',
    source + '\nreturn { signUpWithEmail, finishEmailConfirmation };')(
      AppState, { OS: 'android' }, {}, createClient,
      { env: { EXPO_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
        EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture' } });
  return { api, signupCalls, exchanges };
}

test('Auth source and App linking handler parse successfully', () => {
  assert.ok(parse(raw, { sourceType: 'module' }));
  assert.ok(parse(app, { sourceType: 'module', plugins: ['jsx'] }));
  assert.match(app, /Linking\.getInitialURL\(\)/);
  assert.match(app, /finishEmailConfirmation\(url\)/);
});

test('signup chooses native callback instead of backend localhost root', async () => {
  const h = harness();
  const result = await h.api.signUpWithEmail(demoEmail, 'sufficient-password');
  assert.equal(result.session, null);
  assert.deepEqual(h.signupCalls[0], {
    email: demoEmail,
    password: 'sufficient-password',
    options: { emailRedirectTo: 'tutornearme://auth/callback' },
  });
});

test('only exact native PKCE callback accepts and exchanges a code once', async () => {
  const h = harness();
  const code = 'examplePKCECode_123456789';
  assert.equal(await h.api.finishEmailConfirmation('https://somewhere.example/callback?code=' + code), false);
  assert.equal(await h.api.finishEmailConfirmation('tutornearme://unknown/callback?code=' + code), false);
  assert.equal(await h.api.finishEmailConfirmation('tutornearme://auth/callback?code=' + code), true);
  assert.equal(await h.api.finishEmailConfirmation('tutornearme://auth/callback?code=' + code), true);
  assert.deepEqual(h.exchanges, [code]);
  await assert.rejects(h.api.finishEmailConfirmation('tutornearme://auth/callback?error_code=access_denied'),
    { message: 'EMAIL_CONFIRMATION_FAILED' });
  await assert.rejects(h.api.finishEmailConfirmation('tutornearme://auth/callback'),
    { message: 'EMAIL_CONFIRMATION_CODE_MISSING' });
});