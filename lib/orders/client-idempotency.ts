export const CHECKOUT_INTENT_STORAGE_KEY = "1sms.checkout-intent.v1";

export type CheckoutIntent = { key: string; payloadSignature: string };
export type CheckoutIntentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function getOrCreateCheckoutIntent(
  payloadSignature: string,
  storage: CheckoutIntentStorage | null,
  fallback: CheckoutIntent | null,
  createKey: () => string,
): CheckoutIntent {
  if (fallback?.payloadSignature === payloadSignature && isUuid(fallback.key)) return fallback;

  if (storage) {
    try {
      const saved = storage.getItem(CHECKOUT_INTENT_STORAGE_KEY) || "";
      if (!fallback && isUuid(saved)) return { key: saved, payloadSignature };
    } catch {
      // Storage can be unavailable or contain invalid data; the in-memory intent remains usable.
    }
  }

  const intent = { key: createKey(), payloadSignature };
  if (storage) {
    try { storage.setItem(CHECKOUT_INTENT_STORAGE_KEY, intent.key); }
    catch { /* The caller also keeps this intent in memory for retries during this page session. */ }
  }
  return intent;
}

export function clearCheckoutIntent(storage: CheckoutIntentStorage | null, key: string) {
  if (!storage) return;
  try {
    const saved = storage.getItem(CHECKOUT_INTENT_STORAGE_KEY) || "";
    if (saved === key) storage.removeItem(CHECKOUT_INTENT_STORAGE_KEY);
  } catch {
    // Nothing else can be safely removed if session storage is unavailable or malformed.
  }
}
