/** Native capture diagnostics only; a liveness transaction is not verified identity. */
import 'react-native-url-polyfill/auto';
import { NativeModules, Platform } from 'react-native';

export class RegulaFaceError extends Error {
  constructor(code, phase, sdkCode) {
    super(code);
    this.name = 'RegulaFaceError';
    this.code = code;
    this.phase = phase;
    this.sdkCode = sdkCode;
  }
}

let sdk;
let initialized = false;
let configuredForLiveness = false;
let running = false;
const serviceUrl = process.env.EXPO_PUBLIC_REGULA_FACE_URL;
let lastSelfie = null;


async function loadSdk() {
  if (!['android', 'ios'].includes(Platform.OS)) throw new RegulaFaceError('NATIVE_PLATFORM_REQUIRED');
  if (typeof NativeModules.RNFaceSDK?.exec !== 'function') throw new RegulaFaceError('FACE_NATIVE_SDK_UNAVAILABLE');
  // Import constructs a native event emitter, which cannot run in Expo Go.
  sdk ??= await import('@regulaforensics/face-sdk');
  return sdk.FaceSDK.instance;
}

function safeError(error, phase, fallback, codes) {
  if (error instanceof RegulaFaceError) return error;
  const number = Number.isInteger(error?.code) ? error.code : undefined;
  const symbol = Object.keys(codes || {}).find(key => /^[A-Za-z][A-Za-z0-9_]*$/.test(key) && codes[key] === number);
  return new RegulaFaceError(symbol ? `REGULA_FACE_${symbol}` : fallback, phase, number);
}

