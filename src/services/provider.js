/** Mobile captures references; NestJS alone authenticates evidence and commits decisions. */
import * as Crypto from 'expo-crypto';
import {
  initializeRegulaDocument, scanDocumentWithRegula, readNfcWithRegula,
  getLastRfidPortrait, getLastDocImages, getNfcEvidence, configureRegulaServerSideVerification,
  refreshRegulaDocumentUploadGrant, finalizeRegulaDocumentPackage, resetRegulaDocumentSession,
} from './regulaDocument';
import { initializeRegulaFace, startRegulaLiveness, resetRegulaFaceSession } from './regulaFace';
import { verificationState } from '../domain/kyc';
import { api, getAuthHeaders } from './apiClient';

let activeVerificationId = null;
let pendingOperationId = null;
let pendingRestart = false;
let documentTransactionId = null;
let faceTransactionId = null;
let activeChallengeNonce = null;
let documentConfigured = false;
let documentGrantExpiresAt = null;
let documentCompleted = false;
let nfcCompleted = false;
let pendingNfcEvidence = null;
let chipChecks = null;
let faceCompleted = false;
let restartRequested = false;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class KycError extends Error {
  constructor(code, detail = '') { super(detail || code); this.code = code; }
}

function clearCapture() {
  resetRegulaDocumentSession();
  resetRegulaFaceSession();
  documentTransactionId = null;
  faceTransactionId = null;
  activeChallengeNonce = null;
  documentConfigured = false;
  documentGrantExpiresAt = null;
  documentCompleted = false;
  nfcCompleted = false;
  pendingNfcEvidence = null;
  chipChecks = null;
  faceCompleted = false;
}

async function ensureSession() {
  if (!activeVerificationId) {
    // Keep the same operation after an ambiguous/lost response.
    if (!pendingOperationId) {
      pendingOperationId = Crypto.randomUUID();
      pendingRestart = restartRequested;
    }
    const session = await api.post('/api/identity/verification/start', {
      operationId: pendingOperationId,
      ...(pendingRestart ? { restart: true } : {}),
    });
    if (!uuid.test(session?.verificationId || '')) throw new KycError('SESSION_MISSING');
    if (restartRequested && !pendingRestart) {
      // Recover the old start before requesting a separate fresh session.
      pendingOperationId = null;
      return ensureSession();
    }
    clearCapture();
    activeVerificationId = session.verificationId;
    pendingOperationId = null;
    pendingRestart = false;
    restartRequested = false;
  }
  const challenge = await api.get('/api/identity/verification/challenge');
  if (challenge?.verificationId !== activeVerificationId || !uuid.test(challenge?.challengeNonce || '')
    || (activeChallengeNonce && activeChallengeNonce !== challenge.challengeNonce)) {
    clearCapture();
    throw new KycError('SESSION_EXPIRED');
  }
  activeChallengeNonce = challenge.challengeNonce;
  return challenge;
}

async function setup(path) {
  const config = await api.post(path, { verificationId: activeVerificationId,
    ...(path.endsWith('/face/start') ? { consentAcknowledged: true } : {}) });
  if (config?.verificationId !== activeVerificationId || config?.challengeNonce !== activeChallengeNonce) {
    throw new KycError('SESSION_MISSING');
  }
  if (typeof config.serviceUrl !== 'string') throw new KycError('KYC_MOBILE_GATEWAY_NOT_CONFIGURED');
  if (path.endsWith('/document/start') || path.endsWith('/face/start')) {
    // Document SDK now authenticates to the independent Nginx upload proxy with a scoped grant.
    // Never copy the Supabase JWT to that origin.
    if (!/^Bearer [A-Za-z0-9._~-]+$/.test(config.httpHeaders?.Authorization || '')
      || config.httpHeaders?.['X-Kyc-Verification-Id'] !== activeVerificationId) {
      throw new KycError('KYC_UPLOAD_GRANT_INVALID');
    }
    const expiry = Date.parse(config.grantExpiresAt);
    if (!Number.isFinite(expiry) || expiry <= Date.now() + 5000) throw new KycError('KYC_UPLOAD_GRANT_INVALID');
    if (path.endsWith('/document/start')) documentGrantExpiresAt = expiry;
    return config;
  }
  const httpHeaders = await getAuthHeaders(config.serviceUrl);
  return { ...config, httpHeaders: { ...config.httpHeaders, ...httpHeaders } };
}

