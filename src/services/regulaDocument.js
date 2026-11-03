/**
 * Android capture and Hybrid NFC transport. Local SDK verdicts never grant identity verification.
 * Requires an Expo Development Build containing Regula; Expo Go cannot load the native bridge.
 */
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system/legacy';
import { NativeModules, Platform } from 'react-native';

export class RegulaDiagnosticError extends Error {
  constructor(code, phase, sdkCode) {
    super(code);
    this.name = 'RegulaDiagnosticError';
    this.code = code;
    this.phase = phase;
    this.sdkCode = sdkCode;
  }
}

let sdk;
let lastRfidPortrait = null;
let lastDocImages = { front: null, back: null, portrait: null };
let initialized = false;
let initializationPromise = null;
let opticalScanCompleted = false;
let nfcReadCompleted = false;
let running = false;
let backendProcessingReady = false;
let activeTag = null;
let opticalPage = 0;
let opticalStarted = false;
let lastNfcEvidence = null;

async function loadSdk() {
  if (Platform.OS !== 'android') throw new RegulaDiagnosticError('ANDROID_REQUIRED');
  if (typeof NativeModules.RNDocumentReader?.exec !== 'function') {
    throw new RegulaDiagnosticError('NATIVE_SDK_UNAVAILABLE');
  }
  // Load only after checking the bridge; Metro's async chunk may be unavailable on a USB-connected device.
  sdk ??= require('@regulaforensics/document-reader');
  return sdk.DocumentReader.instance;
}

function sdkError(error, phase, fallback) {
  if (error instanceof RegulaDiagnosticError) return error;
  // RFIDConfig's default UI callback returns DocReaderException, not RFIDException.
  const codes = sdk?.ErrorCodes;
  const number = Number.isInteger(error?.code) ? error.code : undefined;
  const symbol = Object.keys(codes || {}).find(key => /^[A-Za-z][A-Za-z0-9_]*$/.test(key) && codes[key] === number);
  return new RegulaDiagnosticError(symbol ? `REGULA_${symbol}` : fallback, phase, number);
}

async function readLicenseBase64() {
  try {
    const asset = Asset.fromModule(require('../../assets/licenses/regula.license'));
    await asset.downloadAsync();
    const uri = asset.localUri || asset.uri;
    if (!uri) throw new RegulaDiagnosticError('LICENSE_NOT_FOUND');
    const data = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
    if (!data) throw new RegulaDiagnosticError('LICENSE_EMPTY');
    return data;
  } catch (error) {
    if (error instanceof RegulaDiagnosticError) throw error;
    throw new RegulaDiagnosticError('LICENSE_READ_FAILED');
  }
}

export function initializeRegulaDocument() {
  if (initializationPromise) return initializationPromise;
  initializationPromise = initializeRegulaDocumentOnce().finally(() => { initializationPromise = null; });
  return initializationPromise;
}
async function initializeRegulaDocumentOnce() {
  if (running) throw new RegulaDiagnosticError('SDK_BUSY');
  running = true;
  try {
    const reader = await loadSdk();
    if (initialized && await reader.isReady()) return { status: 'ready', capabilities: getRegulaDiagnosticState().capabilities };
    initialized = false;
    opticalScanCompleted = false;
    const license = await readLicenseBase64();
    const [dbReady, dbError] = await reader.prepareDatabase('Full');
    if (!dbReady) throw sdkError(dbError, 'database', 'DOCUMENT_DB_FAILED');
    const [success, error] = await reader.initialize(new sdk.InitConfig(license));
    if (!success) throw sdkError(error, 'initialize', 'REGULA_INITIALIZATION_FAILED');
    if (!await reader.isReady()) throw new RegulaDiagnosticError('NOT_INITIALIZED');
    initialized = true;
    return { status: 'ready', capabilities: getRegulaDiagnosticState().capabilities };
  } catch (error) {
    initialized = false;
    opticalScanCompleted = false;
    throw sdkError(error, 'initialize', 'REGULA_INITIALIZATION_FAILED');
  } finally {
    running = false;
  }
}

