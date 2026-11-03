import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import { verificationState } from '../src/domain/kyc.js';

const source = readFileSync(new URL('../src/services/provider.js', import.meta.url), 'utf8');
const verificationId = '12345678-1234-4234-8234-123456789abc';
const challengeNonce = '22345678-1234-4234-8234-123456789abc';
const docTransactionId = '32345678-1234-4234-8234-123456789abc';
const faceTransactionId = '42345678-1234-4234-8234-123456789abc';
const setup = { verificationId, challengeNonce, serviceUrl: 'https://upload.example.test', grantExpiresAt: new Date(Date.now() + 300000).toISOString(), httpHeaders: { 'X-Kyc-Verification-Id': verificationId, Authorization: 'Bearer scoped-upload-grant' } };

function harness({ failFinalizeOnce = false } = {}) {
  const calls = [];
  let starts = 0, finalize = 0, liveness = 0, reset = 0, operation = 0, scans = 0;
  let images = { front: null, back: null };
  const api = {
    get: async path => { calls.push([path]); return path.endsWith('/challenge') ? { verificationId, challengeNonce } : { status: 'unverified', session: { status: 'in_progress' } }; },
    post: async (path, body) => {
      calls.push([path, body]);
      if (path.endsWith('/verification/start')) { starts++; return { verificationId }; }
      if (path.endsWith('/nfc/start')) return { verificationId, challenge: '1122334455667788' };
      if (path.endsWith('/nfc/complete')) return { verificationId, completed: true, checks: { pa: 'passed', aa: 'unverified', ca: 'unverified' } };
      if (path.endsWith('/start')) return setup;
      if (path.endsWith('/submit-provider')) return { status: 'pending_review' };
      return { verificationId, completed: true };
    },
  };
  const dependencies = {
    Crypto: { randomUUID: () => '52345678-1234-4234-8234-' + String(++operation).padStart(12, '0') }, api, verificationState,
    getAuthHeaders: async () => ({ Authorization: 'Bearer fixture' }),
    initializeRegulaDocument: async () => {}, scanDocumentWithRegula: async ({ nextPage }) => { scans++; images[nextPage ? 'back' : 'front'] = 'preview'; }, readNfcWithRegula: async () => {},
    getLastRfidPortrait: () => null, getLastDocImages: () => ({ ...images }),
    getNfcEvidence: () => ({ sod: 'b3BhcXVl', dataGroups: [{ number: 1, data: 'b3BhcXVl' }, { number: 2, data: 'b3BhcXVl' }] }),
    configureRegulaServerSideVerification: async config => { assert.equal(config.httpHeaders.Authorization, 'Bearer scoped-upload-grant'); assert.equal(config.httpHeaders['X-Kyc-Verification-Id'], verificationId); },
    refreshRegulaDocumentUploadGrant: async config => { calls.push(['sdk/refresh-grant', config]); },
    finalizeRegulaDocumentPackage: async () => { finalize++; if (failFinalizeOnce) { failFinalizeOnce = false; throw new Error('SDK finalization failure'); } return { transactionId: docTransactionId }; },
    resetRegulaDocumentSession: () => { reset++; images = { front: null, back: null }; }, initializeRegulaFace: async () => {},
    startRegulaLiveness: async config => { liveness++; assert.equal(config.verificationId, verificationId); return { transactionId: faceTransactionId }; },
    resetRegulaFaceSession: () => {},
  };
  const code = source.replace(/^import[\s\S]*?;\r?$/gm, '').replace(/export /g, '');
  const provider = new Function(...Object.keys(dependencies), code + '\nreturn provider;')(...Object.values(dependencies));
  return { provider, api, calls, counts: () => ({ starts, finalize, liveness, reset, scans }) };
}
async function scanBoth(h) {
  await h.provider.inspectDocumentPhoto({ side: 'front' });
  await h.provider.inspectDocumentPhoto({ side: 'back' });
}

test('finalization failure retries the existing front/back package without another scan or start operation', async () => {
  const h = harness({ failFinalizeOnce: true });
  await h.provider.inspectDocumentPhoto({ side: 'front' });
  await assert.rejects(h.provider.inspectDocumentPhoto({ side: 'back' }), /SDK finalization failure/);
  const result = await h.provider.inspectDocumentPhoto({ side: 'back' });
  assert.equal(result.captured, true);
  assert.equal(h.counts().scans, 2);
  assert.equal(h.counts().starts, 1);
  assert.equal(h.counts().finalize, 2);
});

