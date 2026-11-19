/**
 * 邀請碼（/login?join=CODE）：登入前先把 code 存到 sessionStorage，
 * 登入後若 email 還不在白名單，useInitAuth 會拿 code 呼叫 Apps Script joinHousehold，
 * 成功後就會被加進白名單 + 共同帳本，不用先由 owner 手動加 email。
 */
const KEY = 'household_join_code';
const DENIED_KEY = 'login_denied_email';

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** 從網址讀 ?join=CODE 存起來（回傳 code；沒有則回 null） */
export function captureJoinCodeFromUrl(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('join');
    if (!raw) return getPendingJoinCode();
    const code = raw.trim().toUpperCase();
    storage()?.setItem(KEY, code);
    return code;
  } catch {
    return null;
  }
}

export function getPendingJoinCode(): string | null {
  return storage()?.getItem(KEY) ?? null;
}

export function clearJoinCode(): void {
  storage()?.removeItem(KEY);
}

export function rememberDeniedEmail(email: string): void {
  storage()?.setItem(DENIED_KEY, email);
}

export function getDeniedEmail(): string | null {
  return storage()?.getItem(DENIED_KEY) ?? null;
}

export function clearDeniedEmail(): void {
  storage()?.removeItem(DENIED_KEY);
}