function completion(phase, start) {
  return new Promise((resolve, reject) => {
    let finished = false;
    try {
      start(async (action, results, error) => {
        if (finished) return;
        if (error || [sdk.DocReaderAction.COMPLETE, sdk.DocReaderAction.CANCEL, sdk.DocReaderAction.TIMEOUT, sdk.DocReaderAction.ERROR].includes(action)) finished = true;
        try {
          if (error) return reject(sdkError(error, phase, phase === 'nfc' ? 'NFC_READ_ERROR' : 'DOCUMENT_SCAN_ERROR'));
          if (action === sdk.DocReaderAction.CANCEL) return reject(new RegulaDiagnosticError('OPERATION_CANCELLED', phase));
          if (action === sdk.DocReaderAction.TIMEOUT) return reject(new RegulaDiagnosticError('OPERATION_TIMEOUT', phase));
          if (action === sdk.DocReaderAction.ERROR) return reject(new RegulaDiagnosticError('OPERATION_FAILED', phase));
          if (action === sdk.DocReaderAction.COMPLETE) {
            if (!results) return reject(new RegulaDiagnosticError('EMPTY_RESULT', phase));
            // Previews are local capture data; only the backend authenticates them.
            for (const field of results.graphicResult?.fields || []) {
              if (phase === 'scan' && sdk.GraphicFieldType && field.fieldType === sdk.GraphicFieldType.DOCUMENT_IMAGE && field.value) {
                if (field.pageIndex === 0) lastDocImages.front = field.value;
                if (field.pageIndex === 1) lastDocImages.back = field.value;
              }
            }
            // The SDK may omit GraphicField.value; obtain RAW_IMAGE by page index.
            if (phase === 'scan' && typeof results.graphicFieldImageByTypeSourcePageIndex === 'function'
              && sdk.GraphicFieldType?.DOCUMENT_IMAGE != null && sdk.ResultType?.RAW_IMAGE != null) {
              for (const pageIndex of [0, 1]) {
                const side = pageIndex === 0 ? 'front' : 'back';
                if (lastDocImages[side]) continue;
                try {
                  const image = await results.graphicFieldImageByTypeSourcePageIndex(
                    sdk.GraphicFieldType.DOCUMENT_IMAGE, sdk.ResultType.RAW_IMAGE, pageIndex);
                  if (typeof image === 'string' && image.length > 0) lastDocImages[side] = image;
                } catch {
                  // One page may not exist yet; never invent a captured image.
                }
              }
            }
            if (phase === 'nfc' && typeof results.graphicFieldImageByTypeSource === 'function'
              && sdk.GraphicFieldType && sdk.ResultType) {
              try {
                lastRfidPortrait = await results.graphicFieldImageByTypeSource(
                  sdk.GraphicFieldType.PORTRAIT, sdk.ResultType.RFID_IMAGE_DATA);
              } catch { lastRfidPortrait = null; }
            }
            if (phase === 'nfc') {
              try { lastNfcEvidence = extractNfcEvidence(results); }
              catch (failure) { reject(failure); return; }
            }
            resolve();
          }
        } catch (failure) {
          finished = true;
          reject(sdkError(failure, phase, 'OPERATION_FAILED'));
        }
      });
    } catch (error) {
      reject(sdkError(error, phase, 'OPERATION_FAILED'));
    }
  });
}

function extractNfcEvidence(results) {
  const fields = [...(results.rfidSessionData?.dataFields || [])];
  for (const application of results.rfidSessionData?.applications || []) {
    for (const file of application.files || []) {
      if (file.fileData?.data) fields.push({ fieldType: file.type, data: file.fileData.data });
    }
  }
  const files = new Map();
  for (const field of fields) {
    if (![1, 2, 14, 15, 21].includes(field.fieldType)) continue;
    if (typeof field.data !== 'string' || !field.data.length || field.data.length > 6000000) {
      throw new RegulaDiagnosticError('NFC_RAW_EVIDENCE_UNAVAILABLE', 'nfc');
    }
    const data = canonicalNfcBytes(field.data, field.fieldType);
    if (data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new RegulaDiagnosticError('NFC_RAW_EVIDENCE_UNAVAILABLE', 'nfc');
    if (files.has(field.fieldType) && files.get(field.fieldType) !== data) throw new RegulaDiagnosticError('NFC_RAW_EVIDENCE_CONFLICT', 'nfc');
    files.set(field.fieldType, data);
  }
  if (![1, 2, 21].every(type => files.has(type))) throw new RegulaDiagnosticError('NFC_RAW_EVIDENCE_UNAVAILABLE', 'nfc');
  return { sod: files.get(21), dataGroups: [...files].filter(([number]) => number !== 21)
    .sort(([a], [b]) => a - b).map(([number, data]) => ({ number, data })) };
}

function canonicalNfcBytes(value, type) {
  // Native file strings may be hex; these ASN.1 tag prefixes cannot be a valid Base64 encoding of the same file.
  const tags = { 1: [0x61], 2: [0x75], 14: [0x6e], 15: [0x6f], 21: [0x77, 0x30] };
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(value) || !tags[type].includes(parseInt(value.slice(0, 2), 16))) return value;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const output = [];
  for (let i = 0; i < value.length; i += 6) {
    const a = parseInt(value.slice(i, i + 2), 16), b = parseInt(value.slice(i + 2, i + 4), 16), c = parseInt(value.slice(i + 4, i + 6), 16);
    output.push(alphabet[a >> 2], alphabet[((a & 3) << 4) | (Number.isNaN(b) ? 0 : b >> 4)],
      Number.isNaN(b) ? '=' : alphabet[((b & 15) << 2) | (Number.isNaN(c) ? 0 : c >> 6)], Number.isNaN(c) ? '=' : alphabet[c & 63]);
  }
  return output.join('');
}

