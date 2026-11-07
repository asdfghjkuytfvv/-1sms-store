"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { Environment, Float, Stars } from "@react-three/drei";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { Suspense, useRef } from "react";
import * as THREE from "three";

gsap.registerPlugin(ScrollTrigger);

function Assembly({ progress }: { progress: React.MutableRefObject<number> }) {
  const root = useRef<THREE.Group>(null);
  const pieces = useRef<(THREE.Mesh | null)[]>([]);
  useFrame((state) => {
    const p = progress.current;
    if (!root.current) return;
    root.current.rotation.y = p * Math.PI * 2.25 + state.pointer.x * 0.12;
    root.current.rotation.x = Math.sin(p * Math.PI) * 0.18 + state.pointer.y * 0.08;
    root.current.scale.setScalar(0.78 + Math.sin(p * Math.PI) * 0.17);
    pieces.current.forEach((mesh, i) => {
      if (!mesh) return;
      const angle = (i / 6) * Math.PI * 2;
      const spread = 2.4 * (1 - p);
      const target = new THREE.Vector3(Math.cos(angle) * spread, Math.sin(angle) * spread, (i % 2 ? 1 : -1) * spread * 0.35);
      mesh.position.lerp(target, 0.09);
      mesh.rotation.x += 0.003 * (i + 1);
      mesh.rotation.y += 0.004 * (i + 1);
    });
  });

  const palette = ["#67e8f9", "#d5eaf1", "#65798a", "#b1f5ff", "#d9e0e5", "#3d6577"];
  return (
    <group ref={root}>
      <mesh>
        <torusKnotGeometry args={[0.75, 0.19, 160, 24, 2, 5]} />
        <meshPhysicalMaterial color="#9beaff" metalness={0.88} roughness={0.18} clearcoat={1} />
      </mesh>
      {palette.map((color, i) => (
        <mesh key={color} ref={(node) => { pieces.current[i] = node; }} position={[Math.cos(i) * 2, Math.sin(i) * 2, 0]}>
          <boxGeometry args={[0.43, 0.78, 0.28]} />
          <meshPhysicalMaterial color={color} metalness={0.8} roughness={0.2} clearcoat={1} />
        </mesh>
      ))}
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.55, 0.012, 8, 150]} />
        <meshBasicMaterial color="#67e8f9" transparent opacity={0.7} />
      </mesh>
    </group>
  );
}

export function ScrollExperience() {
  const section = useRef<HTMLElement>(null);
  const progress = useRef(0);
  useGSAP(() => {
    const tween = gsap.to(progress, {
      current: 1,
      ease: "none",
      scrollTrigger: {
        trigger: section.current,
        start: "top top",
        end: "bottom bottom",
        scrub: 1.15,
      },
    });
    return () => tween.scrollTrigger?.kill();
  }, { scope: section });

  return (
    <section ref={section} className="scrolly" id="experience" aria-label="Cinematic product experience">
      <div className="scrolly-sticky">
        <Canvas
          dpr={[1, 1.65]}
          camera={{ position: [0, 0, 6], fov: 42 }}
          gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
          fallback={<div className="webgl-fallback">Interactive 3D preview requires WebGL. Explore the product catalog below.</div>}
        >
          <color attach="background" args={["#05070a"]} />
          <ambientLight intensity={0.7} />
          <spotLight position={[5, 7, 7]} intensity={2.4} color="#9beaff" angle={0.55} />
          <pointLight position={[-5, -2, 2]} intensity={1.7} color="#477c98" />
          <Suspense fallback={null}>
            <Assembly progress={progress} />
            <Float speed={1.1} floatIntensity={0.3}><mesh position={[2.5, 1.7, -1]}><icosahedronGeometry args={[0.12, 1]} /><meshBasicMaterial color="#a7f3ff" /></mesh></Float>
            <Stars radius={45} depth={26} count={650} factor={2.2} saturation={0} fade speed={0.6} />
            <Environment preset="city" />
          </Suspense>
        </Canvas>
        <div className="scrolly-overlay">
          <div className="scene-label">01 — ENGINEERED TO MOVE</div>
          <h2>More than<br /><span>an object.</span></h2>
          <p>مرّر لتشاهد القطع وهي تتباعد، تدور، ثم تتجمع في مشهد واحد.</p>
          <div className="scroll-progress"><span /></div>
          <div className="scene-foot">SCROLL TO ASSEMBLE <b>↓</b></div>
        </div>
        <div className="scrolly-side-note">1SMS / OBJECT STUDY — 001</div>
      </div>
      <div className="scrolly-track" aria-hidden="true" />
    </section>
  );
}
