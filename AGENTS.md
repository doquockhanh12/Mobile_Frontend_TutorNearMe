# Mobile — additional guardrails

Kế thừa `../../AGENTS.md`; chỉ đọc tài liệu/source mobile đúng yêu cầu được giao, không quét toàn repo. Không phát triển KYC/CCCD/NFC/face khi người dùng chưa giao. Không dùng kết quả OCR/SDK client để cấp `verified`; không lộ token, license, giấy tờ hoặc dữ liệu sinh trắc. Không tự deploy hoặc giả báo đã thử native device.
