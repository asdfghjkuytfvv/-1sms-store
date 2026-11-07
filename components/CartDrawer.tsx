"use client";

import { useMemo } from "react";
import { useCart } from "@/lib/store";

const FREE_SHIPPING_IQD = 50000;
const STORE_WHATSAPP = process.env.NEXT_PUBLIC_STORE_WHATSAPP || "";

export function CartDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const items = useCart((s) => s.items);
  const add = useCart((s) => s.add);
  const decrement = useCart((s) => s.decrement);
  const clear = useCart((s) => s.clear);
  const total = useMemo(() => items.reduce((sum, item) => sum + item.product.priceIqd * item.quantity, 0), [items]);
  const progress = Math.min(100, (total / FREE_SHIPPING_IQD) * 100);
  const checkout = () => {
    if (!items.length) return;
    if (!STORE_WHATSAPP) { alert("تواصل مع المتجر لتأكيد رقم واتساب الطلب."); return; }
    const lines = items.map(({ product, quantity }) => `• ${product.name} × ${quantity} = ${(product.priceIqd * quantity).toLocaleString("en-US")} IQD`).join("\n");
    const text = encodeURIComponent(`طلب جديد من 1sms.store\n\n${lines}\n\nالمجموع: ${total.toLocaleString("en-US")} IQD`);
    window.open(`https://wa.me/${STORE_WHATSAPP.replace(/\D/g, "")}?text=${text}`, "_blank", "noopener,noreferrer");
  };
  return (
    <div className={open ? "drawer-backdrop visible" : "drawer-backdrop"} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="cart-drawer" aria-modal="true" role="dialog" aria-label="Shopping cart">
        <div className="drawer-head"><div><small>YOUR SELECTION</small><h2>سلة التسوق <sup>{items.reduce((n, i) => n + i.quantity, 0)}</sup></h2></div><button onClick={onClose} aria-label="Close cart">×</button></div>
        <div className="shipping-progress"><div><span>{total >= FREE_SHIPPING_IQD ? "وصلت إلى حد التوصيل المجاني" : `باقي ${(FREE_SHIPPING_IQD - total).toLocaleString("en-US")} د.ع للتوصيل المجاني`}</span><b>{Math.round(progress)}%</b></div><div className="progress-track"><span style={{ width: `${progress}%` }} /></div></div>
        <div className="cart-items">
          {items.map(({ product, quantity }) => <div className="cart-item" key={product.id}>
            <div className="cart-thumb">{product.imageUrl ? <img src={product.imageUrl} alt="" /> : "1S"}</div>
            <div className="cart-copy"><b>{product.name}</b><span>{product.priceIqd.toLocaleString("en-US")} د.ع</span><div className="quantity"><button onClick={() => decrement(product.id)}>-</button><span>{quantity}</span><button onClick={() => add(product)}>+</button></div></div>
          </div>)}
          {!items.length && <p className="empty-state">سلتك فارغة حالياً.</p>}
        </div>
        <div className="drawer-footer"><div className="subtotal"><span>الإجمالي</span><b>{total.toLocaleString("en-US")} د.ع</b></div><button className="checkout-button" onClick={checkout} disabled={!items.length}>إتمام الطلب عبر واتساب ↗</button><div className="payments"><span>Apple Pay</span><span>Google Pay</span><span>Card</span></div><small>طرق الدفع الإلكتروني تظهر كخيارات بعد تفعيل مزود دفع معتمد. لا يتم تحصيل أي مبلغ من هذه النسخة.</small></div>
      </aside>
    </div>
  );
}