async function ensureFreshDocumentGrant() {
  if (!documentConfigured || !Number.isFinite(documentGrantExpiresAt)) throw new KycError('KYC_UPLOAD_GRANT_INVALID');
  if (documentGrantExpiresAt - Date.now() > 45_000) return;
  const config = await api.post('/api/identity/verification/document/transport-grant',
    { verificationId: activeVerificationId });
  if (config?.verificationId !== activeVerificationId || config?.challengeNonce !== activeChallengeNonce
    || !/^Bearer [A-Za-z0-9._~-]+$/.test(config?.httpHeaders?.Authorization || '')
    || config?.httpHeaders?.['X-Kyc-Verification-Id'] !== activeVerificationId) throw new KycError('KYC_UPLOAD_GRANT_INVALID');
  const expiry = Date.parse(config.grantExpiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now() + 5000) throw new KycError('KYC_UPLOAD_GRANT_INVALID');
  await refreshRegulaDocumentUploadGrant({ challengeNonce: activeChallengeNonce,
    serviceUrl: config.serviceUrl, httpHeaders: config.httpHeaders });
  documentGrantExpiresAt = expiry;
}

async function completeDocument() {
  if (documentCompleted) return;
  const result = await api.post('/api/identity/verification/document/complete', {
    verificationId: activeVerificationId, docTransactionId: documentTransactionId,
  }, { timeoutMs: 60000 });
  if (result?.verificationId !== activeVerificationId || result.completed !== true) throw new KycError('INVALID_RESPONSE');
  documentCompleted = true;
}

async function finalizeDocument() {
  if (!documentTransactionId) {
    await ensureFreshDocumentGrant();
    const transaction = await finalizeRegulaDocumentPackage();
    documentTransactionId = transaction.transactionId;
  }
  await completeDocument();
  const images = getLastDocImages();
  if (!images.back) throw new KycError('KYC_RESTART_REQUIRED');
  return { captured: true, verified: false, uri: `data:image/jpeg;base64,${images.back}`, images };
}

async function completeFace() {
  if (faceCompleted) return;
  const result = await api.post('/api/identity/verification/face/complete', {
    verificationId: activeVerificationId, faceTransactionId,
  }, { timeoutMs: 60000 });
  if (result?.verificationId !== activeVerificationId || result.completed !== true) throw new KycError('INVALID_RESPONSE');
  faceCompleted = true;
}

