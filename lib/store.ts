import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { StoreProduct } from "@/lib/types";

type CartItem = { product: StoreProduct; quantity: number };
type CartState = {
  items: CartItem[];
  add: (product: StoreProduct) => void;
  decrement: (productId: string) => void;
  clear: () => void;
};

export const useCart = create<CartState>()(persist((set) => ({
  items: [],
  add: (product) => set((state) => {
    const existing = state.items.find((item) => item.product.id === product.id);
    if (existing) {
      if (existing.quantity >= product.inventory) return state;
      return { items: state.items.map((item) => item.product.id === product.id ? { ...item, product, quantity: item.quantity + 1 } : item) };
    }
    if (product.inventory < 1) return state;
    return { items: [...state.items, { product, quantity: 1 }] };
  }),
  decrement: (productId) => set((state) => ({
    items: state.items.flatMap((item) => item.product.id !== productId ? [item] : item.quantity > 1 ? [{ ...item, quantity: item.quantity - 1 }] : []),
  })),
  clear: () => set({ items: [] }),
}), { name: "1sms-cart" }));
