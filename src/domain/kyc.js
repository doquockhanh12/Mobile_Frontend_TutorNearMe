export const STEPS = Object.freeze([
  { id: 'front', name: 'Mặt trước CCCD', summary: 'Chụp mặt trước rõ nét, đủ sáng.' },
  { id: 'back', name: 'Mặt sau CCCD', summary: 'Chụp mặt sau, giữ đủ bốn góc thẻ.' },
  { id: 'nfc', name: 'Xác thực chip NFC', summary: 'Đọc và xác thực chip bằng SDK được cấp quyền.' },
  { id: 'face', name: 'Khuôn mặt & liveness', summary: 'Kiểm tra người thật và đối chiếu chân dung.' },
  { id: 'finish', name: 'Kiểm chứng từ server', summary: 'NestJS kiểm tra toàn bộ bằng chứng và trả kết quả.' },
]);
export const STATUS = Object.freeze({ WAITING: 'waiting', RUNNING: 'running', PASS: 'pass', ERROR: 'error' });
export function createFlow() {
  return Object.fromEntries(STEPS.map(s => [s.id, { status: STATUS.WAITING, message: '', evidence: null }]));
}
export function setFlowResult(flow, id, status, message = '', evidence = null) {
  if (!STEPS.some(s => s.id === id)) throw new Error('Unknown step');
  if (!Object.values(STATUS).includes(status)) throw new Error('Unknown status');
  const next = { ...flow, [id]: { status, message, evidence } };
  // If an upstream step is retried, all dependent evidence becomes invalid.
  if (status !== STATUS.PASS) {
    const start = STEPS.findIndex(s => s.id === id);
    for (const s of STEPS.slice(start + 1)) next[s.id] = { status: STATUS.WAITING, message: '', evidence: null };
  }
  return next;
}
export function mayStart(flow, id) {
  const idx = STEPS.findIndex(s => s.id === id);
  return idx >= 0 && STEPS.slice(0, idx).every(s => flow[s.id]?.status === STATUS.PASS);
}
export function maySubmit(flow) {
  return ['front', 'back', 'nfc', 'face'].every(id => flow[id]?.status === STATUS.PASS);
}
export function verificationState(result) {
  if (result?.status === 'verified') return 'verified';
  const state = result?.session?.status || result?.status;
  if (state === 'submitted' || state === 'pending_review') return 'pending_review';
  if (state === 'rejected' || state === 'retry_required') return 'retry_required';
  if (state === 'expired' || state === 'failed') return 'failed';
  if (state === 'processing') return 'processing';
  if (state === 'in_progress') return 'in_progress';
  return 'not_started';
}
export const VERIFICATION_MESSAGES = Object.freeze({
  not_started: 'Chưa bắt đầu xác minh.',
  in_progress: 'Đang thu thập chứng cứ. Chỉ máy chủ mới xác minh danh tính.',
  processing: 'Máy chủ đang kiểm tra chứng cứ. Vui lòng kiểm tra lại trạng thái.',
  pending_review: 'Hồ sơ đang chờ Admin xét duyệt. Tài khoản chưa được xác minh.',
  verified: 'Máy chủ đã xác minh danh tính thành công.',
  retry_required: 'Kiểm tra bắt buộc chưa đạt hoặc chưa đủ bằng chứng xác minh. Chỉ bắt đầu lại sau khi nguyên nhân đã được xử lý và máy chủ cho phép.',
  failed: 'Không thể hoàn tất phiên xác minh. Kiểm tra trạng thái hoặc bắt đầu phiên mới.',
});
export function stepMessage(id, code) {
  const lookup = {
    CAMERA_DENIED: 'Ứng dụng chưa được cấp quyền camera. Hãy cấp quyền trong Cài đặt rồi thử lại.',
    PHOTO_BLUR: 'Ảnh bị mờ hoặc nhòe. Lau ống kính, giữ máy chắc và chụp lại.',
    PHOTO_GLARE: 'Ảnh bị phản sáng. Đổi góc chụp và tránh ánh đèn chiếu thẳng vào thẻ.',
    PHOTO_DARK: 'Ảnh quá tối. Di chuyển tới nơi đủ sáng và chụp lại.',
    PHOTO_CROPPED: 'Không thấy đủ bốn góc CCCD. Đặt cả thẻ vào khung và chụp lại.',
    DOC_UNSUPPORTED: 'Không nhận dạng được loại giấy tờ. Hãy kiểm tra CCCD và thử lại.',
    NFC_UNAVAILABLE: 'Thiết bị hoặc bản cài đặt chưa hỗ trợ đọc NFC CCCD.',
    NFC_DISABLED: 'NFC đang tắt. Hãy bật NFC và thử lại.',
    NFC_TIMEOUT: 'Mất kết nối NFC. Giữ thẻ sát vị trí anten NFC tới khi hoàn thành.',
    NFC_INVALID: 'Không xác thực được dữ liệu chip. Vui lòng thử lại hoặc liên hệ hỗ trợ.',
    FACE_NOT_FOUND: 'Không thấy khuôn mặt. Hãy đưa mặt vào khung hình và thử lại.',
    LIVENESS_FAILED: 'Chưa xác minh được người thật. Ở nơi đủ sáng và làm theo hướng dẫn trên màn hình.',
    FACE_MISMATCH: 'Khuôn mặt không khớp với dữ liệu CCCD. Hãy thử lại hoặc yêu cầu hỗ trợ.',
    LICENSE_MISSING: 'Chưa có license SDK phù hợp. Không thể xác minh danh tính thật.',
    PROVIDER_UNAVAILABLE: 'Dịch vụ xác minh đang gián đoạn. Bạn có thể thử lại sau.',
    SESSION_EXPIRED: 'Phiên xác minh đã hết hạn. Hãy bắt đầu lại từ bước được yêu cầu.',
    KYC_STATE_CONFLICT: 'Trạng thái phiên hoặc challenge đã thay đổi/hết hạn. Hãy kiểm tra trạng thái trước khi bắt đầu phiên mới.',
    NETWORK_ERROR: 'Không thể kết nối máy chủ. Kiểm tra mạng và thử lại.',
    SERVER_NOT_CONFIGURED: 'Backend KYC chưa được tích hợp. Không thể cấp trạng thái đã xác minh.',
    SESSION_MISSING: 'Không thể tạo hoặc khôi phục phiên eKYC. Vui lòng thử lại.',
    KYC_PROVIDER_EVIDENCE_REQUIRED: 'Máy chủ chưa hoàn tất tích hợp xác minh Regula. Chưa thể xác minh danh tính.',
    KYC_MOBILE_GATEWAY_NOT_CONFIGURED: 'Chưa có cổng Regula HTTPS được cấp quyền cho điện thoại. Quy trình đang bị chặn; danh tính chưa được xác minh.',
    KYC_UPLOAD_AUTH_NOT_CONFIGURED: 'Máy chủ chưa cấu hình đầy đủ quyền tải ảnh xác minh. Vui lòng liên hệ hỗ trợ.',
    KYC_UPLOAD_GRANT_INVALID: 'Quyền tải ảnh không hợp lệ hoặc đã hết hạn. Hãy thử lại thao tác hiện tại để xin quyền mới.',
    KYC_UPLOAD_SESSION_CLOSED: 'Bước xử lý giấy tờ đã đóng. Hãy kiểm tra trạng thái phiên để tiếp tục.',
    KYC_UPLOAD_ACCESS_DENIED: 'Không có quyền tải dữ liệu cho phiên xác minh này. Hãy kiểm tra trạng thái phiên.',
    KYC_UPLOAD_SESSION_CHANGED: 'Phiên xác minh đã thay đổi. Hãy kiểm tra trạng thái trước khi thử tiếp.',
    KYC_UPLOAD_TRANSACTION_BINDING_INVALID: 'Gói giấy tờ không thuộc phiên xác minh này. Không thể tiếp nhận dữ liệu.',
    KYC_UPLOAD_RATE_LIMITED: 'Bạn đang gửi ảnh quá nhanh. Vui lòng đợi một lát rồi thử lại.',
    KYC_PROVIDER_UPSTREAM_UNAVAILABLE: 'Dịch vụ xử lý giấy tờ đang gián đoạn. Hãy thử lại thao tác hiện tại sau.',
    KYC_SDK_PROTOCOL_UNVERIFIED: 'Cổng tải dữ liệu Face SDK chưa được kiểm chứng an toàn. Quy trình tạm dừng; danh tính chưa được xác minh.',
    KYC_NFC_EVIDENCE_UNVERIFIED: 'Máy chủ chưa xác thực được chip NFC. Hãy kiểm tra lại thẻ hoặc liên hệ hỗ trợ.',
    KYC_LIVENESS_EVIDENCE_UNVERIFIED: 'Máy chủ chưa xác nhận được Active Liveness hợp lệ. Vui lòng thực hiện lại theo hướng dẫn.',
    KYC_TRANSACTION_BINDING_EVIDENCE_UNVERIFIED: 'Giao dịch không khớp phiên xác minh hiện tại. Vui lòng kiểm tra trạng thái hoặc bắt đầu phiên mới.',
    KYC_DOCUMENT_CONSISTENCY_EVIDENCE_UNVERIFIED: 'Dữ liệu giấy tờ và chip chưa nhất quán. Không thể xác minh danh tính.',
    KYC_PROVIDER_TIMEOUT: 'Dịch vụ xác minh phản hồi chậm. Hãy kiểm tra lại trạng thái trước khi thử tiếp.',
    KYC_PROVIDER_NETWORK_ERROR: 'Không thể kết nối dịch vụ xác minh. Vui lòng thử lại sau.',
    DOCUMENT_SERVICE_NOT_CONFIGURED: 'Chưa cấu hình cổng Document Reader an toàn cho điện thoại.',
    DOCUMENT_SERVICE_INVALID: 'Cổng Document Reader phải dùng HTTPS và truy cập được từ điện thoại.',
    DOCUMENT_GATEWAY_AUTH_REQUIRED: 'Chưa có quyền truy cập cổng Document Reader từ máy chủ.',
    FACE_SERVICE_INVALID: 'Cổng FaceAPI phải dùng HTTPS và truy cập được từ điện thoại.',
    FACE_GATEWAY_AUTH_REQUIRED: 'Chưa có quyền truy cập cổng FaceAPI từ máy chủ.',
    DOCUMENT_IMAGE_MISSING: 'Chưa nhận được ảnh của mặt CCCD này. Hãy quét lại đúng mặt thẻ.',
    NFC_RAW_EVIDENCE_UNAVAILABLE: 'SDK chưa cung cấp đủ EF.SOD và Data Group gốc. Không thể thay thế bằng cờ PA/AA/CA hoặc ảnh xem trước.',
    NFC_RAW_EVIDENCE_CONFLICT: 'Dữ liệu chip trả về không nhất quán. Hãy bắt đầu phiên mới.',
    KYC_NFC_TRUST_NOT_CONFIGURED: 'Máy chủ chưa được cấu hình bộ chứng thư CSCA tin cậy để kiểm tra chữ ký chip.',
    KYC_NFC_PA_FAILED: 'Chữ ký hoặc chuỗi chứng thư chip không xác minh được. Chưa thể xác nhận tính xác thực dữ liệu.',
    KYC_NFC_DG_HASH_MISMATCH: 'Dữ liệu đọc từ chip không khớp hash đã ký. Không thể tiếp tục xác minh.',
    KYC_NFC_CHALLENGE_INVALID: 'Challenge đọc chip không hợp lệ hoặc không thuộc phiên này. Hãy bắt đầu phiên mới.',
    KYC_NFC_OPERATION_CONFLICT: 'Phiên đã tiếp nhận bằng chứng khác. Hãy kiểm tra trạng thái hoặc bắt đầu phiên mới.',
    KYC_NFC_DOCUMENT_PROFILE_UNSUPPORTED: 'Máy chủ chưa hỗ trợ định dạng dữ liệu chip của thẻ này; không thể tự xác nhận danh tính.',
    KYC_NFC_IMAGE_UNSUPPORTED: 'Định dạng ảnh gốc đã ký trên chip chưa được hỗ trợ. Không thể dùng ảnh xem trước thay thế.',
    KYC_NFC_VERIFIER_UNAVAILABLE: 'Bộ kiểm tra chữ ký chip phía máy chủ chưa sẵn sàng. Vui lòng thử lại sau.',
    KYC_NFC_VERIFIER_TIMEOUT: 'Máy chủ chưa kiểm tra xong chữ ký chip. Hãy thử lại thao tác hiện tại.',
    KYC_NFC_VERIFIER_BUSY: 'Bộ kiểm tra chip đang bận. Hãy thử lại sau, không cần quét lại ngay.',
    KYC_NFC_STORAGE_INTEGRITY: 'Không xác minh được tính toàn vẹn bằng chứng đã lưu. Chưa thể xác nhận danh tính.',
    KYC_EVIDENCE_CHECKS_INCOMPLETE: 'Một hoặc nhiều kiểm tra bắt buộc chưa được xác minh. Chưa thể hoàn tất danh tính.',
    KYC_NFC_ANTI_CLONING_UNVERIFIED: 'PA đã xác thực dữ liệu chip nhưng chưa có bằng chứng AA/CA độc lập hợp lệ. Không thể VERIFIED bằng cờ PASS do ứng dụng tự gửi; quét lại đơn thuần chưa giải quyết được giới hạn này.',
    KYC_NFC_AA_PROFILE_UNSUPPORTED: 'Chưa hỗ trợ kiểm tra độc lập cơ chế AA của thẻ này. Không coi kết quả ứng dụng là đã đạt.',
    KYC_RESTART_REQUIRED: 'Hãy bắt đầu phiên mới để chụp lại giấy tờ và xóa các giao dịch cũ.',
    KYC_RETRY_COOLDOWN: 'Bạn cần chờ trước khi xác minh lại. Vui lòng thử lại sau.',
    KYC_RETRY_LIMIT: 'Bạn đã đạt giới hạn xác minh lại. Vui lòng liên hệ hỗ trợ.',
    FACE_CONSENT_REQUIRED: 'Cần đồng ý xử lý dữ liệu khuôn mặt trước khi tiếp tục.',
  };
  const step = STEPS.find(s => s.id === id);
  return lookup[code] || `Không thể hoàn tất ${step?.name?.toLowerCase() || 'bước xác minh'}. Hãy kiểm tra mã lỗi.`;
}
