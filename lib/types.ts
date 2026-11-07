export type StoreProduct = {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  priceIqd: number;
  inventory: number;
  imageUrl: string | null;
  modelUrl: string | null;
  modelStatus: "IMAGE_ONLY" | "QUEUED" | "GENERATING" | "OPTIMIZING" | "READY" | "FAILED";
};
