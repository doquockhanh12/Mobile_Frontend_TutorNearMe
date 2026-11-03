# TutorNearMe Verify — mobile KYC foundation

This package is intended to be copied to `IE106_tutor_near_me/apps/mobile`. It does NOT overwrite `apps/web` or `apps/api`.

## Run UI and camera

From `apps/mobile`:

```sh
npm install
npx expo install --fix
npm run test
npx expo start
```

Expo Go can run camera preview. RFID/NFC and Regula require development build and proper native setup; do not claim NFC is working in Expo Go.

The mobile app explicitly fails closed on every provider check until Regula SDK and NestJS trusted-evidence verification are integrated. Capturing a photo is NOT considered successful OCR/identity verification.

To use Regula's current unified JS integration, refer to its official installation guides before adding plugins. Some deprecated React Native packages should not be installed by default. For mobile iOS NFC test, use Apple developer signing, provisioning and native build as required.

## Required external inputs
1. License capabilities for Document Reader with Vietnamese CCCD NFC, and Face SDK + liveness; bundled license may require coordinated Regula permissions.
2. Regula SDK API version, model/database and compatible dev build; actual contract of quality checks.
3. NestJS API deployment reachable on iPhone, mobile authentication, and authenticated verification-session endpoints.
4. Consent/privacy policy, compliance review, trusted certificates and security validation.

Read `docs/PRODUCTION_GATES.md` before treating this as a real KYC product.

## Face capture preparation (2026-10-12)

`src/services/regulaFace.js` uses the native Regula Face SDK and Core Basic. It is separate from the existing Document Reader/NFC diagnostic and does not change the product's verified state. Core Basic initializes without a mobile license file; the Face Web Service still needs its own licensing/configuration. Configure the approved HTTPS endpoint at build time through `EXPO_PUBLIC_REGULA_FACE_URL`, then call `initializeRegulaFace()`. Never bundle a server license or credentials in Mobile. There is no caller-supplied endpoint, default demo URL, token/biometric logging, public image output or `trustedEvidenceId`.

`startRegulaLiveness({ tag, consentAcknowledged: true })` requests active liveness and returns only a transaction reference, correlation tag and `verified: false`. The caller must show an appropriate biometric disclosure and obtain consent before capture; a boolean does not replace the privacy policy. The server must provision and independently authenticate/bind that transaction; an echoed tag alone does not prove account ownership. Matching must use the portrait from authenticated NFC data and the selfie from that same server-validated liveness transaction. The native adapter does not approve either check for account verification. Provider gateway authentication, storage/retention and deployment readiness still need verification before enabling capture in the product flow.

The main KYC flow intentionally remains fail-closed while its trusted provider is unavailable. Face capture is not yet wired into that flow. Source/unit tests exercise SDK protocol and safe failures, **not** real CCCD/Face acceptance. A configured licensed server and a native development build on physical hardware are required before enabling the flow.

At the start of preparation, worktree `e428` had no ignored `assets/licenses/` directory, installed dependencies or `adb` in PATH. This historical observation does not describe the main workspace; readiness must be verified separately without reading or copying secrets/license contents. Do not copy secrets or change another running worktree to make tests pass.
