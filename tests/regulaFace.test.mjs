import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';

const source = readFileSync(new URL('../src/services/regulaFace.js', import.meta.url), 'utf8');
const tag = '8b5ee934-4eca-4c85-b293-655365b2874e';
const serviceUrl = 'https://licensed-face.example.test/';
const capture = { tag, consentAcknowledged: true };

function vendorEnum(path, name) {
  const content = readFileSync(new URL('../node_modules/@regulaforensics/face-sdk/www/types/' + path, import.meta.url), 'utf8');
  const ast = parse(content, { sourceType: 'module', plugins: ['typescript'] });
  const declaration = ast.program.body.map(node => node.declaration).find(node => node?.type === 'TSEnumDeclaration' && node.id.name === name);
  assert.ok(declaration, `Installed SDK declares ${name}`);
  return Object.fromEntries(declaration.members.map((member, index) => [member.id.name, member.initializer?.value ?? index]));
}
const InitErrorCode = vendorEnum('init/init_exception.d.ts', 'InitErrorCode');
const LivenessErrorCode = vendorEnum('liveness/liveness_exception.d.ts', 'LivenessErrorCode');
const LivenessStatus = vendorEnum('liveness/liveness_response.d.ts', 'LivenessStatus');
const RecordingProcess = vendorEnum('liveness/liveness_config.d.ts', 'RecordingProcess');
const LivenessType = vendorEnum('liveness/liveness_config.d.ts', 'LivenessType');

// Protocol metadata only; no real license, CCCD, biometric or provider result fixtures.
function harness(configuredUrl = serviceUrl) {
  let imports = 0, nativeReady = false, pending;
  const calls = [];
  const reader = {
    isInitialized: async () => nativeReady,
    initialize: async (...args) => { calls.push(args); nativeReady = true; return [true, null]; },
    deinitialize: () => { nativeReady = false; },
    startLiveness: async ({ config }) => { calls.push(config); return pending; },
  };
  const sdk = {
    FaceSDK: { instance: reader },
    LivenessConfig: class { constructor(config) { Object.assign(this, config); } },
    InitErrorCode, LivenessErrorCode, LivenessStatus, RecordingProcess, LivenessType,
  };
  const native = { RNFaceSDK: { exec() {} } }, platform = { OS: 'android' };
  const code = source.replace(/^import .*;\r?$/gm, '').replace(/export /g, '')
    .replace('process.env.EXPO_PUBLIC_REGULA_FACE_URL', 'configuredUrl')
    .replace("import('@regulaforensics/face-sdk')", 'loadSdkModule()');
  const api = new Function('NativeModules', 'Platform', 'configuredUrl', 'loadSdkModule',
    code + '\nreturn { initializeRegulaFace, startRegulaLiveness, getRegulaFaceState };')
    (native, platform, configuredUrl, async () => { imports++; return sdk; });
  return { api, reader, sdk, native, platform, calls, imports: () => imports,
    respond: value => { pending = value; } };
}

test('Face service parses and guards absent configuration before importing native SDK', async () => {
  assert.ok(parse(source, { sourceType: 'module' }));
  const h = harness(null);
  await assert.rejects(h.api.initializeRegulaFace(), { code: 'FACE_SERVICE_NOT_CONFIGURED' });
  await assert.rejects(h.api.initializeRegulaFace({ serviceUrl }), { code: 'FACE_GATEWAY_AUTH_REQUIRED' });
  await assert.rejects(h.api.startRegulaLiveness(capture), { code: 'FACE_NOT_INITIALIZED' });
  assert.equal(h.imports(), 0);
});

test('no plaintext, credential-bearing, malformed or known demo service URL', async () => {
  for (const url of ['http://example.test', 'https://user:secret@example.test', 'https://example.test?token=secret', 'https://example.test#fragment', 'not a URL']) {
    const h = harness(url);
    await assert.rejects(h.api.initializeRegulaFace(), { code: 'FACE_SERVICE_INVALID' });
    assert.equal(h.imports(), 0);
  }
  await assert.rejects(harness('https://faceapi.regulaforensics.com').api.initializeRegulaFace(), { code: 'FACE_SERVICE_DEMO_NOT_ALLOWED' });
});

test('Expo Go / absent bridge and unsupported platform fail before import', async () => {
  const h = harness(); delete h.native.RNFaceSDK;
  await assert.rejects(h.api.initializeRegulaFace(), { code: 'FACE_NATIVE_SDK_UNAVAILABLE' });
  h.platform.OS = 'web';
  await assert.rejects(h.api.initializeRegulaFace(), { code: 'NATIVE_PLATFORM_REQUIRED' });
  assert.equal(h.imports(), 0);
});