export function getNfcEvidence() {
  if (!lastNfcEvidence) throw new RegulaDiagnosticError('NFC_RAW_EVIDENCE_UNAVAILABLE', 'nfc');
  // Do not export SDK PASS flags, OCR claims, or a separately supplied portrait as trusted evidence.
  return { sod: lastNfcEvidence.sod, dataGroups: lastNfcEvidence.dataGroups.map(group => ({ ...group })) };
}

export async function scanDocumentWithRegula({ nextPage = false } = {}) {
  if (running) throw new RegulaDiagnosticError('SDK_BUSY');
  if (!initialized) throw new RegulaDiagnosticError('NOT_INITIALIZED');
  running = true;
  opticalScanCompleted = false;
  nfcReadCompleted = false;
  lastNfcEvidence = null;
  if (!nextPage) lastDocImages = { front: null, back: null, portrait: null };
  else lastDocImages.back = null;
  lastRfidPortrait = null;
  try {
    const reader = await loadSdk();
    if (!await reader.isReady()) { initialized = false; throw new RegulaDiagnosticError('NOT_INITIALIZED'); }
    // The app owns the front/back screens; do not let SDK's automatic multipage UI wait for Skip.
    reader.functionality.manualMultipageMode = true;
    reader.processParams.multipageProcessing = false;
    if (!nextPage) {
      if (opticalStarted) { reader.startNewSession(); reader.tag = activeTag; }
      opticalPage = 0;
    } else if (!opticalStarted || !lastDocImages.front) {
      throw new RegulaDiagnosticError('FRONT_SCAN_REQUIRED', 'scan');
    } else if (opticalPage === 0) {
      reader.startNewPage();
      opticalPage = 1;
    }
    opticalStarted = true;
    await completion('scan', callback => reader.startScanner(sdk.ScannerConfig.withScenario(sdk.Scenario.FULL_PROCESS), callback));
    opticalScanCompleted = true;
    return { scanned: true, verified: false, note: 'SDK đã hoàn tất quét; chưa xác minh CCCD hoặc danh tính.' };
  } catch (error) {
    throw sdkError(error, 'scan', 'DOCUMENT_SCAN_ERROR');
  } finally {
    running = false;
  }
}

