
/**
 * TutorNearMe native client -> NestJS API.
 * Supabase Auth supplies credentials. NestJS remains authoritative for
 * user status, roles, KYC, and all business mutations.
 * No token logging, cookie transport, or implicit request retry.
 */
import { supabase } from '../auth/supabaseClient.js';

const rawBaseUrl = process.env.EXPO_PUBLIC_API_URL;
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 60000;

export class ApiError extends Error {
  constructor(code, message, status = null, context = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.requestId = context.requestId || null;
    this.validationFields = context.validationFields || [];
  }
}

function apiOrigin() {
  if (typeof rawBaseUrl !== 'string' || !rawBaseUrl.trim()) {
    throw new Error('Missing EXPO_PUBLIC_API_URL');
  }

  let url;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new Error('Invalid EXPO_PUBLIC_API_URL');
  }

  const developmentHttp =
    __DEV__ &&
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '10.0.2.2'].includes(url.hostname);

  if (
    (url.protocol !== 'https:' && !developmentHttp) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error(
      'EXPO_PUBLIC_API_URL must be a valid API origin',
    );
  }

  return url.origin;
}

const BASE_URL = apiOrigin();

/** SDK requests may carry the user JWT only to this application's authenticated gateway. */
export async function getAuthHeaders(targetUrl = BASE_URL) {
  let target;
  try { target = new URL(targetUrl); } catch { throw new ApiError('KYC_MOBILE_GATEWAY_NOT_CONFIGURED', 'Cổng xác minh chưa được cấu hình.'); }
  if (target.origin !== BASE_URL || target.username || target.password || target.search || target.hash) {
    throw new ApiError('KYC_MOBILE_GATEWAY_NOT_CONFIGURED', 'Cổng xác minh phải thuộc cùng máy chủ ứng dụng.');
  }
  const { data, error } = await supabase.auth.getSession();
  if (error) throw new ApiError('AUTH_SESSION_ERROR', 'Không thể khôi phục phiên đăng nhập.');
  const token = data.session?.access_token;
  if (typeof token !== 'string' || !token) throw new ApiError('AUTH_REQUIRED', 'Bạn cần đăng nhập để tiếp tục.', 401);
  return { Authorization: `Bearer ${token}` };
}

function validatePath(path) {
  if (
    typeof path !== 'string' ||
    !/^\/api\/[A-Za-z0-9/_-]+$/.test(path) ||
    path.includes('//') ||
    path.split('/').some(
      (part) => part === '.' || part === '..',
    )
  ) {
    throw new TypeError(
      'API path must be a local /api/... path without query parameters',
    );
  }

  return path;
}

