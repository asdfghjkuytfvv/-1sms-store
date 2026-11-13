"use client";

import { useMemo, useRef, useState } from "react";
import Image from "next/image";
import { useCart } from "@/lib/store";
import { clearCheckoutIntent, getOrCreateCheckoutIntent, type CheckoutIntent, type CheckoutIntentStorage } from "@/lib/orders/client-idempotency";
import { releaseCheckoutSubmitLock, tryAcquireCheckoutSubmitLock } from "@/lib/orders/checkout-submit-lock";

const FREE_SHIPPING_IQD = 50000;

type CheckoutPayload = {
  customerName: string;
  phone: string;
  city: string;
  address: string;
  items: Array<{ productId: string; quantity: number }>;
};

export function CartDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [customerName, setCustomerName] = useState("");
  const [phone, setPhone] = useState("");
  const [city, setCity] = useState("");
  const [address, setAddress] = useState("");
  const [status, setStatus] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const fallbackIntent = useRef<CheckoutIntent | null>(null);
  const submitLock = useRef(false);
  const items = useCart((s) => s.items);
  const add = useCart((s) => s.add);
  const decrement = useCart((s) => s.decrement);
  const clear = useCart((s) => s.clear);
  const total = useMemo(() => items.reduce((sum, item) => sum + item.product.priceIqd * item.quantity, 0), [items]);
  const progress = Math.min(100, (total / FREE_SHIPPING_IQD) * 100);
  const submitCheckout = async (payload: CheckoutPayload) => {
    try {
      let storage: CheckoutIntentStorage | null = null;
      try { storage = window.sessionStorage; } catch { /* In-memory retries still share this intent. */ }
      const payloadSignature = JSON.stringify(payload);
      const intent = getOrCreateCheckoutIntent(payloadSignature, storage, fallbackIntent.current, () => crypto.randomUUID());
      fallbackIntent.current = intent;
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": intent.key },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) {
        if (result.code === "IDEMPOTENCY_KEY_REUSED") {
          clearCheckoutIntent(storage, intent.key);
          fallbackIntent.current = null;
        }
        throw new Error(result.error || "تعذر تسجيل الطلب.");
      }
      clearCheckoutIntent(storage, intent.key);
      fallbackIntent.current = null;
      clear();
      if (result.whatsappUrl) window.location.assign(result.whatsappUrl);
      else setStatus(`تم تسجيل الطلب رقم ${result.orderId}. تواصل مع المتجر لإكماله.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "تعذر إتمام الطلب. حاول مرة أخرى.");
    } finally {
      releaseCheckoutSubmitLock(submitLock);
      setSubmitting(false);
    }
  };

  const checkout = (event: React.FormEvent) => {
    event.preventDefault();
    if (!items.length || !tryAcquireCheckoutSubmitLock(submitLock)) return;
    setSubmitting(true);
    setStatus("جارٍ التحقق من الأسعار والمخزون وتسجيل الطلب...");
    const payload: CheckoutPayload = {
      customerName,
      phone,
      city,
      address,
      items: items.map(({ product, quantity }) => ({ productId: product.id, quantity })),
    };

    // Let React paint the loading state before checkout performs storage work or waits on the API.
    window.requestAnimationFrame(() => { void submitCheckout(payload); });
  };
  return (
    <div className={open ? "drawer-backdrop visible" : "drawer-backdrop"} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="cart-drawer" aria-modal="true" role="dialog" aria-label="Shopping cart">
        <div className="drawer-head"><div><small>YOUR SELECTION</small><h2>سلة التسوق <sup>{items.reduce((n, i) => n + i.quantity, 0)}</sup></h2></div><button onClick={onClose} aria-label="Close cart">×</button></div>
        <div className="shipping-progress"><div><span>{total >= FREE_SHIPPING_IQD ? "وصلت إلى حد التوصيل المجاني" : `باقي ${(FREE_SHIPPING_IQD - total).toLocaleString("en-US")} د.ع للتوصيل المجاني`}</span><b>{Math.round(progress)}%</b></div><div className="progress-track"><span style={{ width: `${progress}%` }} /></div></div>
        <div className="cart-items">
          {items.map(({ product, quantity }) => <div className="cart-item" key={product.id}>
            <div className="cart-thumb">{product.imageUrl ? <Image src={product.imageUrl} alt="" width={70} height={70} sizes="70px" unoptimized /> : "1S"}</div>
            <div className="cart-copy"><b>{product.name}</b><span>{product.priceIqd.toLocaleString("en-US")} د.ع</span><div className="quantity"><button onClick={() => decrement(product.id)} aria-label={`تقليل كمية ${product.name}`}>-</button><span>{quantity}</span><button onClick={() => add(product)} disabled={quantity >= product.inventory} aria-label={`زيادة كمية ${product.name}`}>+</button></div></div>
          </div>)}
          {!items.length && <p className="empty-state">سلتك فارغة حالياً.</p>}
        </div>
        <form className="drawer-footer" onSubmit={checkout} aria-busy={submitting}>
          <div className="subtotal"><span>الإجمالي التقديري</span><b>{total.toLocaleString("en-US")} د.ع</b></div>
          <div className="checkout-fields">
            <label>الاسم<input value={customerName} onChange={(event) => setCustomerName(event.target.value)} autoComplete="name" minLength={2} maxLength={120} required /></label>
            <label>رقم الهاتف<input type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} autoComplete="tel" minLength={7} maxLength={32} required /></label>
            <label>المحافظة أو المدينة<input value={city} onChange={(event) => setCity(event.target.value)} autoComplete="address-level2" minLength={2} maxLength={100} required /></label>
            <label>عنوان التوصيل<input value={address} onChange={(event) => setAddress(event.target.value)} autoComplete="street-address" minLength={4} maxLength={500} required /></label>
          </div>
          <button className="checkout-button" disabled={!items.length || submitting}>{submitting ? "جارٍ تسجيل الطلب..." : "تأكيد الطلب والمتابعة إلى واتساب ↗"}</button>
          {status && <p className="checkout-status" role="status">{status}</p>}
          <div className="payments"><span>الدفع عند الاستلام فقط</span></div>
          <small>سنتحقق من السعر والمخزون قبل تسجيل الطلب. يُدفع المبلغ عند استلام الطلب.</small>
        </form>
      </aside>
    </div>
  );
}