export async function readNfcWithRegula() {
  if (running) throw new RegulaDiagnosticError('SDK_BUSY');
  if (!initialized) throw new RegulaDiagnosticError('NOT_INITIALIZED');
  if (!opticalScanCompleted) throw new RegulaDiagnosticError('SCAN_REQUIRED_BEFORE_NFC');
  running = true;
  lastRfidPortrait = null;
  nfcReadCompleted = false;
  lastNfcEvidence = null;
  try {
    const reader = await loadSdk();
    if (!await reader.isReady()) { initialized = false; opticalScanCompleted = false; throw new RegulaDiagnosticError('NOT_INITIALIZED'); }
    if (reader.license?.isRfidAvailable === false) throw new RegulaDiagnosticError('NFC_NOT_LICENSED');
    if (!await reader.isRFIDAvailableForUse()) throw new RegulaDiagnosticError('NFC_UNAVAILABLE');
    // Hybrid mode: read/authenticate locally, never ask Document Web Service to reprocess RFID.
    reader.processParams.backendProcessingConfig = null;
    if (!reader.rfidScenario || !sdk.EPassportDataGroups || !sdk.EIDDataGroups) throw new RegulaDiagnosticError('NFC_RAW_EVIDENCE_UNAVAILABLE', 'nfc');
    Object.assign(reader.rfidScenario, { passiveAuth: true, skipAA: false, authorizedRestrictedIdentification: false,
      authorizedPrivilegedTerminal: false, universalAccessRights: false });
    const passport = new sdk.EPassportDataGroups(), eid = new sdk.EIDDataGroups();
    for (let group = 1; group <= 21; group++) {
      const enabled = [1, 2, 14, 15].includes(group);
      if (group <= 16) passport[`dg${group}`] = enabled;
      eid[`dg${group}`] = enabled;
    }
    reader.rfidScenario.ePassportDataGroups = passport;
    reader.rfidScenario.eIDDataGroups = eid;
    await completion('nfc', callback => {
      let retryCode;
      const config = new sdk.RFIDConfig((action, results, error) => {
        if (error?.code === sdk.ErrorCodes.RFID_ERROR) {
          const code = results?.rfidSessionData?.status ?? retryCode;
          const name = Object.keys(sdk.RFIDErrorCodes || {}).find(key => /^[A-Z][A-Z0-9_]*$/.test(key)
            && sdk.RFIDErrorCodes[key] === code);
          if (name && !['NO_ERROR', 'UNDEFINED', 'ALREADY_DONE'].includes(name)) {
            error = new RegulaDiagnosticError(`RFID_${name}`, 'nfc', code);
          }
        }
        callback(action, results, error);
      });
      // Preserve numeric diagnostics only; SDK messages/results can contain identity data.
      config.onRetryReadChip = error => { retryCode = Number.isInteger(error?.code) ? error.code : undefined; };
      reader.rfid(config);
    });
    nfcReadCompleted = true;
    return { read: true, verified: false, note: 'SDK đã hoàn tất đọc chip; chữ ký, chứng thư và danh tính chưa được server xác thực.' };
  } catch (error) {
    throw sdkError(error, 'nfc', 'NFC_READ_ERROR');
  } finally {
    running = false;
  }
}

export function getRegulaDiagnosticState() {
  const licensed = initialized ? sdk?.DocumentReader.instance.license?.isRfidAvailable : undefined;
  return {
    initialized, opticalScanCompleted, running, capabilities: {
      vietnameseCccd: 'unverified',
      nfcLicense: typeof licensed === 'boolean' ? (licensed ? 'licensed' : 'not_licensed') : 'unverified',
      nfcCryptography: 'unverified',
      faceMatching: 'unverified',
      liveness: 'unverified',
    }
  };
}

export function getLastRfidPortrait() { return lastRfidPortrait; }
export function getLastDocImages() { return { ...lastDocImages }; }

/**
 * Regula 9.9 Complete Server-Side Verification requires a real HTTPS endpoint
 * reachable from the physical phone. Windows SSM localhost tunnel is not one.
 */
export async function configureRegulaServerSideVerification({ challengeNonce, serviceUrl, httpHeaders } = {}) {
  if (running) throw new RegulaDiagnosticError('SDK_BUSY', 'setup');
  backendProcessingReady = false;
  if (typeof challengeNonce !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(challengeNonce)) {
    throw new RegulaDiagnosticError('DOCUMENT_CHALLENGE_INVALID', 'setup');
  }
  if (typeof serviceUrl !== 'string' || !serviceUrl.trim()) {
    throw new RegulaDiagnosticError('DOCUMENT_SERVICE_NOT_CONFIGURED', 'setup');
  }
  let url;
  try { url = new URL(serviceUrl); } catch {
    throw new RegulaDiagnosticError('DOCUMENT_SERVICE_INVALID', 'setup');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || ['localhost', '127.0.0.1', '[::1]', '10.0.2.2'].includes(url.hostname)
    || /(^|\.)regulaforensics\.com$/i.test(url.hostname)) {
    throw new RegulaDiagnosticError('DOCUMENT_SERVICE_INVALID', 'setup');
  }
  if (!/^Bearer [A-Za-z0-9._~-]+$/.test(httpHeaders?.Authorization || '')
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(httpHeaders?.['X-Kyc-Verification-Id'] || '')) {
    throw new RegulaDiagnosticError('DOCUMENT_GATEWAY_AUTH_REQUIRED', 'setup');
  }
  const reader = await loadSdk();
  if (typeof sdk.BackendProcessingConfig !== 'function' || !reader.processParams) {
    throw new RegulaDiagnosticError('DOCUMENT_BACKEND_API_UNAVAILABLE', 'setup');
  }
  reader.startNewSession();
  clearDocumentPreviews();
  reader.tag = challengeNonce;
  activeTag = challengeNonce;
  Object.assign(reader.processParams, { logs: false, debugSaveImages: false, debugSaveLogs: false,
    debugSaveCroppedImages: false, debugSaveRFIDSession: false, debugSaveBinarySession: false,
    depersonalizeLog: true, multipageProcessing: false });
  reader.functionality.manualMultipageMode = true;
  reader.processParams.backendProcessingConfig = new sdk.BackendProcessingConfig(url.toString().replace(/\/$/, ''), {
    httpHeaders, rfidServerSideChipVerification: false,
  });
  backendProcessingReady = true;
}

