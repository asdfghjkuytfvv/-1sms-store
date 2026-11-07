"use client";
import { useEffect } from "react";

export function CustomCursor() {
  useEffect(() => {
    if (window.matchMedia("(pointer: coarse)").matches) return;
    const cursor = document.querySelector<HTMLElement>("[data-cursor]");
    if (!cursor) return;
    let raf = 0, x = 0, y = 0;
    const move = (event: PointerEvent) => {
      x = event.clientX; y = event.clientY;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        cursor.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
      });
      const target = (event.target as HTMLElement)?.closest("button,a,[data-magnetic]");
      cursor.classList.toggle("is-hot", Boolean(target));
    };
    window.addEventListener("pointermove", move);
    return () => { window.removeEventListener("pointermove", move); cancelAnimationFrame(raf); };
  }, []);
  return <div data-cursor className="custom-cursor" aria-hidden="true" />;
}
