import { db } from "@/lib/db";
import { LazyScrollExperience } from "@/components/LazyScrollExperience";
import { Storefront } from "@/components/Storefront";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const rows = await db.product.findMany({
    where: { isPublished: true },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, slug: true, name: true, description: true, category: true, priceIqd: true, inventory: true, imageUrl: true, modelUrl: true, modelStatus: true },
  });
  const products = rows.map((p) => ({ ...p, priceIqd: Number(p.priceIqd) }));
  return (
    <main>
      <section className="hero" id="top">
        <div className="hero-noise" />
        <div className="hero-content"><div className="eyebrow">1SMS.STORE / CURATED GOODS</div><h1>SHOP THE<br /><span>UNEXPECTED.</span></h1><p>منتجات يومية. حضور استثنائي. تجربة تتجاوز حدود المتجر التقليدي.</p><a className="hero-link" href="#catalog">استكشف التشكيلة <b>↙</b></a></div>
        <div className="hero-orbit orbit-one" /><div className="hero-orbit orbit-two" /><div className="hero-index">IRAQ / ONLINE STORE<br />EST. 1SMS</div>
        <div className="hero-scroll">SCROLL TO EXPERIENCE <span>↓</span></div>
      </section>
      <LazyScrollExperience />
      <section className="manifesto"><div className="eyebrow">THE 1SMS POINT OF VIEW</div><h2>Less noise.<br /><span>More meaning.</span></h2><p>تجربة شراء صممت حول التفاصيل: اكتشاف بصري، عرض منتجات تفاعلي، ومعلومات واضحة تساعدك على الاختيار.</p><div className="manifesto-words"><span>CURATED</span><i>✳</i><span>TACTILE</span><i>✳</i><span>DIRECT</span></div></section>
      <Storefront products={products} />
      <section className="closing"><div className="eyebrow">FIND YOUR NEXT ESSENTIAL</div><h2>MAKE IT<br /><span>YOURS.</span></h2><a className="hero-link" href="#catalog">ابدأ التسوق ↗</a></section>
    </main>
  );
}