/** Replace only SDK transport credentials without restarting optical capture. */
export async function refreshRegulaDocumentUploadGrant({ challengeNonce, serviceUrl, httpHeaders } = {}) {
  if (running) throw new RegulaDiagnosticError('SDK_BUSY', 'transport');
  if (!initialized || !backendProcessingReady || activeTag !== challengeNonce) {
    throw new RegulaDiagnosticError('DOCUMENT_SERVER_SESSION_REQUIRED', 'transport');
  }
  let url;
  try { url = new URL(serviceUrl); } catch { throw new RegulaDiagnosticError('DOCUMENT_SERVICE_INVALID', 'transport'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || ['localhost', '127.0.0.1', '[::1]', '10.0.2.2'].includes(url.hostname)
    || /(^|\.)regulaforensics\.com$/i.test(url.hostname)
    || !/^Bearer [A-Za-z0-9._~-]+$/.test(httpHeaders?.Authorization || '')
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(httpHeaders?.['X-Kyc-Verification-Id'] || '')) {
    throw new RegulaDiagnosticError('DOCUMENT_GATEWAY_AUTH_REQUIRED', 'transport');
  }
  const reader = await loadSdk();
  const prior = reader.processParams?.backendProcessingConfig;
  if (!prior || prior.url !== url.origin || reader.tag !== activeTag
    || typeof sdk.BackendProcessingConfig !== 'function') {
    throw new RegulaDiagnosticError('DOCUMENT_BACKEND_API_UNAVAILABLE', 'transport');
  }
  try {
    reader.processParams.backendProcessingConfig = new sdk.BackendProcessingConfig(url.origin, {
      httpHeaders: { ...httpHeaders }, rfidServerSideChipVerification: false,
    });
  } catch { throw new RegulaDiagnosticError('DOCUMENT_BACKEND_API_UNAVAILABLE', 'transport'); }
}

function clearDocumentPreviews() {
  lastRfidPortrait = null;
  lastDocImages = { front: null, back: null, portrait: null };
  opticalScanCompleted = false;
  nfcReadCompleted = false;
  lastNfcEvidence = null;
  opticalPage = 0;
  opticalStarted = false;
}

export function resetRegulaDocumentSession() {
  if (running) throw new RegulaDiagnosticError('SDK_BUSY');
  clearDocumentPreviews();
  backendProcessingReady = false;
  activeTag = null;
  const reader = sdk?.DocumentReader.instance;
  if (reader) {
    reader.startNewSession();
    reader.tag = null;
    if (typeof reader.resetConfiguration === 'function') {
      try { reader.resetConfiguration(); } catch (_) {}
    }
    if (reader.processParams) {
      delete reader.processParams._backendProcessingConfig;
      delete reader.processParams.backendProcessingConfig;
    }
  }
}

export async function finalizeRegulaDocumentPackage() {
  if (!initialized || !opticalScanCompleted || !lastDocImages.front || !lastDocImages.back || !backendProcessingReady) {
    throw new RegulaDiagnosticError('DOCUMENT_SERVER_SESSION_REQUIRED', 'finalize');
  }
  if (running) throw new RegulaDiagnosticError('SDK_BUSY', 'finalize');
  running = true;
  try {
    const reader = await loadSdk();
    if (typeof reader.finalizePackage !== 'function') {
      throw new RegulaDiagnosticError('DOCUMENT_FINALIZE_UNAVAILABLE', 'finalize');
    }
    const [action, info, error] = await reader.finalizePackage({ rawImages: true, rfidSession: false, video: false });
    if (error) throw sdkError(error, 'finalize', 'DOCUMENT_FINALIZE_FAILED');
    if (action !== sdk.DocReaderAction.COMPLETE ||
      info?.tag !== activeTag ||
      typeof info?.transactionId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(info.transactionId)) {
      throw new RegulaDiagnosticError('DOCUMENT_FINALIZE_FAILED', 'finalize');
    }
    return { transactionId: info.transactionId, captured: true, verified: false };
  } finally {
    running = false;
  }
}
