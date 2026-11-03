import React, { useRef, useState } from 'react';
import { SafeAreaView, ScrollView, View, Text, Pressable, StyleSheet } from 'react-native';
import {
  initializeRegulaDocument,
  scanDocumentWithRegula,
  readNfcWithRegula,
  getRegulaDiagnosticState,
  getLastRfidPortrait
} from '../services/regulaDocument';

import {
  initializeRegulaFaceLocal,
  captureSelfieWithRegula,
  matchFacesWithRegula,
  getLastSelfie
} from '../services/regulaFace';

const palette = { bg: '#F7FAF8', fg: '#223C2C', success: '#27814D', successBg: '#E8F7EE', warning: '#9B6B13', warningBg: '#FFF7DE', border: '#C3DEC9' };
const actions = [
  { id: 'init', title: '1. Kích hoạt Regula và database', execute: initializeRegulaDocument },
  { id: 'scan', title: '2. Mở scanner CCCD thật', execute: scanDocumentWithRegula },
  { id: 'nfc', title: '3. Đọc NFC thật trên Android', execute: readNfcWithRegula },
  { id: 'initFace', title: '4. Kích hoạt Face SDK', execute: initializeRegulaFaceLocal },
  { id: 'selfie', title: '5. Chụp Selfie khuôn mặt', execute: captureSelfieWithRegula },
  {
    id: 'match',
    title: '6. So khớp CCCD vs Selfie',
    execute: () => matchFacesWithRegula(getLastRfidPortrait(), getLastSelfie())
  },
];
const labels = {
  ANDROID_REQUIRED: 'Diagnostic này cần thiết bị Android.',
  LICENSE_READ_FAILED: 'Không đọc được license trên thiết bị. Kiểm tra asset và quyền truy cập.',
  OPERATION_CANCELLED: 'Người dùng đã hủy thao tác; chưa có kết quả hoàn tất.',
  OPERATION_TIMEOUT: 'SDK đã hết thời gian xử lý; hãy thử lại.',
  OPERATION_FAILED: 'SDK báo thao tác thất bại.',
  EMPTY_RESULT: 'SDK hoàn tất nhưng không trả kết quả.',
  NFC_NOT_LICENSED: 'License hiện tại không cấp quyền RFID/NFC.',
  NFC_UNAVAILABLE: 'SDK chưa thể sử dụng NFC. Kiểm tra phần cứng, cài đặt NFC và quyền license.',
  REGULA_CAMERA_NO_PERMISSION: 'Chưa cấp quyền camera. Bật quyền trong cài đặt ứng dụng.',
  REGULA_CAMERA_NOT_AVAILABLE: 'Camera không khả dụng trên thiết bị.',
  REGULA_LICENSE_ABSENT_OR_CORRUPTED: 'License thiếu hoặc bị hỏng.',
  REGULA_LICENSE_INVALID_DATE: 'License hết hạn hoặc ngày giờ thiết bị không đúng.',
  REGULA_LICENSE_INVALID_DEVICE_ID: 'License không khớp thiết bị này.',
  REGULA_LICENSE_INVALID_SYSTEM_OR_APP_ID: 'License không khớp hệ điều hành hoặc app ID.',
  REGULA_LICENSE_NO_CAPABILITIES: 'License không cấp quyền cho thao tác này.',
  REGULA_LICENSE_NO_AUTHENTICITY: 'License không cấp quyền kiểm tra tính xác thực.',
  REGULA_INCORRECT_SCENARIO: 'Scenario không được license hoặc Core SDK hỗ trợ.',
  REGULA_RFID_ERROR: 'SDK báo lỗi RFID/NFC. Callback UI không cung cấp mã RFID chi tiết; không thể kết luận nguyên nhân hoặc tính xác thực chip.',
  NATIVE_SDK_UNAVAILABLE: 'Chưa dùng Development Build chứa native Regula SDK.',
  LICENSE_NOT_FOUND: 'Không tìm thấy file license trong assets/licenses.',
  LICENSE_EMPTY: 'License trống.',
  LICENSE_OR_INIT_FAILED: 'Không thể kích hoạt SDK. Kiểm tra license và quyền cấp phép.',
  DOCUMENT_DB_FAILED: 'Không tải/chuẩn bị được database Regula. Kiểm tra mạng và license.',
  NOT_INITIALIZED: 'Vui lòng kích hoạt Regula trước.',
  SCAN_REQUIRED_BEFORE_NFC: 'Hãy quét CCCD trước khi thử NFC.',
  DOCUMENT_SCAN_ERROR: 'Quét CCCD lỗi. Thử lại với giấy tờ rõ nét.',
  DOCUMENT_SCAN_NOT_COMPLETED: 'Chưa hoàn tất quét CCCD. Có thể bạn đã hủy hoặc hết thời gian.',
  NFC_READ_ERROR: 'Đọc NFC thất bại. Kiểm tra NFC và giữ thẻ đúng vị trí anten.',
  NFC_READ_NOT_COMPLETED: 'Chưa hoàn tất đọc NFC. Hãy đặt thẻ gần anten và thử lại.',
  SDK_BUSY: 'SDK đang thực hiện tác vụ khác.',
  REGULA_INITIALIZATION_FAILED: 'Khởi tạo SDK thất bại. Kiểm tra Development Build.',
};

