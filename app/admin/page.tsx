import { db } from "@/lib/db";
import { AdminGenerator } from "@/components/AdminGenerator";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const products = await db.product.findMany({ select: { id: true, name: true, modelStatus: true, modelUrl: true }, orderBy: { name: "asc" } });
  return <main className="admin-page"><a href="/" className="back-link">← العودة للمتجر</a><AdminGenerator products={products} /></main>;
}
