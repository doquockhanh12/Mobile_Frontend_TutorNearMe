import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';

const source = readFileSync(new URL('../src/services/regulaDocument.js', import.meta.url), 'utf8');
const enumSource = readFileSync(new URL('../node_modules/@regulaforensics/document-reader/www/types/info/DocReaderException.d.ts', import.meta.url), 'utf8');
const ErrorCodes = Object.fromEntries([...enumSource.matchAll(/^\s+(\w+) = (-?\d+),/gm)].map(([, key, value]) => [key, Number(value)]));
const actionSource = readFileSync(new URL('../node_modules/@regulaforensics/document-reader/www/types/index.d.ts', import.meta.url), 'utf8').split('export declare enum DocReaderAction {')[1].split('}')[0];
const DocReaderAction = Object.fromEntries([...actionSource.matchAll(/^\s+(\w+) = (-?\d+),/gm)].map(([, key, value]) => [key, Number(value)]));
function vendorEnum(path, name) {
  const content = readFileSync(new URL('../node_modules/@regulaforensics/document-reader/www/types/' + path, import.meta.url), 'utf8');
  const body = content.split('export declare enum ' + name + ' {')[1].split('}')[0];
  return Object.fromEntries([...body.matchAll(/^\s+(\w+) = (-?\d+),?/gm)].map(([, key, value]) => [key, Number(value)]));
}
const GraphicFieldType = vendorEnum('results/visual_results/GraphicFieldType.d.ts', 'GraphicFieldType');
const ResultType = vendorEnum('results/Results.d.ts', 'ResultType');
const RFIDErrorCodes = vendorEnum('rfid/RFIDErrorCodes.d.ts', 'RFIDErrorCodes');

