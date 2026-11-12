"use client";

const orderStatuses = [
  ["PENDING_WHATSAPP", "بانتظار تأكيد واتساب"],
  ["CONFIRMED", "مؤكد"],
  ["PROCESSING", "قيد التجهيز"],
  ["SHIPPED", "تم الشحن"],
  ["DELIVERED", "تم التسليم"],
  ["CANCELLED", "ملغي"],
  ["EXPIRED", "انتهى حجز المخزون"],
] as const;

const nextOrderStatuses: Record<string, string[]> = {
  PENDING_WHATSAPP: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export function AdminOrderStatus({ status, onChange }: { status: string; onChange: (status: string) => void }) {
  const disabled = status === "CANCELLED" || status === "DELIVERED" || status === "EXPIRED";
  return (
    <label>حالة الطلب<select value={status} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
      <option value={status}>{orderStatuses.find(([value]) => value === status)?.[1] || status}</option>
      {(nextOrderStatuses[status] || []).map((nextStatus) => <option key={nextStatus} value={nextStatus}>{orderStatuses.find(([value]) => value === nextStatus)?.[1] || nextStatus}</option>)}
    </select></label>
  );
}
