export type CheckoutSubmitLock = { current: boolean };

export function tryAcquireCheckoutSubmitLock(lock: CheckoutSubmitLock) {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function releaseCheckoutSubmitLock(lock: CheckoutSubmitLock) {
  lock.current = false;
}
