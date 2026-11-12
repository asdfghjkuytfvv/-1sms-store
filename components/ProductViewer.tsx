"use client";

import { Canvas, useThree } from "@react-three/fiber";
import { Html, OrbitControls, useGLTF, Environment, ContactShadows } from "@react-three/drei";
import { Suspense, useEffect, useMemo, useState } from "react";
import { KTX2Loader } from "three-stdlib";
import * as THREE from "three";

function LoadedModel({ url, tint }: { url: string; tint: string }) {
  const gl = useThree((state) => state.gl);
  const ktx2 = useMemo(
    () => new KTX2Loader().setTranscoderPath("/basis/").detectSupport(gl),
    [gl],
  );
  const gltf = useGLTF(url, true, true, (loader) => loader.setKTX2Loader(ktx2));
  const scene = useMemo(() => {
    const clonedScene = gltf.scene.clone(true);
    clonedScene.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      if (Array.isArray(node.material)) {
        node.material = node.material.map((material) => material.clone());
      } else {
        node.material = node.material.clone();
      }
    });
    return clonedScene;
  }, [gltf.scene]);

  useEffect(() => {
    scene.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        node.castShadow = true;
        node.receiveShadow = true;
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        materials.forEach((material) => {
          if ("color" in material && material.color) {
            (material as THREE.MeshStandardMaterial).color.set(tint);
          }
        });
      }
    });
  }, [scene, tint]);

  useEffect(() => {
    return () => { ktx2.dispose(); };
  }, [ktx2]);

  useEffect(() => {
    return () => {
      scene.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) return;
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        materials.forEach((material) => material.dispose());
      });
    };
  }, [scene]);

  return <primitive object={scene} />;
}

function Hotspot({ position, title, detail }: { position: [number, number, number]; title: string; detail: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Html position={position} center distanceFactor={7} zIndexRange={[30, 0]}>
      <button type="button" className="hotspot" onClick={() => setOpen((current) => !current)} aria-label={`Show ${title} details`} aria-expanded={open}>+</button>
      {open && <div className="hotspot-card"><b>{title}</b><p>{detail}</p></div>}
    </Html>
  );
}

export function ProductViewer({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  const [tint, setTint] = useState("#dce8ed");
  return (
    <div className="viewer-backdrop" role="dialog" aria-modal="true" aria-label={`${name} 3D viewer`}>
      <div className="viewer-panel">
        <div className="viewer-top"><div><small>INTERACTIVE 3D</small><h3>{name}</h3></div><button type="button" onClick={onClose} className="viewer-close" aria-label="Close 3D viewer">×</button></div>
        <div className="viewer-canvas">
          <Canvas dpr={[1, 1.25]} camera={{ position: [0, 0, 4.5], fov: 42 }} gl={{ powerPreference: "low-power", antialias: false }}>
            <ambientLight intensity={0.8} />
            <directionalLight position={[4, 6, 5]} intensity={2} />
            <Suspense fallback={null}>
              <LoadedModel url={url} tint={tint} />
              <Hotspot position={[0.7, 0.45, 0]} title="Product detail" detail="Add real product specifications for this hotspot in the product admin." />
              <Environment preset="studio" />
              <ContactShadows position={[0, -1.1, 0]} opacity={0.25} scale={5} blur={2.5} />
            </Suspense>
            <OrbitControls makeDefault enableDamping dampingFactor={0.07} rotateSpeed={0.65} zoomSpeed={0.7} panSpeed={0.5} minDistance={2} maxDistance={9} />
          </Canvas>
          <div className="viewer-instruction">Drag to rotate · Pinch or scroll to zoom</div>
        </div>
        <div className="material-row"><span>FINISH</span>{["#dce8ed", "#111827", "#c5a46d", "#67e8f9"].map((c) => <button type="button" key={c} onClick={() => setTint(c)} className={tint === c ? "swatch selected" : "swatch"} style={{ backgroundColor: c }} aria-label={`Set material ${c}`} aria-pressed={tint === c} />)}</div>
      </div>
    </div>
  );
}