test('initialization rejects SDK failures without raw license/provider messages', async () => {
  const h = harness();
  h.reader.initialize = async () => [false, { code: InitErrorCode.BAD_LICENSE, message: 'private-provider-data' }];
  await assert.rejects(h.api.initializeRegulaFace(), error => error.code === 'REGULA_FACE_BAD_LICENSE' && error.sdkCode === InitErrorCode.BAD_LICENSE && !error.message.includes('private'));
  assert.equal(h.api.getRegulaFaceState().initialized, false);
  assert.equal(h.api.getRegulaFaceState().running, false);
});

test('matching transaction returns only unverified references, never image or trusted evidence', async () => {
  const h = harness(); await h.api.initializeRegulaFace({ serviceUrl, httpHeaders: { Authorization: 'Bearer unit-test' } });
  h.respond({ liveness: 0, transactionId: '12345678-1234-4234-8234-123456789abc', tag, image: 'private-face-image', error: null });
  const result = await h.api.startRegulaLiveness(capture);
  assert.deepEqual(result, { transactionId: '12345678-1234-4234-8234-123456789abc', tag, captured: true, verified: false });
  assert.equal(h.calls[1].locationTrackingEnabled, false);
  assert.equal(h.calls[1].preventScreenRecording, true);
  assert.equal(h.calls[1].recordingProcess, 1);
  assert.equal(h.reader.serviceUrl, serviceUrl);
  assert.deepEqual(h.calls[0], []);
  assert.deepEqual(h.api.getRegulaFaceState(), { initialized: true, running: false, faceMatch: 'unverified', liveness: 'unverified' });
});

test('unknown status, absent transaction and mismatched tag fail closed', async () => {
  const h = harness(); await h.api.initializeRegulaFace();
  await assert.rejects(h.api.startRegulaLiveness({ ...capture, tag: 'personal data' }), { code: 'FACE_SESSION_TAG_INVALID' });
  for (const [response, code] of [[null, 'FACE_LIVENESS_UNCONFIRMED'], [{ liveness: 1 }, 'FACE_LIVENESS_UNCONFIRMED'], [{ liveness: 0, tag }, 'FACE_TRANSACTION_INVALID'], [{ liveness: 0, transactionId: 'opaque-transaction-reference', tag }, 'FACE_TRANSACTION_INVALID'], [{ liveness: 0, transactionId: '12345678-1234-4234-8234-123456789abc', tag: 'other-session' }, 'FACE_TRANSACTION_INVALID']]) {
    h.respond(response);
    await assert.rejects(h.api.startRegulaLiveness(capture), { code });
    assert.equal(h.api.getRegulaFaceState().running, false);
  }
});

test('cancel, timeout and native rejection expose safe codes; concurrent operations are denied', async () => {
  const h = harness(); await h.api.initializeRegulaFace();
  for (const [sdkCode, code] of [[LivenessErrorCode.CANCELLED, 'REGULA_FACE_CANCELLED'], [LivenessErrorCode.PROCESSING_TIMEOUT, 'REGULA_FACE_PROCESSING_TIMEOUT'], [777, 'FACE_LIVENESS_FAILED']]) {
    h.respond({ error: { code: sdkCode, message: 'private-message' } });
    await assert.rejects(h.api.startRegulaLiveness(capture), error => error.code === code && error.sdkCode === sdkCode && !error.message.includes('private'));
  }
  let complete;
  h.respond(new Promise(resolve => { complete = resolve; }));
  const first = h.api.startRegulaLiveness(capture);
  await assert.rejects(h.api.startRegulaLiveness(capture), { code: 'FACE_SDK_BUSY' });
  await assert.rejects(h.api.initializeRegulaFace(), { code: 'FACE_SDK_BUSY' });
  complete({ liveness: 0, transactionId: '12345678-1234-4234-8234-123456789abc', tag });
  await first;
  h.reader.startLiveness = async () => { throw new Error('private-native-error'); };
  await assert.rejects(h.api.startRegulaLiveness(capture), { code: 'FACE_LIVENESS_FAILED', message: 'FACE_LIVENESS_FAILED' });
  assert.equal(h.api.getRegulaFaceState().running, false);
});

test('biometric upload requires explicit consent and cannot use a truthy substitute', async () => {
  const h = harness(); await h.api.initializeRegulaFace();
  for (const consentAcknowledged of [undefined, false, 'true', 1]) {
    await assert.rejects(h.api.startRegulaLiveness({ tag, consentAcknowledged }), { code: 'FACE_CONSENT_REQUIRED' });
  }
  assert.equal(h.calls.length, 1);
});