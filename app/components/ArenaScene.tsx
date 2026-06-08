"use client";

/**
 * ArenaScene — the Three.js centerpiece (R3F). A slowly-rotating distorted metallic
 * core with an orbiting particle field. DATA-REACTIVE: its color/intensity shift with
 * arena state (benched ⇒ hot red; live finale ⇒ amber; else electric violet), and the
 * distortion/rotation ease with "market activity".
 *
 * Perf-budgeted for a 2-core VPS: capped DPR, modest geometry, render loop pauses when
 * the hero is offscreen (see Hero's IntersectionObserver → `active`). Loaded via
 * next/dynamic({ ssr:false }) with a CSS fallback (Hero handles the no-WebGL case).
 */
import { useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Float, Icosahedron, MeshDistortMaterial, Points, PointMaterial } from "@react-three/drei";
import * as THREE from "three";

export type SceneMood = "default" | "benched" | "live";

const MOOD_COLOR: Record<SceneMood, string> = {
  default: "#7c5cff", // electric violet
  benched: "#fb5d5d", // hot red
  live: "#f5b53f", // amber
};

function Core({ mood, energy }: { mood: SceneMood; energy: number }) {
  const matRef = useRef<THREE.MeshStandardMaterial>(null);
  const target = useMemo(() => new THREE.Color(MOOD_COLOR[mood]), [mood]);

  useFrame((_, dt) => {
    if (matRef.current) {
      // ease emissive color toward the mood color
      matRef.current.emissive.lerp(target, Math.min(1, dt * 2));
      (matRef.current as THREE.MeshStandardMaterial).color.lerp(target, Math.min(1, dt * 1.2));
    }
  });

  return (
    <Float speed={1.2} rotationIntensity={0.5} floatIntensity={0.6}>
      <Icosahedron args={[1.35, 6]}>
        {/* MeshDistortMaterial gives the "liquid metal" look; distort scales with energy */}
        <MeshDistortMaterial
          ref={matRef as never}
          color={MOOD_COLOR[mood]}
          emissive={MOOD_COLOR[mood]}
          emissiveIntensity={0.35}
          roughness={0.18}
          metalness={0.9}
          distort={0.28 + energy * 0.22}
          speed={1.4 + energy * 1.6}
        />
      </Icosahedron>
    </Float>
  );
}

function ParticleField() {
  const ref = useRef<THREE.Points>(null);
  const positions = useMemo(() => {
    const n = 700; // modest count for the VPS
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      // shell distribution around the core
      const r = 2.6 + Math.random() * 3.2;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      arr[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      arr[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      arr[i * 3 + 2] = r * Math.cos(phi);
    }
    return arr;
  }, []);

  useFrame((_, dt) => {
    if (ref.current) ref.current.rotation.y += dt * 0.04;
  });

  return (
    <Points ref={ref} positions={positions} stride={3} frustumCulled>
      <PointMaterial transparent color="#5b6675" size={0.018} sizeAttenuation depthWrite={false} />
    </Points>
  );
}

function Rig({ active }: { active: boolean }) {
  const group = useRef<THREE.Group>(null);
  useFrame((state, dt) => {
    if (!active || !group.current) return;
    // gentle continuous rotation + subtle mouse parallax
    group.current.rotation.y += dt * 0.12;
    const px = state.pointer.x * 0.25;
    const py = state.pointer.y * 0.2;
    group.current.rotation.x += (py - group.current.rotation.x) * 0.04;
    group.current.position.x += (px - group.current.position.x) * 0.04;
  });
  return <group ref={group} />;
}

export default function ArenaScene({
  mood = "default",
  energy = 0.4,
  active = true,
}: {
  mood?: SceneMood;
  energy?: number;
  active?: boolean;
}) {
  return (
    <Canvas
      camera={{ position: [0, 0, 6], fov: 42 }}
      dpr={[1, 1.5]}
      frameloop={active ? "always" : "demand"}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      style={{ background: "transparent" }}
    >
      <ambientLight intensity={0.4} />
      <directionalLight position={[5, 5, 5]} intensity={1.4} />
      <pointLight position={[-6, -3, -4]} intensity={1.1} color={MOOD_COLOR[mood]} />
      <Rig active={active} />
      <Core mood={mood} energy={energy} />
      <ParticleField />
    </Canvas>
  );
}
