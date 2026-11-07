import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const demo = [
  ["haley-hy-1655", "خلاط يدوي HALEY HY-1655", "خلاط يدوي بقدرة 500 واط.", "أجهزة منزلية", 22000, "🥣"],
  ["personal-backpack", "حقيبة ظهر شخصية", "حقيبة خفيفة وعملية للاستخدام اليومي.", "حقائب", 8500, "🎒"],
  ["arc950-welder", "ماكينة لحام ARC950", "ماكينة لحام للأعمال والصيانة.", "أدوات", 35000, "🧰"],
  ["wireless-mic-type-c", "مايكروفون لاسلكي Type-C", "مايكروفون لاسلكي بوصلة Type-C.", "إلكترونيات", 25000, "🎙️"],
  ["garden-hose-kit", "طقم خرطوم حديقة", "طقم عملي للري والتنظيف.", "منزل وحديقة", 30000, "🚿"],
  ["hand-blender-1200w", "خلاط يدوي 1200W", "قوة 1200 واط لتحضير الطعام.", "أجهزة منزلية", 30000, "🍹"],
  ["mens-shaver-type-c", "ماكينة حلاقة رجالية Type-C", "ماكينة حلاقة قابلة للشحن عبر Type-C.", "عناية شخصية", 15000, "🪒"],
  ["grinder-150w", "مطحنة كهربائية 150W", "مطحنة كهربائية للاستخدام المنزلي.", "أجهزة منزلية", 18000, "⚙️"]
] as const;

async function main() {
  for (const [slug, name, description, category, priceIqd] of demo) {
    await prisma.product.upsert({
      where: { slug },
      update: {},
      create: { slug, name, description, category, priceIqd, inventory: 100 }
    });
  }
}
main().finally(() => prisma.$disconnect());
