"use client";

import { useState } from "react";

type Product = { id: string; name: string; modelStatus: string; modelUrl: string | null };

export function AdminGenerator({ products }: { products: Product[] }) {
  const [loggedIn, setLoggedIn] = useState(false);
  const [password, setPassword] = useState("");
  const [selected, setSelected] = useState(products[0]?.id || "");
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function login(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setStatus("");
    const response = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    const result = await response.json();
    setBusy(false);
    if (response.ok) setLoggedIn(true); else setStatus(result.error || "Login failed");
  }

  async function generate(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || !file) return setStatus("اختر المنتج والصورة أولاً.");
    setBusy(true); setStatus("جارٍ رفع الصورة وإضافة مهمة التوليد إلى الطابور...");
    const body = new FormData(); body.append("image", file);
    const response = await fetch(`/api/admin/products/${selected}/generate-3d`, { method: "POST", body });
    const result = await response.json();
    if (!response.ok) { setBusy(false); return setStatus(result.error || "Upload failed"); }
    setStatus(`تم إنشاء المهمة ${result.jobId}. سيتم تنفيذها في العامل الخلفي.`);
    let attempts = 0;
    const timer = window.setInterval(async () => {
      attempts += 1;
      const poll = await fetch(`/api/admin/jobs/${result.jobId}`);
      if (!poll.ok) return;
      const job = await poll.json();
      setStatus(`الحالة: ${job.status} · التقدم: ${job.progress}%`);
      if (["SUCCEEDED", "FAILED"].includes(job.status) || attempts > 360) {
        window.clearInterval(timer); setBusy(false);
        if (job.status === "SUCCEEDED") setStatus("اكتمل توليد النموذج ثلاثي الأبعاد ونشره. حدّث صفحة المتجر لرؤيته.");
        if (job.status === "FAILED") setStatus(`فشلت المهمة: ${job.errorMessage || "راجع سجلات العامل."}`);
      }
    }, 5000);
  }

  if (!loggedIn) return <form onSubmit={login} className="admin-login"><p>دخول مسؤول المتجر</p><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="كلمة مرور الإدارة" required /><button disabled={busy}>{busy ? "..." : "دخول"}</button>{status && <small>{status}</small>}</form>;

  return <form className="admin-generator" onSubmit={generate}>
    <div className="eyebrow">ADMIN / AI ASSET PIPELINE</div><h1>توليد موديل 3D</h1>
    <label>المنتج<select value={selected} onChange={(e) => setSelected(e.target.value)}>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <label>صورة المنتج<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] || null)} required /></label>
    <button disabled={busy || !products.length}>{busy ? "جارٍ التنفيذ..." : "رفع الصورة وبدء التوليد"}</button>
    <p>{status}</p>
    <small>يُحفظ ملف المصدر في التخزين الخاص. لا تظهر النتيجة في الكتالوج حتى ينجح التوليد والتحسين والنشر.</small>
  </form>;
}
