"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

const Experience = dynamic(() => import("@/components/ScrollExperience").then((module) => module.ScrollExperience), {
  ssr: false,
  loading: () => <div className="experience-placeholder" aria-hidden="true" />,
});

export function LazyScrollExperience() {
  const placeholder = useRef<HTMLDivElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const [loadImmediately, setLoadImmediately] = useState(false);

  useEffect(() => {
    const element = placeholder.current;
    if (!element || nearViewport) return;
    if (typeof IntersectionObserver === "undefined") {
      const timer = window.setTimeout(() => setLoadImmediately(true), 0);
      return () => window.clearTimeout(timer);
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setNearViewport(true);
        observer.disconnect();
      }
    }, { rootMargin: "600px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [loadImmediately, nearViewport]);

  return nearViewport || loadImmediately ? <Experience /> : <div ref={placeholder} className="experience-placeholder" aria-hidden="true" />;
}