test('front capture alone cannot skip the back and optical-server verification stages', async () => {
  const h = harness(); await h.provider.inspectDocumentPhoto({ side: 'front' });
  await assert.rejects(h.provider.readAndAuthenticateNfc(), { code: 'DOCUMENT_SERVER_SESSION_REQUIRED' });
  assert.equal(h.calls.filter(([path]) => path.endsWith('/nfc/start')).length, 0);
});

test('mobile flow forwards raw NFC proof separately, never client verification flags or scores', async () => {
  for (const file of ['App.js', 'src/services/provider.js', 'src/services/apiClient.js']) {
    assert.ok(parse(readFileSync(new URL('../' + file, import.meta.url), 'utf8'), { sourceType: 'module', plugins: ['jsx'] }));
  }
  const h = harness();
  assert.equal((await h.provider.inspectDocumentPhoto({ side: 'front' })).verified, false);
  await h.provider.inspectDocumentPhoto({ side: 'back' });
  assert.equal((await h.provider.readAndAuthenticateNfc()).verified, false);
  await h.provider.checkLivenessAndMatch({ consentAcknowledged: true });
  assert.equal((await h.provider.submitToBackend()).status, 'pending_review');
  const submitted = h.calls.find(([path]) => path.endsWith('/submit-provider'))[1];
  assert.deepEqual(submitted, { verificationId, docTransactionId, faceTransactionId });
  assert.deepEqual(h.calls.filter(([path]) => path.endsWith('/complete')).map(([path]) => path), [
    '/api/identity/verification/document/complete', '/api/identity/verification/nfc/complete', '/api/identity/verification/face/complete',
  ]);
  const chip = h.calls.find(([path]) => path.endsWith('/nfc/complete'))[1];
  assert.equal(chip.challenge, '1122334455667788'); assert.ok(chip.operationId);
  assert.equal(chip.pa, undefined); assert.equal(chip.verified, undefined); assert.equal(chip.activeAuthentication, undefined);
});

test('lost start response retries the same operation; lost document completion keeps transaction', async () => {
  const h = harness(); const post = h.api.post; let failStart = true, failDocument = true;
  h.api.post = async (path, body) => {
    if (path.endsWith('/verification/start') && failStart) { failStart = false; h.calls.push([path, body]); throw new Error('timeout'); }
    if (path.endsWith('/document/complete') && failDocument) { failDocument = false; throw new Error('timeout'); }
    return post(path, body);
  };
  await assert.rejects(h.provider.inspectDocumentPhoto({ side: 'front' }));
  await h.provider.inspectDocumentPhoto({ side: 'front' });
  const starts = h.calls.filter(([path]) => path.endsWith('/verification/start'));
  assert.equal(starts[0][1].operationId, starts[1][1].operationId);
  await assert.rejects(h.provider.inspectDocumentPhoto({ side: 'back' }));
  await h.provider.inspectDocumentPhoto({ side: 'back' });
  await h.provider.readAndAuthenticateNfc();
  assert.equal(h.counts().finalize, 1);
});

test('missing gateway, altered challenge, consent bypass and early submit fail closed', async () => {
  const h = harness();
  await assert.rejects(h.provider.submitToBackend(), { code: 'KYC_PROVIDER_EVIDENCE_REQUIRED' });
  const post = h.api.post;
  h.api.post = async (path, body) => path.endsWith('/document/start') ? { ...setup, serviceUrl: undefined } : post(path, body);
  await assert.rejects(h.provider.inspectDocumentPhoto({ side: 'front' }), { code: 'KYC_MOBILE_GATEWAY_NOT_CONFIGURED' });
  h.api.post = post;
  await scanBoth(h);
  await h.provider.readAndAuthenticateNfc();
  await assert.rejects(h.provider.checkLivenessAndMatch({ consentAcknowledged: 'true' }), { code: 'FACE_CONSENT_REQUIRED' });
  const get = h.api.get;
  h.api.get = async path => ({ ...await get(path), challengeNonce: verificationId });
  await assert.rejects(h.provider.checkLivenessAndMatch({ consentAcknowledged: true }), { code: 'SESSION_EXPIRED' });
  assert.equal(h.counts().liveness, 0);
});

