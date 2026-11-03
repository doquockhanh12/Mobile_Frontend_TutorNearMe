import React, { useEffect, useRef, useState } from 'react';
import { Alert, Image, Linking, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { STEPS, STATUS, VERIFICATION_MESSAGES, createFlow, mayStart, maySubmit, setFlowResult, stepMessage } from './src/domain/kyc';
import { provider } from './src/services/provider';
import { finishEmailConfirmation, getSupabaseSession, signInWithEmail, signUpWithEmail, signOutCurrentDevice, subscribeToAuthChanges } from './src/auth/supabaseClient';
import { api } from './src/services/apiClient';

const C = {
  background: '#F8FAF8', card: '#FFFFFF', ink: '#1F2E26', subtle: '#64746B', line: '#E3EBE6',
  green: '#2A8E5C', greenBg: '#E9F8EF', greenBorder: '#A7DEBE',
  amber: '#A66E14', amberBg: '#FFF9EB', amberBorder: '#EFC971',
  neutral: '#F0F5F2',
};

const phaseInfo = {
  [STATUS.PASS]: { label: 'Hoàn thành', text: C.green, bg: C.greenBg, border: C.greenBorder, icon: '✓' },
  [STATUS.ERROR]: { label: 'Cần xử lý', text: C.amber, bg: C.amberBg, border: C.amberBorder, icon: '!' },
  [STATUS.RUNNING]: { label: 'Đang xử lý', text: C.subtle, bg: C.neutral, border: C.line, icon: '…' },
  [STATUS.WAITING]: { label: 'Chưa thực hiện', text: C.subtle, bg: C.neutral, border: C.line, icon: '○' },
};

function Pill({ record }) {
  const checks = record.evidence?.chipChecks;
  const incomplete = record.status === STATUS.PASS && checks && checks.aa !== 'passed' && checks.ca !== 'passed';
  const t = incomplete ? { ...phaseInfo[STATUS.ERROR], label: 'Chưa đủ bằng chứng' } : phaseInfo[record.status] || phaseInfo[STATUS.WAITING];
  return (
    <View style={[styles.pill, { backgroundColor: t.bg, borderColor: t.border }]}>
      <Text style={[styles.pillText, { color: t.text }]}>{t.icon} {t.label}</Text>
    </View>
  );
}

function ActionButton({ label, onPress, disabled, subtle, loading }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.action,
        subtle ? styles.actionSecondary : styles.actionPrimary,
        disabled && styles.actionDisabled,
      ]}
    >
      <Text style={[styles.actionText, subtle ? styles.actionTextSecondary : styles.actionTextPrimary]}>
        {loading ? 'Đang xử lý…' : label}
      </Text>
    </Pressable>
  );
}