function endpoint(path, query) {
  const url = new URL(validatePath(path), BASE_URL);

  if (query !== undefined && query !== null) {
    if (
      typeof query !== 'object' ||
      Array.isArray(query)
    ) {
      throw new TypeError('Query must be an object');
    }

    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined) {
        continue;
      }

      if (
        typeof value !== 'string' &&
        typeof value !== 'number' &&
        typeof value !== 'boolean'
      ) {
        throw new TypeError(
          'Query values must be string, number, or boolean',
        );
      }

      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

function safeErrorCode(payload, fallback) {
  const code = payload?.code ?? payload?.error?.code;

  return (
    typeof code === 'string' &&
    /^[A-Z][A-Z0-9_]{1,63}$/.test(code)
  )
    ? code
    : fallback;
}

/**
 * Send an authenticated request to NestJS.
 *
 * No automatic 401 replay, including GET, because auth may have changed.
 * Supabase's getSession() will normally refresh an expired access token;
 * the server independently validates every supplied JWT.
 *
 * `json` is for JSON-serializable request bodies, not document uploads.
 */
export async function apiRequest(path, options = {}) {
  const {
    method = 'GET',
    query,
    json,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
  } = options;

  if (
    !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
  ) {
    throw new TypeError('Unsupported HTTP method');
  }

  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new RangeError('Invalid request timeout');
  }

  if (
    json !== undefined &&
    (method === 'GET' || method === 'DELETE')
  ) {
    throw new TypeError(
      'Request body not supported for this method',
    );
  }

  const url = endpoint(path, query);

  const authHeaders = await getAuthHeaders();

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs,
  );

  let removeAbortListener;

  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      const onAbort = () => controller.abort();
      signal.addEventListener('abort', onAbort, {
        once: true,
      });
      removeAbortListener = () =>
        signal.removeEventListener('abort', onAbort);
    }
  }

  try {
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...authHeaders,
        ...(json !== undefined
          ? { 'Content-Type': 'application/json' }
          : {}),
      },
      ...(json !== undefined
        ? { body: JSON.stringify(json) }
        : {}),
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal,
    });

    // Avoid parsing arbitrary non-JSON responses as business data.
    const contentType =
      response.headers.get('content-type') || '';

    const isJson =
      /^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(
        contentType,
      );

    if (response.status === 204) {
      if (!response.ok) {
        throw new ApiError(
          'HTTP_ERROR',
          'Yêu cầu thất bại.',
          response.status,
        );
      }
      return null;
    }

    if (!isJson) {
      throw new ApiError(
        'INVALID_RESPONSE',
        'Máy chủ trả về dữ liệu không hợp lệ.',
        response.status,
      );
    }

    let payload;

    try {
      payload = await response.json();
    } catch {
      throw new ApiError(
        'INVALID_RESPONSE',
        'Không đọc được phản hồi từ máy chủ.',
        response.status,
      );
    }

    if (!response.ok) {
      const fallback =
        response.status === 401
          ? 'UNAUTHORIZED'
          : response.status === 403
            ? 'FORBIDDEN'
            : response.status === 429
              ? 'RATE_LIMITED'
              : 'HTTP_ERROR';

      // Do not display untrusted server error messages.
      const message =
        response.status === 401
          ? 'Phiên đăng nhập không còn hợp lệ.'
          : response.status === 403
            ? 'Bạn không có quyền thực hiện thao tác này.'
            : response.status === 429
              ? 'Bạn thao tác quá nhanh. Vui lòng thử lại sau.'
              : 'Yêu cầu không thành công. Vui lòng thử lại sau.';

      throw new ApiError(
        safeErrorCode(payload, fallback),
        message,
        response.status,
        {
          requestId: /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(payload?.requestId || '')
            ? payload.requestId : null,
          // Field names only: never include server exception messages or submitted values.
          validationFields: response.status === 400 && Array.isArray(payload?.message)
            ? [...new Set(payload.message.flatMap(item => {
              const field = typeof item === 'string' ? /^(?:property )?([A-Za-z][A-Za-z0-9_.]{0,63}) (?:must|should|is)\b/.exec(item)?.[1] : null;
              return field ? [field] : [];
            }))].slice(0, 8) : [],
        },
      );
    }

    return payload;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    if (controller.signal.aborted) {
      throw new ApiError(
        'REQUEST_CANCELLED',
        'Yêu cầu đã bị hủy hoặc hết thời gian chờ.',
      );
    }

    throw new ApiError(
      'NETWORK_ERROR',
      'Không thể kết nối NestJS API.',
    );
  } finally {
    clearTimeout(timer);
    removeAbortListener?.();
  }
}

export const api = Object.freeze({
  get: (path, query, options = {}) =>
    apiRequest(path, {
      ...options,
      method: 'GET',
      query,
    }),

  post: (path, json, options = {}) =>
    apiRequest(path, {
      ...options,
      method: 'POST',
      json,
    }),

  put: (path, json, options = {}) =>
    apiRequest(path, {
      ...options,
      method: 'PUT',
      json,
    }),

  patch: (path, json, options = {}) =>
    apiRequest(path, {
      ...options,
      method: 'PATCH',
      json,
    }),

  delete: (path, options = {}) =>
    apiRequest(path, {
      ...options,
      method: 'DELETE',
    }),
});
