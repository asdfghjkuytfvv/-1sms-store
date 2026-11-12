"use client";

import dynamic from "next/dynamic";
import Image from "next/image";
import { useMemo, useState } from "react";
import { CartDrawer } from "@/components/CartDrawer";
import { useCart } from "@/lib/store";
import type { StoreProduct } from "@/lib/types";

const ProductViewer = dynamic(() => import("@/components/ProductViewer").then((module) => module.ProductViewer), {
  ssr: false,
  loading: () => <div className="viewer-loading" role="status">جارٍ تجهيز العرض ثلاثي الأبعاد...</div>,
});

export function Storefront({ products }: { products: StoreProduct[] }) {
  const [category, setCategory] = useState("All");
  const [search, setSearch] = useState("");
  const [viewer, setViewer] = useState<StoreProduct | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const count = useCart((s) => s.items.reduce((sum, item) => sum + item.quantity, 0));
  const cartItems = useCart((s) => s.items);
  const add = useCart((s) => s.add);
  const categories = useMemo(() => ["All", ...new Set(products.map((p) => p.category))], [products]);
  const visible = useMemo(() => products.filter((product) => {
    const matchesCategory = category === "All" || product.category === category;
    const query = search.trim().toLocaleLowerCase();
    const matchesSearch = !query || `${product.name} ${product.description} ${product.category}`.toLocaleLowerCase().includes(query);
    return matchesCategory && matchesSearch;
  }), [category, products, search]);

  return (
    <>
      <section className="catalog-section" id="catalog">
        <div className="section-head">
          <div><div className="eyebrow">CURATED COLLECTION</div><h2>منتجات مختارة.<br /><span>تجربة مختلفة.</span></h2></div>
          <p>تصفح المنتجات، وافتح العرض ثلاثي الأبعاد عندما يتوفر للموديل ملف GLB.</p>
        </div>
        <div className="catalog-tools"><label className="catalog-search"><span aria-hidden="true">⌕</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ابحث عن منتج أو تصنيف" aria-label="ابحث في المنتجات" /></label><span className="catalog-count">{visible.length} منتج</span></div>
        <div className="category-row">{categories.map((c) => <button key={c} onClick={() => setCategory(c)} className={category === c ? "category active" : "category"}>{c === "All" ? "الكل" : c}</button>)}</div>
        <div className="product-grid">
          {visible.map((p) => (
            <article className="product-card" key={p.id}>
              <div className="product-image">
                {p.imageUrl ? <Image src={p.imageUrl} alt={p.name} fill sizes="(max-width: 520px) 45vw, (max-width: 900px) 45vw, 22vw" loading="lazy" unoptimized /> : <div className="image-placeholder">1S<span>✳</span></div>}
                {p.modelStatus === "READY" && <span className="model-badge">3D READY</span>}
              </div>
              <div className="product-meta"><span>{p.category}</span><span className={p.inventory > 0 ? "in-stock" : "out-of-stock"}>{p.inventory > 0 ? `متوفر · ${p.inventory}` : "غير متوفر"}</span></div>
              <h3>{p.name}</h3><p>{p.description}</p>
              <div className="product-purchase"><b>{p.priceIqd.toLocaleString("en-US")} د.ع</b><button disabled={p.inventory < 1 || (cartItems.find((item) => item.product.id === p.id)?.quantity || 0) >= p.inventory} onClick={() => add(p)}>أضف للسلة +</button></div>
              {p.modelStatus === "READY" && p.modelUrl && <button className="view-3d" onClick={() => setViewer(p)}>استكشف المنتج 360° ↗</button>}
            </article>
          ))}
          {!visible.length && <div className="empty-state">{products.length ? "لم نعثر على منتجات تطابق البحث." : "لا توجد منتجات منشورة بعد. أضف المنتجات من لوحة الإدارة."}</div>}
        </div>
      </section>
      <section className="review-strip"><div className="eyebrow">TRUST, NOT HYPE</div><h2>آراء العملاء الحقيقيين</h2><p>تظهر هنا المراجعات بعد ربطها بطلبات مكتملة ومشتريات موثقة. لا نعرض تقييمات تجريبية على أنها حقيقية.</p></section>
      <button className="floating-cart" onClick={() => setCartOpen(true)}>CART <b>{count}</b></button>
      <CartDrawer open={cartOpen} onClose={() => setCartOpen(false)} />
      {viewer && viewer.modelUrl && <ProductViewer url={viewer.modelUrl} name={viewer.name} onClose={() => setViewer(null)} />}
    </>
  );
}