// Only callback protocol metadata is simulated; there are no CCCD, face or NFC data fixtures.
function harness() {
  let scanCallback, nfcCallback, imports = 0;
  const reader = {
    processParams: {}, functionality: {}, rfidScenario: {}, startNewSession() {}, startNewPage() {},
    license: { isRfidAvailable: true }, isReady: async () => true,
    isRFIDAvailableForUse: async () => true,
    prepareDatabase: async () => [true, null], initialize: async () => [true, null],
    startScanner: (_config, callback) => { scanCallback = callback; },
    rfid: config => { reader.nfcConfig = config; nfcCallback = config.callback; },
  };
  const native = { RNDocumentReader: { exec() {} } }, platform = { OS: 'android' };
  const module = { DocumentReader: { instance: reader }, ErrorCodes, DocReaderAction,
    GraphicFieldType, ResultType, RFIDErrorCodes,
    EPassportDataGroups: class {}, EIDDataGroups: class {},
    BackendProcessingConfig: class { constructor(url, options) { Object.assign(this, { url, ...options }); } },
    InitConfig: class {}, ScannerConfig: { withScenario: value => value }, Scenario: { FULL_PROCESS: 'FullProcess' },
    RFIDConfig: class { constructor(callback) { this.callback = callback; } } };
  const fs = { EncodingType: { Base64: 'base64' }, readAsStringAsync: async () => 'opaque-test-license' };
  const asset = { fromModule: () => ({ localUri: 'file://unit-test', downloadAsync: async () => {} }) };
  const code = source.replace(/^import .*;\r?$/gm, '').replace(/export /g, '')
    .replace("require('@regulaforensics/document-reader')", 'loadSdkModule()');
  const api = new Function('Asset', 'FileSystem', 'NativeModules', 'Platform', 'loadSdkModule', 'require',
    code + '\nreturn { initializeRegulaDocument, scanDocumentWithRegula, readNfcWithRegula, getNfcEvidence, getRegulaDiagnosticState, configureRegulaServerSideVerification, refreshRegulaDocumentUploadGrant, finalizeRegulaDocumentPackage, resetRegulaDocumentSession, getLastDocImages, getLastRfidPortrait };')
    (asset, fs, native, platform, () => { imports++; return module; }, () => 1);
  return { api, reader, fs, native, platform, imports: () => imports,
    scan: (...args) => scanCallback(...args), nfc: (...args) => nfcCallback(...args) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const nfcResult = () => ({ rfidSessionData: { dataFields: [1, 2, 21].map(fieldType => ({ fieldType, data: 'b3BhcXVl' })) } });
async function scanDone(h) {
  const pending = h.api.scanDocumentWithRegula();
  await tick();
  h.scan(DocReaderAction.COMPLETE, {}, null);
  return pending;
}

test('service and diagnostics parse as JavaScript/JSX (not a native build)', () => {
  for (const filename of ['src/services/regulaDocument.js', 'src/screens/RegulaDiagnostics.jsx']) {
    const file = new URL('../' + filename, import.meta.url);
    assert.ok(parse(readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['jsx'] }));
  }
});
test('Expo Go / absent bridge fails before SDK import, unsupported platform is distinct', async () => {
  const h = harness(); delete h.native.RNDocumentReader;
  await assert.rejects(h.api.initializeRegulaDocument(), { code: 'NATIVE_SDK_UNAVAILABLE' });
  assert.equal(h.imports(), 0);
  h.platform.OS = 'ios';
  await assert.rejects(h.api.initializeRegulaDocument(), { code: 'ANDROID_REQUIRED' });
});
test('concurrent initialization loads the guarded SDK module once', async () => {
  const h = harness();
  const results = await Promise.all([h.api.initializeRegulaDocument(), h.api.initializeRegulaDocument()]);
  assert.equal(h.imports(), 1);
  assert.ok(results.every(result => result.status === 'ready'));
});
test('license/database failures retain precise codes and do not disclose raw messages', async () => {
  const h = harness();
  h.reader.prepareDatabase = async () => [false, { code: ErrorCodes.FETCHING_DATABASE, message: 'private-data' }];
  await assert.rejects(h.api.initializeRegulaDocument(), e => e.code === 'REGULA_FETCHING_DATABASE' && e.sdkCode === 5 && !e.message.includes('private'));
  assert.equal(h.api.getRegulaDiagnosticState().initialized, false);
  h.reader.prepareDatabase = async () => [true, null];
  h.reader.initialize = async () => [false, { code: ErrorCodes.LICENSE_INVALID_DATE }];
  await assert.rejects(h.api.initializeRegulaDocument(), { code: 'REGULA_LICENSE_INVALID_DATE' });
  assert.equal(h.api.getRegulaDiagnosticState().running, false);
});
test('empty or unreadable license never initializes', async () => {
  const h = harness(); h.fs.readAsStringAsync = async () => '';
  await assert.rejects(h.api.initializeRegulaDocument(), { code: 'LICENSE_EMPTY' });
  h.fs.readAsStringAsync = async () => { throw Error('private-path'); };
  await assert.rejects(h.api.initializeRegulaDocument(), { code: 'LICENSE_READ_FAILED' });
});
test('CCCD, Face, Liveness and NFC authenticity remain unverified after initialization', async () => {
  const h = harness(); await h.api.initializeRegulaDocument();
  assert.deepEqual(h.api.getRegulaDiagnosticState().capabilities, { vietnameseCccd: 'unverified', nfcLicense: 'licensed',
    nfcCryptography: 'unverified', faceMatching: 'unverified', liveness: 'unverified' });
  await assert.rejects(h.api.readNfcWithRegula(), { code: 'SCAN_REQUIRED_BEFORE_NFC' });
});
for (const [action, code] of [[DocReaderAction.CANCEL, 'OPERATION_CANCELLED'], [DocReaderAction.TIMEOUT, 'OPERATION_TIMEOUT'], [DocReaderAction.ERROR, 'OPERATION_FAILED']]) {
  test('scan terminates safely for ' + code, async () => {
    const h = harness(); await h.api.initializeRegulaDocument();
    const pending = h.api.scanDocumentWithRegula(); const check = assert.rejects(pending, { code });
    await tick(); h.scan(action, {}, null); await check;
    assert.equal(h.api.getRegulaDiagnosticState().opticalScanCompleted, false);
    assert.equal(h.api.getRegulaDiagnosticState().running, false);
  });
}
test('front scanner extracts RAW_IMAGE when GraphicField.value is omitted', async () => {
  const h = harness(); await h.api.initializeRegulaDocument();
  const pending = h.api.scanDocumentWithRegula(); await tick();
  h.scan(DocReaderAction.COMPLETE, {
    graphicResult: { fields: [{ fieldType: GraphicFieldType.DOCUMENT_IMAGE, pageIndex: 0 }] },
    graphicFieldImageByTypeSourcePageIndex: async (fieldType, source, pageIndex) => {
      assert.equal(fieldType, GraphicFieldType.DOCUMENT_IMAGE);
      assert.equal(source, ResultType.RAW_IMAGE);
      return pageIndex === 0 ? 'base64-front-preview' : null;
    },
  }, null);
  await pending;
  assert.equal(h.api.getLastDocImages().front, 'base64-front-preview');
  assert.equal(h.api.getLastDocImages().back, null);
});

test('custom two-step flow closes each page without automatic multipage/Skip UI', async () => {
  const h = harness(); await h.api.initializeRegulaDocument();
  const front = h.api.scanDocumentWithRegula(); await tick();
  assert.equal(h.reader.functionality.manualMultipageMode, true);
  assert.equal(h.reader.processParams.multipageProcessing, false);
  h.scan(DocReaderAction.COMPLETE, { morePagesAvailable: 1, graphicResult: { fields: [
    { fieldType: GraphicFieldType.DOCUMENT_IMAGE, pageIndex: 0, value: 'front-capture' },
  ] } }, null); await front;
  assert.equal(h.api.getLastDocImages().front, 'front-capture');
  assert.equal(h.api.getLastDocImages().back, null);
});

test('back retry stays on page one, refreshes its image and preserves the front', async () => {
  const h = harness(); await h.api.initializeRegulaDocument(); let pages = 0;
  h.reader.startNewPage = () => { pages++; };
  const front = h.api.scanDocumentWithRegula(); await tick();
  h.scan(DocReaderAction.COMPLETE, { graphicResult: { fields: [
    { fieldType: GraphicFieldType.DOCUMENT_IMAGE, pageIndex: 0, value: 'front-capture' },
  ] } }, null); await front;
  const back = h.api.scanDocumentWithRegula({ nextPage: true }); await tick();
  h.scan(DocReaderAction.COMPLETE, { graphicFieldImageByTypeSourcePageIndex: async (_type, _source, page) => page === 1 ? 'back-capture' : null }, null);
  await back; assert.equal(pages, 1); assert.equal(h.api.getLastDocImages().back, 'back-capture');
  const retry = h.api.scanDocumentWithRegula({ nextPage: true }); await tick();
  assert.equal(h.api.getLastDocImages().back, null);
  h.scan(DocReaderAction.COMPLETE, { graphicFieldImageByTypeSourcePageIndex: async () => null }, null);
  await retry; assert.equal(pages, 1);
  assert.equal(h.api.getLastDocImages().front, 'front-capture'); assert.equal(h.api.getLastDocImages().back, null);
});

test('rescanning the front resets the native page sequence instead of accumulating page two', async () => {
  const h = harness(); await h.api.initializeRegulaDocument(); let sessions = 0;
  h.reader.startNewSession = () => { sessions++; };
  await scanDone(h);
  const retry = h.api.scanDocumentWithRegula(); await tick();
  h.scan(DocReaderAction.COMPLETE, {}, null); await retry;
  assert.equal(sessions, 1);
  await assert.rejects(h.api.scanDocumentWithRegula({ nextPage: true }), { code: 'FRONT_SCAN_REQUIRED' });
});
test('partial pages do not finish; busy operations are rejected; complete scan leaks no results', async () => {
  const h = harness(); await h.api.initializeRegulaDocument();
  const pending = h.api.scanDocumentWithRegula(); await tick();
  h.scan(DocReaderAction.MORE_PAGES_AVAILABLE, {}, null);
  assert.equal(h.api.getRegulaDiagnosticState().running, true);
  await assert.rejects(h.api.readNfcWithRegula(), { code: 'SDK_BUSY' });
  h.scan(DocReaderAction.COMPLETE, {}, null);
  assert.deepEqual(Object.keys(await pending).sort(), ['note', 'scanned', 'verified']);
  const retry = h.api.scanDocumentWithRegula(); const check = assert.rejects(retry, { code: 'EMPTY_RESULT' });
  await tick(); h.scan(DocReaderAction.COMPLETE, null, null); await check;
  await assert.rejects(h.api.readNfcWithRegula(), { code: 'SCAN_REQUIRED_BEFORE_NFC' });
});
test('NFC distinguishes license from device usability and uses the default UI DocumentReader error namespace', async () => {
  const h = harness(); await h.api.initializeRegulaDocument(); await scanDone(h);
  h.reader.license.isRfidAvailable = false;
  await assert.rejects(h.api.readNfcWithRegula(), { code: 'NFC_NOT_LICENSED' });
  h.reader.license.isRfidAvailable = true; h.reader.isRFIDAvailableForUse = async () => false;
  await assert.rejects(h.api.readNfcWithRegula(), { code: 'NFC_UNAVAILABLE' });
  h.reader.isRFIDAvailableForUse = async () => true;
  const pending = h.api.readNfcWithRegula(); const check = assert.rejects(pending, { code: 'REGULA_RFID_ERROR', sdkCode: 12, phase: 'nfc' });
  await tick(); h.nfc(DocReaderAction.ERROR, null, { code: ErrorCodes.RFID_ERROR, message: 'private-data' }); await check;
});
test('NFC cancel/timeout are not chip authentication; no provider payload leaves diagnostics', async () => {
  const h = harness(); await h.api.initializeRegulaDocument(); await scanDone(h);
  for (const [action, code] of [[DocReaderAction.CANCEL, 'OPERATION_CANCELLED'], [DocReaderAction.TIMEOUT, 'OPERATION_TIMEOUT']]) {
    const pending = h.api.readNfcWithRegula(); const check = assert.rejects(pending, { code });
    await tick(); h.nfc(action, {}, null); await check;
  }
  const pending = h.api.readNfcWithRegula(); await tick(); h.nfc(DocReaderAction.COMPLETE, nfcResult(), null);
  assert.equal((await pending).verified, false);
  assert.equal(h.api.getRegulaDiagnosticState().capabilities.nfcCryptography, 'unverified');
});

test('NFC exposes only recognized RFID numeric failure codes, never provider messages', async () => {
  const h = harness(); await h.api.initializeRegulaDocument(); await scanDone(h);
  const pending = h.api.readNfcWithRegula();
  const check = assert.rejects(pending, e => e.code === 'RFID_NO_CHIP_DETECTED'
    && e.sdkCode === RFIDErrorCodes.NO_CHIP_DETECTED && !e.message.includes('private'));
  await tick();
  h.reader.nfcConfig.onRetryReadChip({ code: RFIDErrorCodes.NO_CHIP_DETECTED, message: 'private-data' });
  h.nfc(DocReaderAction.ERROR, null, { code: ErrorCodes.RFID_ERROR, message: 'private-data' });
  await check;
  assert.equal(h.api.getRegulaDiagnosticState().running, false);
  assert.equal(h.api.getLastRfidPortrait(), null);
});

test('a transient RFID retry error cannot turn a later successful read into failure', async () => {
  const h = harness(); await h.api.initializeRegulaDocument(); await scanDone(h);
  const pending = h.api.readNfcWithRegula(); await tick();
  h.reader.nfcConfig.onRetryReadChip({ code: RFIDErrorCodes.NO_CHIP_DETECTED });
  h.nfc(DocReaderAction.COMPLETE, nfcResult(), null);
  assert.equal((await pending).verified, false);
});

test('NFC result status supplies a precise failure; unknown codes retain the generic safe error', async () => {
  const h = harness(); await h.api.initializeRegulaDocument(); await scanDone(h);
  for (const [status, code] of [[RFIDErrorCodes.NOT_AVAILABLE, 'RFID_NOT_AVAILABLE'], [123456789, 'REGULA_RFID_ERROR']]) {
    const pending = h.api.readNfcWithRegula();
    const check = assert.rejects(pending, { code }); await tick();
    h.nfc(DocReaderAction.ERROR, { rfidSessionData: { status } }, { code: ErrorCodes.RFID_ERROR });
    await check;
  }
});

test('secure optical gateway disables RFID reprocessing, finalizes two images before NFC, and resets private state', async () => {
  const h = harness();
  await h.api.initializeRegulaDocument();
  const challengeNonce = '12345678-1234-4234-8234-123456789abc';
  const httpHeaders = { Authorization: 'Bearer unit-test', 'X-Kyc-Verification-Id': challengeNonce };
  for (const serviceUrl of ['http://app.test', 'https://localhost', 'https://127.0.0.1', 'https://app.test/wrong-path', 'https://regulaforensics.com']) {
    await assert.rejects(h.api.configureRegulaServerSideVerification({ challengeNonce, serviceUrl, httpHeaders }), { code: 'DOCUMENT_SERVICE_INVALID' });
  }
  await assert.rejects(h.api.configureRegulaServerSideVerification({ challengeNonce, serviceUrl: 'https://app.test' }), { code: 'DOCUMENT_GATEWAY_AUTH_REQUIRED' });
  await assert.rejects(h.api.configureRegulaServerSideVerification({ challengeNonce, serviceUrl: 'https://app.test',
    httpHeaders: { Authorization: 'Bearer valid-but-unbound' } }), { code: 'DOCUMENT_GATEWAY_AUTH_REQUIRED' });
  await h.api.configureRegulaServerSideVerification({ challengeNonce, serviceUrl: 'https://app.test', httpHeaders });
  assert.equal(h.reader.processParams.backendProcessingConfig.rfidServerSideChipVerification, false);
  assert.deepEqual(h.reader.processParams.backendProcessingConfig.httpHeaders, httpHeaders);
  const scan = h.api.scanDocumentWithRegula(); await tick();
  h.scan(DocReaderAction.COMPLETE, { graphicResult: { fields: [
    { fieldType: GraphicFieldType.DOCUMENT_IMAGE, sourceType: ResultType.GRAPHICS, pageIndex: 0, value: 'preview' },
    { fieldType: GraphicFieldType.PORTRAIT, sourceType: ResultType.GRAPHICS, value: 'optical-portrait-must-not-be-nfc' },
  ] } }, null); await scan;
  assert.equal(h.api.getLastRfidPortrait(), null);
  await assert.rejects(h.api.finalizeRegulaDocumentPackage(), { code: 'DOCUMENT_SERVER_SESSION_REQUIRED' });
  const back = h.api.scanDocumentWithRegula({ nextPage: true }); await tick();
  h.scan(DocReaderAction.COMPLETE, { graphicResult: { fields: [
    { fieldType: GraphicFieldType.DOCUMENT_IMAGE, pageIndex: 1, value: 'back-preview' },
  ] } }, null); await back;
  h.reader.finalizePackage = async config => {
    assert.deepEqual(config, { rawImages: true, rfidSession: false, video: false });
    return [DocReaderAction.COMPLETE, { transactionId: challengeNonce, tag: 'substituted' }, null];
  };
  await assert.rejects(h.api.finalizeRegulaDocumentPackage(), { code: 'DOCUMENT_FINALIZE_FAILED' });
  h.reader.finalizePackage = async () => [DocReaderAction.COMPLETE, { transactionId: challengeNonce, tag: challengeNonce }, null];
  assert.equal((await h.api.finalizeRegulaDocumentPackage()).verified, false);
  const nfc = h.api.readNfcWithRegula(); await tick();
  h.nfc(DocReaderAction.COMPLETE, { ...nfcResult(), graphicFieldImageByTypeSource: async (field, source) => {
    assert.equal(field, GraphicFieldType.PORTRAIT); assert.equal(source, ResultType.RFID_IMAGE_DATA); return 'nfc-preview';
  } }, null); await nfc;
  assert.equal(h.reader.processParams.backendProcessingConfig, null);
  assert.equal(h.reader.rfidScenario.ePassportDataGroups.dg3, false);
  assert.equal(h.reader.rfidScenario.ePassportDataGroups.dg4, false);
  assert.equal(h.api.getNfcEvidence().dataGroups.length, 2);
  h.api.resetRegulaDocumentSession();
  assert.equal(h.api.getLastDocImages().front, null);
  assert.equal(h.api.getLastRfidPortrait(), null);
  assert.throws(() => h.api.getNfcEvidence(), { code: 'NFC_RAW_EVIDENCE_UNAVAILABLE' });
  await assert.rejects(h.api.finalizeRegulaDocumentPackage(), { code: 'DOCUMENT_SERVER_SESSION_REQUIRED' });
});

test('SDK success without raw signed chip files cannot be used as NFC proof', async () => {
  const h = harness(); await h.api.initializeRegulaDocument(); await scanDone(h);
  const pending = h.api.readNfcWithRegula(), check = assert.rejects(pending, { code: 'NFC_RAW_EVIDENCE_UNAVAILABLE' });
  await tick(); h.nfc(DocReaderAction.COMPLETE, { rfidSessionData: { status: 1, pa: true, ca: true } }, null);
  await check;
  assert.throws(() => h.api.getNfcEvidence());
});

test('native hexadecimal file bytes are forwarded canonically without SDK verdicts', async () => {
  const h = harness(); await h.api.initializeRegulaDocument(); await scanDone(h);
  const pending = h.api.readNfcWithRegula(); await tick();
  h.nfc(DocReaderAction.COMPLETE, { rfidSessionData: { status: 1, dataFields: [
    { fieldType: 1, data: '6100' }, { fieldType: 2, data: '7500' }, { fieldType: 21, data: '770000' },
  ] } }, null); await pending;
  assert.deepEqual(h.api.getNfcEvidence(), { sod: 'dwAA', dataGroups: [{ number: 1, data: 'YQA=' }, { number: 2, data: 'dQA=' }] });
});

test('duplicate terminal SDK callbacks cannot replace the captured NFC bundle', async () => {
  const h = harness(); await h.api.initializeRegulaDocument(); await scanDone(h);
  const pending = h.api.readNfcWithRegula(); await tick();
  h.nfc(DocReaderAction.COMPLETE, nfcResult(), null); await pending;
  const first = h.api.getNfcEvidence();
  h.nfc(DocReaderAction.COMPLETE, { rfidSessionData: { dataFields: [] } }, null); await tick();
  assert.deepEqual(h.api.getNfcEvidence(), first);
});

test('an unexpected async result extraction failure rejects instead of leaving the scanner busy forever', async () => {
  const h = harness(); await h.api.initializeRegulaDocument();
  const pending = h.api.scanDocumentWithRegula(), check = assert.rejects(pending, { code: 'OPERATION_FAILED' });
  await tick();
  h.scan(DocReaderAction.COMPLETE, { get graphicResult() { throw new Error('private-result-canary'); } }, null);
  await check; assert.equal(h.api.getRegulaDiagnosticState().running, false);
});

test('refreshing upload credentials retains the native optical session tag', async () => {
  const h = harness(); await h.api.initializeRegulaDocument();
  const challengeNonce = '12345678-1234-4234-8234-123456789abc';
  const serviceUrl = 'https://upload.example.test';
  await h.api.configureRegulaServerSideVerification({ challengeNonce, serviceUrl,
    httpHeaders: { Authorization: 'Bearer old', 'X-Kyc-Verification-Id': challengeNonce } });
  const before = h.reader.processParams.backendProcessingConfig;
  await h.api.refreshRegulaDocumentUploadGrant({ challengeNonce, serviceUrl,
    httpHeaders: { Authorization: 'Bearer new', 'X-Kyc-Verification-Id': challengeNonce } });
  assert.equal(h.reader.tag, challengeNonce);
  assert.notEqual(before, h.reader.processParams.backendProcessingConfig);
  assert.equal(h.reader.processParams.backendProcessingConfig.httpHeaders.Authorization, 'Bearer new');
  await assert.rejects(h.api.refreshRegulaDocumentUploadGrant({ challengeNonce, serviceUrl: 'https://other.example.test',
    httpHeaders: { Authorization: 'Bearer other', 'X-Kyc-Verification-Id': challengeNonce } }), { code: 'DOCUMENT_BACKEND_API_UNAVAILABLE' });
  assert.equal(h.reader.processParams.backendProcessingConfig.httpHeaders.Authorization, 'Bearer new');
});
