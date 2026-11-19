const SAVE_CONFIRMATION_TIMEOUT_MS = 20_000;

export class SaveConfirmationTimeoutError extends Error {
  constructor() {
    super('雲端確認逾時，這筆資料可能已儲存。請再按一次儲存確認；系統不會重複記帳。');
    this.name = 'SaveConfirmationTimeoutError';
  }
}

/**
 * Stop keeping the form in an indefinite pending state when Firestore cannot
 * confirm a write. The underlying idempotent write may still finish later.
 */
export function withSaveConfirmationTimeout<T>(operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      reject(new SaveConfirmationTimeoutError());
    }, SAVE_CONFIRMATION_TIMEOUT_MS);

    void operation.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timer);
        reject(error);
      },
    );
  });
}