export const provider = {
  prepareDocumentReader() { return initializeRegulaDocument(); },
  async getStatus() {
    const result = await api.get('/api/identity/verification/status');
    const status = verificationState(result);
    const session = result?.session;
    let resumeStep = null;
    let requiresRestart = false;
    if (['verified', 'pending_review', 'retry_required', 'failed'].includes(status)) clearCapture();
    if (status === 'in_progress' && uuid.test(session?.verificationId || '') && !activeVerificationId) {
      const challenge = await api.get('/api/identity/verification/challenge');
      if (challenge?.verificationId !== session.verificationId || !uuid.test(challenge?.challengeNonce || '')) {
        throw new KycError('SESSION_EXPIRED');
      }
      clearCapture();
      activeVerificationId = session.verificationId;
      activeChallengeNonce = challenge.challengeNonce;
      if (session.documentCompleted === true && session.nfcCompleted === true && uuid.test(session.docTransactionId || '')) {
        documentTransactionId = session.docTransactionId;
        documentCompleted = true;
        nfcCompleted = true;
        chipChecks = session.chipChecks;
        resumeStep = 'face';
        if (session.faceCompleted === true && uuid.test(session.faceTransactionId || '')) {
          faceTransactionId = session.faceTransactionId;
          faceCompleted = true;
          resumeStep = 'finish';
        }
      } else {
        // Optical/NFC native SDK state cannot survive a process restart.
        requiresRestart = true;
      }
    } else if (status === 'in_progress' && activeVerificationId && !documentConfigured && !documentCompleted) {
      requiresRestart = true;
    }
    return { ...result, status, resumeStep, requiresRestart };
  },
  async inspectDocumentPhoto({ side }) {
    if (!['front', 'back'].includes(side)) throw new KycError('DOC_UNSUPPORTED');
    await ensureSession();
    const captured = getLastDocImages();
    if (side === 'back' && !documentCompleted && (documentTransactionId || (captured.front && captured.back))) {
      return finalizeDocument();
    }
    if (documentTransactionId || faceTransactionId) throw new KycError('KYC_RESTART_REQUIRED');
    await initializeRegulaDocument();
    if (!documentConfigured) {
      await configureRegulaServerSideVerification(await setup('/api/identity/verification/document/start'));
      documentConfigured = true;
    }
    await ensureFreshDocumentGrant();
    await scanDocumentWithRegula({ nextPage: side === 'back' });
    const images = getLastDocImages();
    const image = images[side];
    if (!image) throw new KycError('DOCUMENT_IMAGE_MISSING');
    if (side === 'back') {
      if (!images.front) throw new KycError('DOCUMENT_IMAGE_MISSING');
      return finalizeDocument();
    }
    return { captured: true, verified: false, uri: `data:image/jpeg;base64,${image}`, images };
  },
  async readAndAuthenticateNfc() {
    await ensureSession();
    if (!documentCompleted) throw new KycError('DOCUMENT_SERVER_SESSION_REQUIRED');
    if (!nfcCompleted && !pendingNfcEvidence) {
      const capture = await api.post('/api/identity/verification/nfc/start', { verificationId: activeVerificationId });
      if (capture?.verificationId !== activeVerificationId || !/^[a-f0-9]{16}$/.test(capture.challenge || '')) {
        throw new KycError('KYC_NFC_CHALLENGE_INVALID');
      }
      await readNfcWithRegula();
      pendingNfcEvidence = { verificationId: activeVerificationId, operationId: Crypto.randomUUID(),
        challenge: capture.challenge, ...getNfcEvidence() };
    }
    if (!nfcCompleted) {
      const result = await api.post('/api/identity/verification/nfc/complete', pendingNfcEvidence, { timeoutMs: 60000 });
      if (result?.verificationId !== activeVerificationId || result.completed !== true || result.checks?.pa !== 'passed') {
        throw new KycError('KYC_NFC_EVIDENCE_UNVERIFIED');
      }
      chipChecks = result.checks;
      nfcCompleted = true;
      pendingNfcEvidence = null;
    }
    const portrait = getLastRfidPortrait();
    return { captured: true, verified: false, transactionId: documentTransactionId,
      checks: chipChecks, antiCloningVerified: chipChecks?.aa === 'passed' || chipChecks?.ca === 'passed',
      portraitUri: portrait ? `data:image/jpeg;base64,${portrait}` : null };
  },
  async checkLivenessAndMatch({ consentAcknowledged } = {}) {
    if (!documentCompleted || !nfcCompleted) throw new KycError('DOCUMENT_SERVER_SESSION_REQUIRED');
    if (consentAcknowledged !== true) throw new KycError('FACE_CONSENT_REQUIRED');
    await ensureSession();
    if (!faceTransactionId) {
      await initializeRegulaFace(await setup('/api/identity/verification/face/start'));
      const result = await startRegulaLiveness({ tag: activeChallengeNonce,
        verificationId: activeVerificationId, consentAcknowledged: true });
      faceTransactionId = result.transactionId;
    }
    await completeFace();
    return { captured: true, verified: false, transactionId: faceTransactionId };
  },
  async submitToBackend() {
    if (!activeVerificationId || !documentCompleted || !nfcCompleted || !faceCompleted
      || !uuid.test(documentTransactionId || '') || !uuid.test(faceTransactionId || '')) {
      throw new KycError('KYC_PROVIDER_EVIDENCE_REQUIRED');
    }
    const result = await api.post('/api/identity/verification/submit-provider', {
      verificationId: activeVerificationId, docTransactionId: documentTransactionId, faceTransactionId,
    }, { timeoutMs: 60000 });
    if (!['verified', 'pending_review', 'retry_required', 'processing', 'failed'].includes(result?.status)) {
      throw new KycError('INVALID_RESPONSE');
    }
    if (['verified', 'pending_review', 'retry_required', 'failed'].includes(result.status)) clearCapture();
    return result;
  },
  restart() {
    clearCapture();
    activeVerificationId = null;
    // Preserve an unacknowledged start operation until its response is recovered.
    restartRequested = true;
  },
};
