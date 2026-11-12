"use client";

import { useState } from "react";

type Product = { id: string; name: string; modelStatus: string; modelUrl: string | null };

export function AdminGenerator({ products, onRefresh }: { products: Product[]; onRefresh: () => void }) {
  const [selected, setSelected] = useState(products[0]?.id || "");
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function generate(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || !file) return setStatus("اختر المنتج والصورة أولاً.");
    setBusy(true);
    setStatus("جارٍ رفع الصورة وإضافة مهمة التوليد إلى الطابور...");
    try {
      const body = new FormData();
      body.append("image", file);
      const response = await fetch(`/api/admin/products/${selected}/generate-3d`, { method: "POST", body });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "تعذر رفع الصورة.");

      setStatus(`تم إنشاء المهمة ${result.jobId}. جارٍ انتظار العامل الخلفي...`);
      for (let attempt = 0; attempt < 540; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 5000));
        const poll = await fetch(`/api/admin/jobs/${result.jobId}`, { cache: "no-store" });
        if (!poll.ok) throw new Error("انتهت جلسة الإدارة أو تعذر قراءة حالة المهمة.");
        const job = await poll.json();
        setStatus(`الحالة: ${job.status} · التقدم: ${job.progress}%`);
        if (job.status === "SUCCEEDED") {
          setStatus("اكتمل توليد النموذج ونشره. حدّث المتجر لمعاينته.");
          onRefresh();
          return;
        }
        if (job.status === "FAILED") throw new Error(job.errorMessage || "فشلت المهمة؛ راجع سجلات العامل.");
      }
      setStatus("ما زالت المهمة تعمل في الخلفية. يمكنك الرجوع لاحقاً؛ لن يتوقف التوليد.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "حدث خطأ غير متوقع.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="admin-generator" onSubmit={generate}>
      <div className="eyebrow">ADMIN / AI ASSET PIPELINE</div>
      <h2>توليد موديل 3D</h2>
      <label>المنتج<select value={selected} onChange={(event) => setSelected(event.target.value)} required>
        {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
      </select></label>
      <label>صورة المنتج<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setFile(event.target.files?.[0] || null)} required /></label>
      <button disabled={busy || !products.length}>{busy ? "جارٍ التنفيذ..." : "رفع الصورة وبدء التوليد"}</button>
      {status && <p role="status">{status}</p>}
      <small>تُحفظ الصورة الأصلية في تخزين خاص. لا يظهر النموذج في المتجر إلا بعد نجاح التوليد والتحسين.</small>
      <div className="admin-model-list">
        {products.map((product) => <div key={product.id}><b>{product.name}</b><span>{product.modelStatus === "READY" && product.modelUrl ? "نموذج جاهز" : product.modelStatus}</span></div>)}
      </div>
    </form>
  );
}
