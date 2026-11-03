import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlow, setFlowResult, mayStart, maySubmit, STATUS, stepMessage, verificationState } from '../src/domain/kyc.js';

test('cannot skip identity stages',()=>{const f=createFlow();assert.equal(mayStart(f,'nfc'),false);assert.equal(maySubmit(f),false);});
test('completed stages unlock next',()=>{let f=createFlow();f=setFlowResult(f,'front',STATUS.PASS);assert.equal(mayStart(f,'back'),true);assert.equal(mayStart(f,'nfc'),false);});
test('retrying a preceding stage invalidates all downstream evidence',()=>{let f=createFlow();for(const id of ['front','back','nfc','face']) f=setFlowResult(f,id,STATUS.PASS,'',{id});assert.equal(maySubmit(f),true);f=setFlowResult(f,'back',STATUS.ERROR,'Blur');assert.equal(maySubmit(f),false);assert.equal(f.nfc.status,STATUS.WAITING);assert.equal(f.face.status,STATUS.WAITING);});
test('has specific actionable messages',()=>{for(const code of ['PHOTO_BLUR','PHOTO_GLARE','NFC_TIMEOUT','LIVENESS_FAILED','FACE_MISMATCH','NETWORK_ERROR'])assert.ok(stepMessage('front',code).length>15);});
test('only committed backend status is verified; sessions map to honest waiting/retry states', () => {
  assert.equal(verificationState({ status: 'verified', session: { status: 'in_progress' } }), 'verified');
  for (const [state, expected] of [['in_progress', 'in_progress'], ['submitted', 'pending_review'], ['rejected', 'retry_required'], ['expired', 'failed'], ['processing', 'processing']]) {
    assert.equal(verificationState({ status: 'unverified', session: { status: state } }), expected);
  }
  assert.equal(verificationState({ status: 'unverified' }), 'not_started');
  assert.equal(verificationState({ captured: true, verified: true }), 'not_started');
});