export default function RegulaDiagnostics() {
  const [state, setState] = useState({});
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  const active = useRef(false);
  const [diagnostic, setDiagnostic] = useState(getRegulaDiagnosticState);
  async function run(action) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setState(prev => ({ ...prev, ...(action.id === 'init' ? { scan: undefined, nfc: undefined } : action.id === 'scan' ? { nfc: undefined } : {}), [action.id]: { kind: 'running', text: 'Đang thực hiện…' } }));
    try {
      const result = await action.execute();
      setState(prev => ({ ...prev, [action.id]: { kind: 'ok', text: result?.note || 'SDK đã khởi tạo thành công.' } }));
    } catch (err) {
      const sdkDetail = Number.isInteger(err?.sdkCode) ? ` (${err.phase}: ${err.code}, SDK ${err.sdkCode})` : '';
      setState(prev => ({ ...prev, [action.id]: { kind: 'error', text: (labels[err?.code] || 'SDK chưa hoàn tất thao tác. Kiểm tra mã lỗi và thử lại.') + sdkDetail } }));
    } finally { setDiagnostic(getRegulaDiagnosticState()); active.current = false; setBusy(false); }
  }
  return <SafeAreaView style={s.page}><ScrollView contentContainerStyle={s.content}>
    <Text style={s.heading}>Kiểm thử Regula Android</Text>
    <Text style={s.desc}>Chế độ chẩn đoán không xác minh danh tính. So khớp thử nghiệm gửi ảnh khuôn mặt tới dịch vụ FaceAPI đã cấu hình; kết quả không chứng minh NFC hoặc Active Liveness đã đạt.</Text>
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: consent }} onPress={() => setConsent(!consent)}>
      <Text style={s.message}>{consent ? '☑' : '☐'} Tôi đồng ý xử lý ảnh khuôn mặt cho phép thử chẩn đoán này.</Text>
    </Pressable>
    {actions.map(a => {
      const status = state[a.id] || { kind: 'waiting', text: 'Chưa thực hiện' };
      const error = status.kind === 'error';
      const disabled = busy || (['selfie', 'match'].includes(a.id) && !consent) || (a.id !== 'init' && !diagnostic.initialized) || (a.id === 'nfc' && !diagnostic.opticalScanCompleted);
      return <View key={a.id} style={[s.card, { borderColor: error ? '#E9C777' : status.kind === 'ok' ? palette.border : '#DEE9E0', backgroundColor: error ? palette.warningBg : status.kind === 'ok' ? palette.successBg : '#FFF' }]}>
        <Text style={s.title}>{a.title}</Text>
        <Text accessibilityLiveRegion="polite" style={[s.message, { color: error ? palette.warning : status.kind === 'ok' ? palette.success : '#67756A' }]}>{status.text}</Text>
        <Pressable disabled={disabled} accessibilityRole="button" accessibilityState={{ disabled }} onPress={() => run(a)} style={[s.button, disabled && { opacity: .5 }]}>
          <Text style={s.buttonText}>{error ? 'Thử lại bước này' : status.kind === 'ok' ? 'Chạy lại' : 'Bắt đầu'}</Text>
        </Pressable>
      </View>;
    })}
    <Text style={s.title}>Quyền và bằng chứng hiện có</Text>
    <Text style={s.message}>Vietnamese CCCD: chưa xác minh quyền license và mẫu giấy tờ được hỗ trợ.</Text>
    <Text style={s.message}>License NFC: {diagnostic.capabilities.nfcLicense === 'licensed' ? 'SDK báo có quyền RFID' : diagnostic.capabilities.nfcLicense === 'not_licensed' ? 'SDK báo không có quyền RFID' : 'chưa xác minh'}. Xác thực mật mã chip: chưa xác minh.</Text>
    <Text style={s.message}>Face Matching / Liveness: chưa xác minh. Source Face capture đã được chuẩn bị; còn cần server được cấp phép và kiểm thử thiết bị thật.</Text>
    <Text style={s.foot}>Đọc được NFC không chứng minh chip đã qua kiểm tra mật mã. Kết quả phải được NestJS và provider đánh giá trước khi cấp verified.</Text>
  </ScrollView></SafeAreaView>;
}
const s = StyleSheet.create({ page: { flex: 1, backgroundColor: palette.bg }, content: { padding: 20, paddingBottom: 45 }, heading: { fontSize: 24, fontWeight: '800', color: palette.fg, marginTop: 18 }, desc: { fontSize: 13, lineHeight: 21, color: '#66776B', marginTop: 10, marginBottom: 20 }, card: { borderWidth: 1, borderRadius: 14, padding: 16, marginBottom: 12 }, title: { fontWeight: '800', fontSize: 16, color: palette.fg }, message: { fontSize: 13, lineHeight: 19, marginTop: 8 }, button: { backgroundColor: palette.success, borderRadius: 12, paddingVertical: 12, marginTop: 14, alignItems: 'center' }, buttonText: { color: '#fff', fontWeight: '800' }, foot: { fontSize: 12, lineHeight: 19, color: '#69776E', marginTop: 20 } });
