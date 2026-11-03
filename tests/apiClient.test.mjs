import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/services/apiClient.js', import.meta.url), 'utf8');
function harness() {
  let sessions = 0;
  const supabase = { auth: { getSession: async () => { sessions++; return { data: { session: { access_token: 'unit-fixture' } }, error: null }; } } };
  const code = source.replace(/^import .*;\r?$/gm, '').replace(/export /g, '')
    .replace('process.env.EXPO_PUBLIC_API_URL', "'https://app.example.test'");
  const client = new Function('supabase', '__DEV__', code + '\nreturn { getAuthHeaders, apiRequest };')(supabase, false);
  return { ...client, sessions: () => sessions };
}
test('SDK auth can use current managed JWT only at the configured application origin', async () => {
  const h = harness();
  assert.deepEqual(await h.getAuthHeaders('https://app.example.test/'), { Authorization: 'Bearer unit-fixture' });
  for (const target of ['https://other.example.test', 'http://app.example.test', 'https://user:secret@app.example.test', 'https://app.example.test?token=anything', 'https://app.example.test#fragment']) {
    await assert.rejects(h.getAuthHeaders(target), { code: 'KYC_MOBILE_GATEWAY_NOT_CONFIGURED' });
  }
  assert.equal(h.sessions(), 1, 'never reads a JWT for an unapproved destination');
});

test('API errors preserve correlation and safe validation field names without exposing values', async t => {
  const requestId = '11111111-1111-4111-8111-111111111111';
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    code: 'INVALID_INPUT', requestId,
    message: ['operationId must be a UUID', 'property restart should not exist', 'Sensitive submitted value', 'operationId must be a UUID'],
  }), { status: 400, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(harness().apiRequest('/api/identity/verification/start', { method: 'POST', json: {} }), error => {
    assert.equal(error.requestId, requestId);
    assert.deepEqual(error.validationFields, ['operationId', 'restart']);
    assert.equal(error.message.includes('Sensitive'), false);
    return error.code === 'INVALID_INPUT' && error.status === 400;
  });
});