function StepAccordionCard({
  item,
  record,
  index,
  isExpanded,
  onToggle,
  onExecute,
  busy,
  unlocked,
  consentAcknowledged,
  onConsentChange,
}) {
  const isPass = record.status === STATUS.PASS;
  const isError = record.status === STATUS.ERROR;
  const isRunning = record.status === STATUS.RUNNING;

  const cardBorder = isError ? C.amberBorder : isPass ? C.greenBorder : isExpanded ? C.green : C.line;
  const cardBg = isError ? C.amberBg : isPass ? (isExpanded ? '#FAFCFA' : C.greenBg) : C.card;

  return (
    <View style={[styles.stepCard, { borderColor: cardBorder, backgroundColor: cardBg }]}>
      {/* HEADER BẤM ĐỂ MỞ HOẶC THU NHỎ */}
      <Pressable
        accessibilityRole="button"
        onPress={onToggle}
        disabled={!unlocked && !isPass}
        style={styles.stepHeader}
      >
        <View style={styles.stepHeaderLeft}>
          <Text style={styles.stepNum}>BƯỚC {index + 1}</Text>
          <Text style={styles.stepTitle}>{item.name}</Text>
        </View>

        <View style={styles.stepHeaderRight}>
          <Pill record={record} />
          {(unlocked || isPass) && (
            <Text style={styles.chevron}>{isExpanded ? '▲' : '▼'}</Text>
          )}
        </View>
      </Pressable>

      {/* NỘI DUNG SỔ XUỐNG KHI ĐƯỢC CHỌN */}
      {isExpanded && (
        <View style={styles.stepBody}>
          <Text style={styles.stepDescription}>{item.summary}</Text>

          {/* LỖI NẾU CÓ */}
          {!!record.message && (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{record.message}</Text>
            </View>
          )}
          {item.id === 'nfc' && record.evidence?.chipChecks && ['pa', 'aa', 'ca'].map(check => (
            <Text key={check} style={styles.stepDescription}>
              {check.toUpperCase()}: {({ passed: 'Đạt', failed: 'Không đạt', not_supported: 'Thẻ không hỗ trợ', unverified: 'Chưa kiểm chứng' })[record.evidence.chipChecks[check]] || 'Chưa kiểm chứng'}
            </Text>
          ))}

          {/* 1 & 2: MẶT TRƯỚC / MẶT SAU CCCD */}
          {isPass && !record.evidence && <Text style={styles.photoSuccessHint}>Máy chủ đã tiếp nhận bước này trong phiên đang tiếp tục.</Text>}
          {(item.id === 'front' || item.id === 'back') && !(isPass && !record.evidence) && (
            <View style={styles.stepInner}>
              {record.evidence?.uri ? (
                <View style={styles.photoContainer}>
                  <Image source={{ uri: record.evidence.uri }} style={styles.photoPreview} resizeMode="contain" />
                  <Text style={styles.photoSuccessHint}>Đã chụp ảnh bằng SDK. Máy chủ chưa xác minh tính xác thực.</Text>
                  <ActionButton
                    label="Quét lại thẻ CCCD"
                    subtle
                    onPress={onExecute}
                    disabled={busy}
                    loading={isRunning}
                  />
                </View>
              ) : (
                <View style={styles.guideBox}>
                  <Text style={styles.guideText}>
                    Bấm nút bên dưới để mở máy quét Regula. Máy ảnh sẽ tự động căn chỉnh khung hình, lấy nét và chụp rõ 4 góc thẻ CCCD.
                  </Text>
                  <ActionButton
                    label={item.id === 'front' ? 'Bắt đầu quét mặt trước' : 'Bắt đầu quét mặt sau'}
                    onPress={onExecute}
                    disabled={busy || !unlocked}
                    loading={isRunning}
                  />
                </View>
              )}
            </View>
          )}

          {/* 3: ĐỌC CHIP NFC */}
          {item.id === 'nfc' && !(isPass && !record.evidence) && (
            <View style={styles.stepInner}>
              {record.evidence?.portraitUri ? (
                <View style={styles.photoContainer}>
                  <View style={styles.portraitWrapper}>
                    <Image source={{ uri: record.evidence.portraitUri }} style={styles.portraitPreview} />
                  </View>
                  <Text style={styles.photoSuccessHint}>Đã đọc ảnh từ chip. Máy chủ kiểm tra tính xác thực NFC.</Text>
                  <ActionButton
                    label="Đọc lại chip NFC"
                    subtle
                    onPress={onExecute}
                    disabled={busy}
                    loading={isRunning}
                  />
                </View>
              ) : (
                <View style={styles.guideBox}>
                  <Text style={styles.guideSymbol}>◉</Text>
                  <Text style={styles.guideText}>
                    Đặt thẻ CCCD tại vị trí anten NFC của điện thoại. Giữ yên thẻ tới khi SDK báo hoàn tất.
                  </Text>
                  <ActionButton
                    label="Bắt đầu đọc chip NFC"
                    onPress={onExecute}
                    disabled={busy || !unlocked}
                    loading={isRunning}
                  />
                </View>
              )}
            </View>
          )}

          {/* 4: KHUÔN MẶT VÀ LIVENESS */}
          {item.id === 'face' && !(isPass && !record.evidence) && (
            <View style={styles.stepInner}>
              {isPass && record.evidence?.transactionId ? (
                <View style={styles.photoContainer}>
                  <Text style={styles.photoSuccessHint}>Đã gửi giao dịch Liveness tới Regula. Chờ Backend đối chiếu chân dung chip NFC.</Text>
                  <ActionButton
                    label="Xác thực lại khuôn mặt"
                    subtle
                    onPress={onExecute}
                    disabled={busy}
                    loading={isRunning}
                  />
                </View>
              ) : (
                <View style={styles.guideBox}>
                  <Text style={styles.guideSymbol}>◌</Text>
                  <Text style={styles.guideText}>
                    Camera trước sẽ mở lên. Bạn hãy nhìn trực diện vào màn hình và giữ khuôn mặt trong khung để kiểm tra người thật và so khớp.
                  </Text>
                  <Pressable accessibilityRole="checkbox"
                    accessibilityState={{ checked: consentAcknowledged }}
                    onPress={() => onConsentChange(!consentAcknowledged)}>
                    <Text style={styles.guideText}>
                      {consentAcknowledged ? '☑' : '☐'} Tôi đồng ý sử dụng dữ liệu khuôn mặt để xác minh danh tính.
                    </Text>
                  </Pressable>
                  <ActionButton
                    label="Bắt đầu xác thực khuôn mặt"
                    onPress={onExecute}
                    disabled={busy || !unlocked || !consentAcknowledged}
                    loading={isRunning}
                  />
                </View>
              )}
            </View>
          )}

          {/* 5: KIỂM CHỨNG TỪ SERVER */}
          {item.id === 'finish' && (
            <View style={styles.stepInner}>
              <View style={styles.guideBox}>
                <Text style={styles.guideSymbol}>✓</Text>
                <Text style={styles.guideText}>
                  Gửi mã giao dịch để máy chủ kiểm tra chứng cứ. Kết quả có thể cần Admin xét duyệt hoặc yêu cầu thực hiện lại.
                </Text>
                <ActionButton
                  label={isPass ? 'Đã gửi xác minh thành công' : 'Gửi yêu cầu xác minh'}
                  onPress={onExecute}
                  disabled={busy || !unlocked || isPass}
                  loading={isRunning}
                />
              </View>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

export default function App() {
  const [flow, setFlow] = useState(createFlow);
  const [authReady, setAuthReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authNotice, setAuthNotice] = useState('');
  const [authMode, setAuthMode] = useState('login');
  const [displayName, setDisplayName] = useState('Learner kiểm thử');
  const [profileReady, setProfileReady] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [expandedStep, setExpandedStep] = useState('front');
  const [busy, setBusy] = useState(false);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [verificationStatus, setVerificationStatus] = useState('not_started');
  const [statusError, setStatusError] = useState('');
  const [resumeBlocked, setResumeBlocked] = useState(false);
  const [documentSdk, setDocumentSdk] = useState({status:'idle',code:null,sdkCode:null});
  const [sdkRetry, setSdkRetry] = useState(0);
  const active = useRef(false);
  const progress = STEPS.filter(s => flow[s.id].status === STATUS.PASS).length;
  const locked = ['verified', 'pending_review', 'processing', 'retry_required', 'failed'].includes(verificationStatus);
  const sdkEligible = authReady && authenticated && profileReady && !locked && !resumeBlocked;

  function mark(id, status, message = '', evidence = null) {
    setFlow(old => setFlowResult(old, id, status, message, evidence));
  }
  async function refreshStatus() {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    try {
      const result = await provider.getStatus();
      setVerificationStatus(result.status);
      setStatusError('');
      setProfileReady(true); setProfileError('');
      setResumeBlocked(result.requiresRestart === true);
      if (result.resumeStep) {
        let resumed = createFlow();
        for (const step of STEPS.slice(0, STEPS.findIndex(item => item.id === result.resumeStep))) {
          resumed = setFlowResult(resumed, step.id, STATUS.PASS, 'Máy chủ đã tiếp nhận giao dịch của phiên này.',
            step.id === 'nfc' && result.session?.chipChecks ? { chipChecks: result.session.chipChecks } : null);
        }
        setFlow(resumed);
        setExpandedStep(result.resumeStep);
      }
      if (result.status === 'verified' || result.status === 'pending_review') setFlow(createFlow());
    } catch (error) {
      if ([403, 404].includes(error?.status)) setProfileReady(false);
      setStatusError(stepMessage('finish', error?.code || 'NETWORK_ERROR'));
    } finally { active.current = false; setBusy(false); }
  }
  useEffect(() => {
    let mounted = true;
    const unsubscribe = subscribeToAuthChanges((_event, session) => {
      if (mounted) { setAuthenticated(!!session); setAuthReady(true); }
    });
    getSupabaseSession().then(session => {
      if (mounted) { setAuthenticated(!!session); setAuthReady(true); }
    }).catch(() => {
      if (mounted) { setAuthenticated(false); setAuthReady(true); }
    });
    return () => { mounted = false; unsubscribe(); };
  }, []);

  // Only process native Supabase email confirmation links for this application.
  // Never log the link: it may carry a short-lived PKCE authorization code.
  useEffect(() => {
    let mounted = true;
    const accept = async (url) => {
      try {
        const accepted = await finishEmailConfirmation(url);
        if (accepted && mounted) {
          setAuthNotice('Đã xử lý liên kết xác nhận email.');
          setAuthError('');
        }
      } catch (error) {
        if (mounted) {
          setAuthError('Không hoàn tất liên kết email trên thiết bị này: ' +
            (['EMAIL_CONFIRMATION_FAILED', 'EMAIL_CONFIRMATION_CODE_MISSING',
              'EMAIL_CONFIRMATION_EXCHANGE_FAILED'].includes(error?.message)
              ? error.message : 'EMAIL_CALLBACK_ERROR') + '. Hãy đăng nhập bằng email và mật khẩu.');
        }
      }
    };
    const subscription = Linking.addEventListener('url', ({ url }) => { void accept(url); });
    Linking.getInitialURL().then(url => { if (url && mounted) void accept(url); }).catch(() => {});
    return () => { mounted = false; subscription.remove(); };
  }, []);

  useEffect(() => {
    if (authReady && authenticated) void refreshStatus();
  }, [authReady, authenticated]);

  useEffect(() => {
    if (!sdkEligible) return;
    let mounted = true;
    setDocumentSdk({status:'loading',code:null,sdkCode:null});
    provider.prepareDocumentReader().then(() => {
      if (mounted) setDocumentSdk({status:'ready',code:null,sdkCode:null});
    }).catch(error => {
      if (mounted) setDocumentSdk({status:'error',code:typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : 'REGULA_INITIALIZATION_FAILED',sdkCode:Number.isInteger(error?.sdkCode) ? error.sdkCode : null});
    });
    return () => { mounted = false; };
  }, [sdkEligible,sdkRetry]);

  async function createAuthAccount() {
    if (authBusy || !email.trim() || password.length < 8) return;
    setAuthBusy(true); setAuthError(''); setAuthNotice('');
    try {
      const result = await signUpWithEmail(email.trim(), password);
      setPassword('');
      if (!result.userCreated) throw new Error('SIGNUP_NOT_CONFIRMED');
      if (result.session) {
        setAuthenticated(true);
        setAuthNotice('Đã tạo phiên đăng nhập. Tiếp tục hoàn thiện hồ sơ Learner.');
      } else {
        setAuthMode('login');
        setAuthNotice('Yêu cầu đăng ký đã gửi. Nếu Supabase yêu cầu xác nhận email, hãy mở thư rồi đăng nhập.');
      }
    } catch (error) {
      setAuthError('Đăng ký Supabase thất bại: ' + (typeof error?.code === 'string' && /^[a-z_]{3,64}$/.test(error.code) ? error.code : 'UNKNOWN_SIGNUP_ERROR') + '. Kiểm tra cấu hình Staging và email.');
    } finally { setAuthBusy(false); }
  }

  async function registerLearner() {
    if (profileBusy || busy || displayName.trim().length < 2 || displayName.trim().length > 150) return;
    setProfileBusy(true); setProfileError('');
    try {
      const result = await api.post('/api/auth/register/learner', { displayName: displayName.trim() });
      if (result?.user?.role !== 'learner') throw new Error('ROLE_UNCONFIRMED');
      setProfileReady(true);
      await refreshStatus();
    } catch (error) {
      setProfileError(error?.code === 'AUTH_SESSION_INVALID'
        ? 'Phiên Supabase hợp lệ nhưng AUTH-02 chưa chấp nhận. Cần bật Custom Access Token Hook cho Staging, rồi đăng xuất và đăng nhập lại.'
        : 'Chưa tạo được hồ sơ Learner: ' + (error?.code || 'REGISTRATION_UNAVAILABLE') + '. Kiểm tra session Staging.');
    } finally { setProfileBusy(false); }
  }

  async function login() {
    if (authBusy || !email.trim() || !password) return;
    setAuthBusy(true); setAuthError(''); setAuthNotice('');
    try {
      const result = await signInWithEmail(email.trim(), password);
      setPassword('');
      if (!result?.session) throw new Error('SESSION_NOT_AVAILABLE');
      setAuthenticated(true);
    } catch (error) {
      setAuthError('Đăng nhập không thành công: ' + (typeof error?.code === 'string' && /^[a-z_]{3,64}$/.test(error.code) ? error.code : 'LOGIN_FAILED') + '. Kiểm tra email và tài khoản Staging.');
    } finally { setAuthBusy(false); }
  }

  async function logout() {
    if (busy || authBusy) return;
    setAuthBusy(true); setAuthError('');
    try {
      await signOutCurrentDevice();
      provider.restart();
      setFlow(createFlow()); setConsentAccepted(false);
      setVerificationStatus('not_started'); setAuthenticated(false);
      setProfileReady(false); setProfileError(''); setAuthNotice('');
    } catch {
      setAuthError('Không thể đăng xuất khỏi thiết bị. Vui lòng thử lại.');
    } finally { setAuthBusy(false); }
  }

  async function handleExecute(stepId) {
    if (active.current || locked || documentSdk.status !== 'ready' || !mayStart(flow, stepId)) return;
    active.current = true;
    setBusy(true);
    mark(stepId, STATUS.RUNNING);
    setStatusError('');
    try {
      let result;
      const stepIndex = STEPS.findIndex(s => s.id === stepId);
      if (stepId === 'front' || stepId === 'back') {
        result = await provider.inspectDocumentPhoto({ side: stepId });
        if (result?.captured !== true) throw new Error('UNTRUSTED_RESULT');
        mark(stepId, STATUS.PASS, 'Ảnh đã chụp; chờ máy chủ kiểm tra.', { uri: result.uri });
        setVerificationStatus('in_progress');
      } else if (stepId === 'nfc') {
        result = await provider.readAndAuthenticateNfc();
        if (!result?.transactionId) throw new Error('UNTRUSTED_RESULT');
        mark('nfc', STATUS.PASS, result.antiCloningVerified
          ? 'Máy chủ đã kiểm tra bằng chứng chip; chờ Liveness và quyết định danh tính.'
          : 'Dữ liệu và ảnh chip đã qua PA. AA/CA chống sao chép chưa được kiểm chứng; phiên này chưa đủ điều kiện VERIFIED.', {
          transactionId: result.transactionId, portraitUri: result.portraitUri, chipChecks: result.checks,
        });
      } else if (stepId === 'face') {
        result = await provider.checkLivenessAndMatch({ consentAcknowledged: consentAccepted });
        if (!result?.transactionId) throw new Error('UNTRUSTED_RESULT');
        mark('face', STATUS.PASS, 'Đã tiếp nhận giao dịch Liveness; chờ quyết định của máy chủ.', {
          transactionId: result.transactionId,
        });
      } else if (stepId === 'finish') {
        if (!maySubmit(flow)) throw new Error('UNTRUSTED_RESULT');
        setVerificationStatus('processing');
        result = await provider.submitToBackend();
        setVerificationStatus(result.status);
        if (result.status === 'verified' || result.status === 'pending_review') {
          setFlow(createFlow());
          setExpandedStep(null);
        } else {
          mark('finish', result.status === 'processing' ? STATUS.RUNNING : STATUS.ERROR,
            result.reasonCode ? stepMessage('finish', result.reasonCode) : VERIFICATION_MESSAGES[result.status]);
        }
        return;
      }
      setExpandedStep(STEPS[stepIndex + 1]?.id || null);
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : 'PROVIDER_UNAVAILABLE';
      const extra = Number.isInteger(error?.sdkCode) ? `; SDK ${error.sdkCode}` : '';
      const fields = __DEV__ && error?.status === 400 && Array.isArray(error.validationFields) && error.validationFields.length
        ? ` Trường: ${error.validationFields.join(', ')}.` : '';
      const request = error?.requestId ? ` Mã yêu cầu: ${error.requestId}.` : '';
      const message = `${stepMessage(stepId, code)} (Mã: ${code}${extra})${fields}${request}`;
      mark(stepId, STATUS.ERROR, message);
      setStatusError(message);
      if (stepId === 'finish') {
        try {
          const current = await provider.getStatus();
          setVerificationStatus(current.status);
          if (['verified', 'pending_review'].includes(current.status)) { setFlow(createFlow()); setStatusError(''); }
        } catch { setVerificationStatus('processing'); }
      }
      if (['SESSION_EXPIRED', 'KYC_RESTART_REQUIRED'].includes(error?.code)) setVerificationStatus('failed');
    } finally { active.current = false; setBusy(false); }
  }
  function restart() {
    if (active.current) return;
    Alert.alert('Bắt đầu phiên mới?', 'Ảnh và giao dịch trên điện thoại sẽ được xóa. Máy chủ áp dụng thời gian chờ và giới hạn thử lại.', [
      { text: 'Hủy', style: 'cancel' },
      {
        text: 'Bắt đầu lại', onPress: () => {
          provider.restart();
          setFlow(createFlow());
          setConsentAccepted(false);
          setVerificationStatus('not_started');
          setStatusError('');
          setResumeBlocked(false);
          setExpandedStep('front');
        }
      },
    ]);
  }
  if (!authReady) return <SafeAreaView style={styles.safe}><Text style={styles.lead}>Đang kiểm tra phiên đăng nhập…</Text></SafeAreaView>;
  if (!authenticated) return <SafeAreaView style={styles.safe}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}>
      <Text style={styles.brand}>TutorNearMe Verify</Text>
      <Text style={styles.headline}>{authMode === 'signup' ? 'Tạo tài khoản Learner' : 'Đăng nhập để kiểm thử eKYC'}</Text>
      <Text style={styles.lead}>Chỉ sử dụng tài khoản Supabase Staging. Mật khẩu được gửi trực tiếp tới Supabase Auth, không ghi vào source code hoặc log ứng dụng.</Text>
      <TextInput accessibilityLabel="Email" autoCapitalize="none" keyboardType="email-address"
        autoComplete="email" value={email} onChangeText={setEmail}
        placeholder="Email" style={styles.authInput} editable={!authBusy} />
      <TextInput accessibilityLabel="Mật khẩu" autoCapitalize="none" secureTextEntry
        autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'} value={password} onChangeText={setPassword}
        placeholder="Mật khẩu" style={styles.authInput} editable={!authBusy} />
      {!!authError && <Text role="alert" style={styles.errorText}>{authError}</Text>}
      {!!authNotice && <Text role="status" style={styles.photoSuccessHint}>{authNotice}</Text>}
      <ActionButton label={authMode === 'signup' ? 'Tạo tài khoản trên Staging' : 'Đăng nhập Staging'}
        disabled={authBusy || !email.trim() || password.length < (authMode === 'signup' ? 8 : 1)}
        loading={authBusy} onPress={authMode === 'signup' ? createAuthAccount : login} />
      <ActionButton label={authMode === 'login' ? 'Chưa có tài khoản? Đăng ký Learner' : 'Đã có tài khoản? Đăng nhập'}
        subtle disabled={authBusy} onPress={() => { setAuthMode(authMode === 'login' ? 'signup' : 'login'); setAuthError(''); setAuthNotice(''); }} />
    </ScrollView>
  </SafeAreaView>;
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}>
        <Text style={styles.brand}>TutorNearMe <Text style={{ color: C.green }}>Verify</Text></Text>
        <ActionButton label="Đăng xuất thiết bị" onPress={logout} disabled={busy || authBusy}
          subtle loading={authBusy} />
        <Text style={styles.headline}>Xác minh danh tính</Text>
        {!profileReady && !busy && <View style={styles.guideBox}>
          <Text style={styles.stepTitle}>Hoàn thiện hồ sơ Learner trên Staging</Text>
          <Text style={styles.guideText}>Lần đầu đăng nhập, bạn phải đăng ký vai trò Learner trước khi sử dụng eKYC. Nếu đã có hồ sơ, hãy thử tải lại trạng thái.</Text>
          <TextInput accessibilityLabel="Tên hiển thị Learner" value={displayName}
            onChangeText={setDisplayName} editable={!profileBusy} maxLength={150}
            placeholder="Tên hiển thị" style={styles.authInput} />
          {!!profileError && <Text role="alert" style={styles.errorText}>{profileError}</Text>}
          <ActionButton label="Hoàn thiện hồ sơ Learner" onPress={registerLearner}
            disabled={profileBusy || displayName.trim().length < 2 || displayName.trim().length > 150}
            loading={profileBusy} />
        </View>}
        <Text style={styles.lead}>Quét CCCD, đọc chip NFC và thực hiện Active Liveness. Máy chủ kiểm chứng và trả trạng thái xác minh.</Text>
        <View style={styles.guideBox}>
          <Text accessibilityLiveRegion="polite" style={styles.guideText}>{VERIFICATION_MESSAGES[verificationStatus]}</Text>
          {!!statusError && <Text style={styles.errorText}>{statusError}</Text>}
          {resumeBlocked && <Text style={styles.errorText}>Không thể khôi phục trạng thái máy quét của phiên cũ. Hãy bắt đầu phiên mới để nhận challenge mới.</Text>}
          <ActionButton label="Kiểm tra trạng thái / tiếp tục phiên" onPress={refreshStatus} disabled={busy} subtle />
        </View>
        {sdkEligible && <View style={styles.guideBox}>
          <Text style={styles.stepTitle}>Regula Document Reader</Text>
          {['idle','loading'].includes(documentSdk.status) && <Text style={styles.guideText}>Đang chuẩn bị license, database và SDK…</Text>}
          {documentSdk.status === 'ready' && <Text style={styles.photoSuccessHint}>SDK đã sẵn sàng. Có thể quét CCCD.</Text>}
          {documentSdk.status === 'error' && <>
            <Text role="alert" style={styles.errorText}>{stepMessage('front',documentSdk.code)} (Mã: {documentSdk.code}{documentSdk.sdkCode === null ? '' : `; SDK ${documentSdk.sdkCode}`})</Text>
            <ActionButton label="Thử tải SDK lại" onPress={() => setSdkRetry(n => n + 1)} disabled={busy} subtle />
          </>}
        </View>}
        {sdkEligible && documentSdk.status === 'ready' && <>
          <View style={styles.progressHeader}><Text style={styles.progressTitle}>Tiến độ thu thập chứng cứ</Text><Text style={styles.progressCount}>{progress}/{STEPS.length} bước</Text></View>
          <View style={styles.progressBar}><View style={[styles.progressFill, { width: (progress / STEPS.length * 100) + '%' }]} /></View>
          {STEPS.map((step, index) => <StepAccordionCard
            key={step.id} item={step} index={index} record={flow[step.id]}
            isExpanded={expandedStep === step.id}
            onToggle={() => setExpandedStep(expandedStep === step.id ? null : step.id)}
            onExecute={() => handleExecute(step.id)} busy={busy}
            unlocked={mayStart(flow, step.id)} consentAcknowledged={consentAccepted}
            onConsentChange={setConsentAccepted}
          />)}
        </>}
        {profileReady && !['verified', 'pending_review', 'processing'].includes(verificationStatus) && <ActionButton label="Bắt đầu phiên mới" onPress={restart} disabled={busy} subtle />}
        <Text style={styles.lead}>Ảnh xem trước và kết quả SDK không cấp trạng thái verified. Chỉ kết quả máy chủ sau khi lưu thành công mới xác minh tài khoản.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.background }, page: { padding: 20, paddingBottom: 48 },
  authInput: { borderWidth: 1, borderColor: C.line, backgroundColor: C.card, color: C.ink, borderRadius: 10, padding: 14, marginTop: 12, fontSize: 16 },
  brand: { color: C.ink, fontSize: 17, fontWeight: '800', marginTop: 16 },
  headline: { fontSize: 29, fontWeight: '800', color: C.ink, marginTop: 20 },
  lead: { fontSize: 14, lineHeight: 22, color: C.subtle, marginTop: 10, marginBottom: 20 },
  progressHeader: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 20 },
  progressTitle: { color: C.ink, fontWeight: '700' }, progressCount: { color: C.subtle },
  progressBar: { height: 6, borderRadius: 3, backgroundColor: C.line, marginTop: 10, marginBottom: 20 },
  progressFill: { height: 6, borderRadius: 3, backgroundColor: C.green },
  stepCard: { borderWidth: 1, borderRadius: 16, marginBottom: 14, overflow: 'hidden' },
  stepHeader: { padding: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  stepHeaderLeft: { flex: 1 }, stepHeaderRight: { alignItems: 'flex-end', gap: 8 },
  stepNum: { fontSize: 10, fontWeight: '800', color: C.subtle, letterSpacing: 1 },
  stepTitle: { fontSize: 17, fontWeight: '700', color: C.ink, marginTop: 6 }, chevron: { color: C.subtle, fontSize: 11 },
  stepBody: { padding: 18, paddingTop: 0 }, stepDescription: { color: C.subtle, lineHeight: 21 },
  stepInner: { marginTop: 16 }, pill: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5 },
  pillText: { fontSize: 11, fontWeight: '700' }, errorBox: { marginTop: 12 }, errorText: { color: C.amber, lineHeight: 21 },
  guideBox: { backgroundColor: C.neutral, borderRadius: 12, padding: 16 }, guideText: { color: C.ink, fontSize: 14, lineHeight: 22 },
  guideSymbol: { fontSize: 36, color: C.green, marginBottom: 12 },
  action: { minHeight: 48, justifyContent: 'center', alignItems: 'center', padding: 14, borderRadius: 10, marginTop: 14 },
  actionPrimary: { backgroundColor: C.green }, actionSecondary: { backgroundColor: C.neutral, borderWidth: 1, borderColor: C.line },
  actionDisabled: { opacity: 0.5 }, actionText: { fontSize: 14, fontWeight: '700', textAlign: 'center' },
  actionTextPrimary: { color: '#FFFFFF' }, actionTextSecondary: { color: C.ink },
  photoContainer: { alignItems: 'stretch' }, photoPreview: { width: '100%', height: 190, borderRadius: 10 },
  photoSuccessHint: { color: C.subtle, lineHeight: 21, marginTop: 12 }, portraitWrapper: { alignItems: 'center' },
  portraitPreview: { width: 100, height: 130, borderRadius: 12 },
});
