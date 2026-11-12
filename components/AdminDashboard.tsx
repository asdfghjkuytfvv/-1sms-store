"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { AdminGenerator } from "@/components/AdminGenerator";
import { AdminOrderStatus } from "@/components/AdminOrderStatus";

type AdminProduct = {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  priceIqd: number;
  inventory: number;
  imageUrl: string | null;
  modelUrl: string | null;
  modelStatus: string;
  isPublished: boolean;
  updatedAt: string;
};
type AdminOrderLine = { productId: string; name: string; priceIqd: number; quantity: number };
type AdminOrder = {
  id: string;
  customerName: string;
  phone: string;
  address: string;
  city: string;
  totalIqd: number;
  lines: AdminOrderLine[];
  status: string;
  createdAt: string;
};
type ProductDraft = {
  slug: string;
  name: string;
  description: string;
  category: string;
  priceIqd: string;
  inventory: string;
  imageUrl: string;
  isPublished: boolean;
};

const blankDraft: ProductDraft = {
  slug: "", name: "", description: "", category: "عام", priceIqd: "", inventory: "0", imageUrl: "", isPublished: true,
};
export function AdminDashboard({ initiallyAuthenticated }: { initiallyAuthenticated: boolean }) {
  const [authenticated, setAuthenticated] = useState(initiallyAuthenticated);
  const [checking, setChecking] = useState(initiallyAuthenticated);
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [tab, setTab] = useState<"products" | "orders" | "3d">("products");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProductDraft>(blankDraft);
  const [imageFile, setImageFile] = useState<File | null>(null);

  const loadData = useCallback(async () => {
    setChecking(true);
    try {
      const [productResponse, orderResponse] = await Promise.all([
        fetch("/api/admin/products", { cache: "no-store" }),
        fetch("/api/admin/orders", { cache: "no-store" }),
      ]);
      if (productResponse.status === 401 || orderResponse.status === 401) {
        setAuthenticated(false);
        return;
      }
      if (!productResponse.ok || !orderResponse.ok) throw new Error("تعذر تحميل بيانات لوحة الإدارة.");
      const [nextProducts, nextOrders] = await Promise.all([productResponse.json(), orderResponse.json()]);
      setProducts(nextProducts);
      setOrders(nextOrders);
      setAuthenticated(true);
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "تعذر تحميل البيانات.");
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!initiallyAuthenticated) return;
    const timer = window.setTimeout(() => void loadData(), 0);
    return () => window.clearTimeout(timer);
  }, [initiallyAuthenticated, loadData]);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/login", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "تعذر تسجيل الدخول.");
      setPassword("");
      setAuthenticated(true);
      await loadData();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "تعذر تسجيل الدخول.");
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await fetch("/api/admin/login", { method: "DELETE" });
    setAuthenticated(false);
    setProducts([]);
    setOrders([]);
    setMessage("تم تسجيل الخروج.");
  }

  function editProduct(product: AdminProduct) {
    setEditingId(product.id);
    setDraft({
      slug: product.slug,
      name: product.name,
      description: product.description,
      category: product.category,
      priceIqd: String(product.priceIqd),
      inventory: String(product.inventory),
      imageUrl: product.imageUrl || "",
      isPublished: product.isPublished,
    });
    setImageFile(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function saveProduct(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const payload = {
      ...draft,
      slug: draft.slug.trim() || undefined,
      priceIqd: Number(draft.priceIqd),
      inventory: Number(draft.inventory),
      imageUrl: draft.imageUrl.trim() || null,
    };
    try {
      const response = await fetch(editingId ? `/api/admin/products/${editingId}` : "/api/admin/products", {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "تعذر حفظ المنتج.");
      const productId = editingId || result.id;
      let imageError = "";
      if (imageFile && productId) {
        try {
          const imageBody = new FormData();
          imageBody.append("image", imageFile);
          const imageResponse = await fetch(`/api/admin/products/${productId}/image`, { method: "POST", body: imageBody });
          const imageResult = await imageResponse.json();
          if (!imageResponse.ok) imageError = imageResult.error || "تعذر رفع صورة المنتج.";
        } catch {
          imageError = "تعذر الاتصال بخدمة رفع الصور.";
        }
      }
      setDraft(blankDraft);
      setEditingId(null);
      setImageFile(null);
      await loadData();
      setMessage(imageError ? `تم حفظ بيانات المنتج، لكن تعذر رفع الصورة: ${imageError}` : "تم حفظ المنتج.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "تعذر حفظ المنتج.");
    } finally {
      setBusy(false);
    }
  }

  async function changeOrderStatus(orderId: string, status: string) {
    setMessage("");
    try {
      const response = await fetch(`/api/admin/orders/${orderId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }),
      });
      const result = await response.json();
      if (!response.ok) {
        setMessage(result.error || "تعذر تحديث الطلب.");
        await loadData();
        return;
      }
      await loadData();
    } catch {
      setMessage("تعذر الاتصال بخدمة الطلبات.");
    }
  }

  async function togglePublished(product: AdminProduct) {
    try {
      const response = await fetch(`/api/admin/products/${product.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isPublished: !product.isPublished }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "تعذر تحديث حالة النشر.");
      await loadData();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "تعذر تحديث حالة النشر.");
    }
  }

  return (
    <main className="admin-page">
      <header className="admin-topbar"><Link href="/" className="back-link">← العودة للمتجر</Link><span className="eyebrow">1SMS / STORE CONTROL</span></header>
      {!authenticated ? (
        <form onSubmit={login} className="admin-login">
          <div className="eyebrow">SECURE ADMIN ACCESS</div><h1>دخول مسؤول المتجر</h1>
          <label>كلمة المرور<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="كلمة مرور الإدارة" autoComplete="current-password" required /></label>
          <button disabled={busy || checking}>{busy ? "جارٍ التحقق..." : "دخول"}</button>
          {message && <small role="alert">{message}</small>}
        </form>
      ) : (
        <>
          <div className="admin-heading"><div><div className="eyebrow">ADMIN / OPERATIONS</div><h1>إدارة المتجر</h1><p>المنتجات والمخزون والطلبات وأصول العرض ثلاثي الأبعاد.</p></div><div className="admin-actions"><button className="admin-secondary" onClick={() => void loadData()} disabled={checking}>تحديث البيانات</button><button className="admin-secondary" onClick={logout}>تسجيل الخروج</button></div></div>
          <nav className="admin-tabs" aria-label="أقسام لوحة الإدارة">
            <button className={tab === "products" ? "active" : ""} onClick={() => setTab("products")}>المنتجات والمخزون <b>{products.length}</b></button>
            <button className={tab === "orders" ? "active" : ""} onClick={() => setTab("orders")}>الطلبات <b>{orders.length}</b></button>
            <button className={tab === "3d" ? "active" : ""} onClick={() => setTab("3d")}>توليد 3D</button>
          </nav>
          {message && <p className="admin-message" role="status">{message}</p>}

          {tab === "products" && <section className="admin-content">
            <form className="admin-product-form" onSubmit={saveProduct}>
              <div className="admin-form-heading"><div><div className="eyebrow">CATALOG / INVENTORY</div><h2>{editingId ? "تعديل منتج" : "إضافة منتج"}</h2></div>{editingId && <button type="button" className="admin-secondary" onClick={() => { setEditingId(null); setDraft(blankDraft); setImageFile(null); }}>إلغاء التعديل</button>}</div>
              <div className="admin-form-grid">
                <label>اسم المنتج<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required maxLength={140} /></label>
                <label>التصنيف<input value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} required maxLength={80} /></label>
                <label>السعر (دينار عراقي)<input type="number" min="0" step="1" value={draft.priceIqd} onChange={(event) => setDraft({ ...draft, priceIqd: event.target.value })} required /></label>
                <label>الكمية المتوفرة<input type="number" min="0" step="1" value={draft.inventory} onChange={(event) => setDraft({ ...draft, inventory: event.target.value })} required /></label>
        <label>رابط المنتج<input value={draft.slug} onChange={(event) => setDraft({ ...draft, slug: event.target.value })} placeholder="يُنشأ تلقائياً عند تركه فارغاً" maxLength={160} /></label>
                <label>رابط صورة المنتج<input type="url" value={draft.imageUrl} onChange={(event) => setDraft({ ...draft, imageUrl: event.target.value })} placeholder="https://..." /></label>
                <label>أو ارفع صورة جديدة<input key={imageFile?.name || "no-image"} type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setImageFile(event.target.files?.[0] || null)} /><small>{imageFile ? imageFile.name : "JPG أو PNG أو WebP · حتى 10 MB"}</small></label>
                <label className="admin-wide">الوصف<textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} rows={3} maxLength={2000} /></label>
                <label className="admin-publish"><input type="checkbox" checked={draft.isPublished} onChange={(event) => setDraft({ ...draft, isPublished: event.target.checked })} /> نشر المنتج في المتجر</label>
              </div>
              <button disabled={busy}>{busy ? "جارٍ الحفظ..." : editingId ? "حفظ التعديلات" : "إضافة المنتج"}</button>
            </form>

            <div className="admin-list-heading"><div><h2>كتالوج المنتجات</h2><p>إخفاء المنتج يوقف بيعه من دون حذف بياناته أو طلباته.</p></div><span>{products.filter((product) => product.isPublished).length} منشور</span></div>
            <div className="admin-product-list">
              {products.map((product) => <article className="admin-product-row" key={product.id}>
                <div className="admin-product-thumb">{product.imageUrl ? <Image src={product.imageUrl} alt="" width={70} height={70} sizes="70px" unoptimized /> : "1S"}</div>
                <div className="admin-product-info"><div><span className="admin-category">{product.category}</span><span className={product.isPublished ? "admin-published" : "admin-unpublished"}>{product.isPublished ? "منشور" : "مخفي"}</span></div><h3>{product.name}</h3><p>{product.priceIqd.toLocaleString("en-US")} د.ع · المخزون: <b>{product.inventory}</b> · {product.modelStatus === "READY" ? "3D جاهز" : "بدون موديل 3D"}</p></div>
                <div className="admin-product-actions"><button className="admin-secondary" onClick={() => editProduct(product)}>تعديل</button><button className="admin-secondary" onClick={() => void togglePublished(product)}>{product.isPublished ? "إخفاء" : "نشر"}</button></div>
              </article>)}
              {!products.length && <p className="empty-state">لا توجد منتجات. أضف أول منتج من النموذج أعلاه.</p>}
            </div>
          </section>}

          {tab === "orders" && <section className="admin-content"><div className="admin-list-heading"><div><div className="eyebrow">ORDER MANAGEMENT</div><h2>طلبات المتجر</h2><p>الطلبات الجديدة تحجز مخزونها تلقائياً؛ إلغاء الطلب يعيد الكميات إلى المخزون.</p></div></div>
            <div className="admin-order-list">
              {orders.map((order) => <article className="admin-order-card" key={order.id}>
                <div className="admin-order-top"><div><span className="admin-order-id">#{order.id.slice(-8).toUpperCase()}</span><time>{new Date(order.createdAt).toLocaleString("ar-IQ")}</time></div><b>{order.totalIqd.toLocaleString("en-US")} د.ع</b></div>
                <div className="admin-order-customer"><strong>{order.customerName}</strong><a href={`https://wa.me/${order.phone.replace(/\D/g, "")}`} target="_blank" rel="noreferrer">{order.phone} ↗</a><span>{order.city} · {order.address}</span></div>
                <ul>{Array.isArray(order.lines) && order.lines.map((line, index) => <li key={`${line.productId}-${index}`}>{line.name} × {line.quantity}<span>{(line.priceIqd * line.quantity).toLocaleString("en-US")} د.ع</span></li>)}</ul>
                <div className="admin-order-footer"><AdminOrderStatus status={order.status} onChange={(status) => void changeOrderStatus(order.id, status)} /><span>{order.status === "CANCELLED" || order.status === "EXPIRED" ? "تمت إعادة المخزون" : "مخزون الطلب محجوز"}</span></div>
              </article>)}
              {!orders.length && <p className="empty-state">لا توجد طلبات مسجلة بعد.</p>}
            </div>
          </section>}

          {tab === "3d" && <section className="admin-content"><AdminGenerator products={products} onRefresh={() => void loadData()} /></section>}
        </>
      )}
    </main>
  );
}