function configuredService(value = serviceUrl) {
  if (typeof value !== 'string' || !value.trim()) throw new RegulaFaceError('FACE_SERVICE_NOT_CONFIGURED');
  let url;
  try { url = new URL(value); } catch { throw new RegulaFaceError('FACE_SERVICE_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || ['localhost', '127.0.0.1', '[::1]', '10.0.2.2'].includes(url.hostname)) throw new RegulaFaceError('FACE_SERVICE_INVALID');
  if (url.hostname === 'faceapi.regulaforensics.com') throw new RegulaFaceError('FACE_SERVICE_DEMO_NOT_ALLOWED');
  return url.toString();
}

/** Core Basic needs no mobile license. The configured service must have its own licensed, approved transport. */
export async function initializeRegulaFace(config) {
  if (running) throw new RegulaFaceError('FACE_SDK_BUSY');
  running = true;
  configuredForLiveness = false;
  try {
    const url = configuredService(config?.serviceUrl);
    if (config && !/^Bearer [A-Za-z0-9._~-]+$/.test(config.httpHeaders?.Authorization || '')) {
      throw new RegulaFaceError('FACE_GATEWAY_AUTH_REQUIRED');
    }
    const reader = await loadSdk();
    initialized = false;
    if (await reader.isInitialized()) reader.deinitialize();
    reader.serviceUrl = url;
    reader.requestHeaders = config?.httpHeaders || null;
    const [success, error] = await reader.initialize();
    if (!success || error) throw safeError(error, 'initialize', 'FACE_INITIALIZATION_FAILED', sdk.InitErrorCode);
    if (!await reader.isInitialized()) throw new RegulaFaceError('FACE_NOT_INITIALIZED');
    initialized = true;
    configuredForLiveness = true;
    return { initialized: true, verified: false };
  } catch (error) {
    initialized = false;
    throw safeError(error, 'initialize', 'FACE_INITIALIZATION_FAILED', sdk?.InitErrorCode);
  } finally {
    running = false;
  }
}

/** tag is correlation metadata only. NestJS must independently validate binding and provider results. */
export async function startRegulaLiveness({ tag, verificationId, consentAcknowledged } = {}) {
  if (running) throw new RegulaFaceError('FACE_SDK_BUSY');
  if (!initialized || !configuredForLiveness) throw new RegulaFaceError('FACE_NOT_INITIALIZED');
  if (consentAcknowledged !== true) throw new RegulaFaceError('FACE_CONSENT_REQUIRED');
  if (typeof tag !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tag)) throw new RegulaFaceError('FACE_SESSION_TAG_INVALID');
  running = true;
  try {
    const reader = await loadSdk();
    if (!await reader.isInitialized()) { initialized = false; throw new RegulaFaceError('FACE_NOT_INITIALIZED'); }
    const response = await reader.startLiveness({
      config: new sdk.LivenessConfig({
        tag, locationTrackingEnabled: false, preventScreenRecording: true,
        livenessType: sdk.LivenessType.ACTIVE,
        recordingProcess: sdk.RecordingProcess.SYNCHRONOUS_UPLOAD,
        ...(verificationId ? { metadata: { verificationId, challengeNonce: tag } } : {}),
      })
    });
    if (response?.error) throw safeError(response.error, 'liveness', 'FACE_LIVENESS_FAILED', sdk.LivenessErrorCode);
    if (!response || response.liveness !== sdk.LivenessStatus.PASSED) throw new RegulaFaceError('FACE_LIVENESS_UNCONFIRMED', 'liveness');
    if (typeof response.transactionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(response.transactionId) || response.tag !== tag) throw new RegulaFaceError('FACE_TRANSACTION_INVALID', 'liveness');
    // Do not expose the image, SDK score or raw error payload to UI/storage/logs.
    return { transactionId: response.transactionId.toLowerCase(), tag, captured: true, verified: false };
  } catch (error) {
    throw safeError(error, 'liveness', 'FACE_LIVENESS_FAILED', sdk?.LivenessErrorCode);
  } finally {
    running = false;
  }
}

export function getRegulaFaceState() {
  return { initialized, running, faceMatch: 'unverified', liveness: 'unverified' };
}

export function getLastSelfie() { return lastSelfie; }

export function resetRegulaFaceSession() {
  if (running) throw new RegulaFaceError('FACE_SDK_BUSY');
  lastSelfie = null;
  initialized = false;
  configuredForLiveness = false;
  const reader = sdk?.FaceSDK.instance;
  if (reader) { reader.requestHeaders = null; reader.deinitialize(); }
}

export async function initializeRegulaFaceLocal() {
  const reader = await loadSdk();
  if (await reader.isInitialized()) reader.deinitialize();
  reader.requestHeaders = null;
  configuredForLiveness = false;
  const [success, error] = await reader.initialize();
  if (!success) throw new RegulaFaceError('FACE_INITIALIZATION_FAILED');
  initialized = true;
  return { status: 'ready', note: 'Face SDK đã khởi tạo sẵn sàng.' };
}

export async function captureSelfieWithRegula() {
  const reader = await loadSdk();
  if (!await reader.isInitialized()) {
    await initializeRegulaFaceLocal();
  }
  const response = await reader.startFaceCapture();
  if (response?.image?.image) {
    lastSelfie = response.image.image;
    return { note: 'Đã chụp selfie thành công!' };
  }
  throw new RegulaFaceError('SELFIE_CANCELLED');
}

export async function matchFacesWithRegula(chipImageBase64, selfieImageBase64) {
  if (!chipImageBase64 || !selfieImageBase64) {
    throw new Error('Thiếu ảnh: Hãy chắc chắn bạn đã đọc chip CCCD và đã chụp selfie.');
  }
  const reader = await loadSdk();
  // Diagnostics also require an approved service; never upload to the SDK demo default.
  reader.serviceUrl = configuredService();
  reader.requestHeaders = null;

  const img1 = new sdk.MatchFacesImage(chipImageBase64, sdk.ImageType.PRINTED);
  const img2 = new sdk.MatchFacesImage(selfieImageBase64, sdk.ImageType.LIVE);

  const request = new sdk.MatchFacesRequest([img1, img2]);
  const response = await reader.matchFaces(request);

  const split = await reader.splitComparedFaces(response.results, 0.75);

  if (split.matchedFaces && split.matchedFaces.length > 0) {
    const similarity = Math.round(split.matchedFaces[0].similarity * 100);
    return { verified: false, note: `So khớp chẩn đoán: ${similarity}%. Chưa xác thực NFC hoặc Active Liveness; không cấp verified.` };
  } else {
    return { verified: false, note: 'So khớp chẩn đoán chưa đạt. Chưa xác minh danh tính.' };
  }
}