test('explicit restart clears all capture state and asks backend for a new challenge session', async () => {
  const h = harness();
  await scanBoth(h);
  await h.provider.readAndAuthenticateNfc();
  h.provider.restart();
  await assert.rejects(h.provider.checkLivenessAndMatch({ consentAcknowledged: true }), { code: 'DOCUMENT_SERVER_SESSION_REQUIRED' });
  await h.provider.inspectDocumentPhoto({ side: 'front' });
  assert.equal(h.calls.filter(([path]) => path.endsWith('/verification/start')).at(-1)[1].restart, true);
});

test('cold resume uses backend completion flags, never local SDK status or a registered ID alone', async () => {
  const h = harness(); const get = h.api.get;
  h.api.get = async path => path.endsWith('/status') ? {
    status: 'unverified', session: { status: 'in_progress', verificationId, docTransactionId,
      faceTransactionId, documentCompleted: true, nfcCompleted: true, faceCompleted: true },
  } : get(path);
  assert.equal((await h.provider.getStatus()).resumeStep, 'finish');
  assert.equal((await h.provider.submitToBackend()).status, 'pending_review');
  assert.equal(h.counts().finalize, 0);
  assert.equal(h.counts().liveness, 0);
  const unfinished = harness();
  unfinished.api.get = async path => path.endsWith('/status') ? {
    status: 'unverified', session: { status: 'in_progress', verificationId, docTransactionId },
  } : { verificationId, challengeNonce };
  assert.equal((await unfinished.provider.getStatus()).requiresRestart, true);
  await assert.rejects(unfinished.provider.submitToBackend(), { code: 'KYC_PROVIDER_EVIDENCE_REQUIRED' });
});

test('restart after an unacknowledged start recovers it before requesting a distinct fresh operation', async () => {
  const h = harness(); const post = h.api.post; let lose = true;
  h.api.post = async (path, body) => {
    const result = await post(path, body);
    if (path.endsWith('/verification/start') && lose) { lose = false; throw new Error('lost response'); }
    return result;
  };
  await assert.rejects(h.provider.inspectDocumentPhoto({ side: 'front' }));
  h.provider.restart();
  await h.provider.inspectDocumentPhoto({ side: 'front' });
  const starts = h.calls.filter(([path]) => path.endsWith('/verification/start')).map(([, body]) => body);
  assert.equal(starts.length, 3);
  assert.equal(starts[0].operationId, starts[1].operationId);
  assert.notEqual(starts[1].operationId, starts[2].operationId);
  assert.equal(starts[2].restart, true);
});

test('a lost NFC receipt retries the same signed bytes and operation without another chip read', async () => {
  const h = harness(); await scanBoth(h);
  const post = h.api.post; let lost = true;
  h.api.post = async (path, body) => {
    const result = await post(path, body);
    if (path.endsWith('/nfc/complete') && lost) { lost = false; throw new Error('response lost'); }
    return result;
  };
  await assert.rejects(h.provider.readAndAuthenticateNfc());
  const result = await h.provider.readAndAuthenticateNfc();
  const attempts = h.calls.filter(([path]) => path.endsWith('/nfc/complete'));
  assert.deepEqual(attempts[0][1], attempts[1][1]);
  assert.equal(h.calls.filter(([path]) => path.endsWith('/nfc/start')).length, 1);
  assert.equal(result.antiCloningVerified, false);
});

test('near-expiry grant renews without a new eKYC session or new scan', async () => {
  const h = harness(), post = h.api.post;
  h.api.post = async (path, body) => {
    if (path.endsWith('/document/start')) return { ...setup, grantExpiresAt: new Date(Date.now() + 15000).toISOString() };
    if (path.endsWith('/document/transport-grant')) return { ...setup, grantExpiresAt: new Date(Date.now() + 300000).toISOString() };
    return post(path, body);
  };
  await scanBoth(h);
  assert.equal(h.counts().starts, 1);
  assert.equal(h.counts().scans, 2);
  assert.equal(h.calls.filter(([path]) => path === 'sdk/refresh-grant').length, 1);
});
