import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import { cn } from '@/lib/utils';

export interface ConfettiBurstHandle {
  burst: () => void;
}

export interface ConfettiBurstProps {
  className?: string;
  particleCount?: number;
}

/**
 * Transitions.dev "Confetti burst" (Prototype 28) physics confetti.
 *
 * Exact specifications:
 * - Palette: #ff4d67, #ffb020, #3b82f6, #22c55e, #a855f7, #f97316, #06b6d4, #f43f5e
 * - 3D cosine tumble squish effect (ctx.scale(1, p.squish) with Math.cos(p.tumble))
 * - Sinusoidal phase sway (p.phase += p.swayFreq * dt; Math.cos(p.phase) * sway)
 * - Restitution bounces on floor and smooth alpha decay after settling
 * - Respects prefers-reduced-motion (aborts immediately when reduced motion is preferred)
 * - Non-blocking: pointer-events-none, hardware-accelerated 2D canvas, no DOM churn
 */
const CONFETTI_COLORS = [
  '#ff4d67',
  '#ffb020',
  '#3b82f6',
  '#22c55e',
  '#a855f7',
  '#f97316',
  '#06b6d4',
  '#f43f5e',
];

interface Particle {
  start: number;
  x: number;
  y: number;
  py: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  maxFall: number;
  rot: number;
  vr: number;
  tumble: number;
  tumbleSpeed: number;
  squish: number;
  phase: number;
  swayFreq: number;
  swayScale: number;
  color: string;
  bounces: number;
  resting: boolean;
  dead: boolean;
}

export const ConfettiBurst = forwardRef<ConfettiBurstHandle, ConfettiBurstProps>(
  function ConfettiBurst({ className, particleCount = 55 }, ref) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const stateRef = useRef<{
      running: boolean;
      rafId: number | null;
      particles: Particle[];
      stageW: number;
      stageH: number;
      lastT: number;
      burstEnd: number;
      fadeStart: number | null;
    }>({
      running: false,
      rafId: null,
      particles: [],
      stageW: 0,
      stageH: 0,
      lastT: 0,
      burstEnd: 0,
      fadeStart: null,
    });

    const stop = useCallback(() => {
      const state = stateRef.current;
      if (state.rafId !== null) {
        cancelAnimationFrame(state.rafId);
        state.rafId = null;
      }
      state.running = false;
      state.particles = [];
      state.fadeStart = null;

      const canvas = canvasRef.current;
      if (canvas && state.stageW > 0 && state.stageH > 0) {
        const ctx = canvas.getContext('2d');
        ctx?.clearRect(0, 0, state.stageW, state.stageH);
      }
    }, []);

    const burst = useCallback(() => {
      // Respect prefers-reduced-motion
      if (
        typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      ) {
        return;
      }

      const canvas = canvasRef.current;
      if (!canvas) return;

      const stage = canvas.parentElement || canvas;
      const rect = stage.getBoundingClientRect();
      const stageW = rect.width || canvas.clientWidth || 360;
      const stageH = rect.height || canvas.clientHeight || 500;

      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      canvas.width = Math.round(stageW * dpr);
      canvas.height = Math.round(stageH * dpr);

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const state = stateRef.current;
      if (state.rafId !== null) {
        cancelAnimationFrame(state.rafId);
        state.rafId = null;
      }

      state.stageW = stageW;
      state.stageH = stageH;

      const now = performance.now();
      const count = particleCount;
      const size = 7.5;
      const spawnWindow = 260;
      const particles: Particle[] = [];

      for (let i = 0; i < count; i++) {
        particles.push({
          start: now + Math.random() * spawnWindow,
          x: Math.random() * stageW,
          y: -10 - Math.random() * 25,
          py: -10,
          vx: (Math.random() - 0.5) * 60,
          vy: 40 + Math.random() * 120,
          w: size * (0.7 + Math.random() * 0.6),
          h: size * (0.5 + Math.random() * 0.5),
          maxFall: 420 + Math.random() * 280,
          rot: Math.random() * Math.PI,
          vr: (Math.random() - 0.5) * 7,
          tumble: Math.random() * Math.PI * 2,
          tumbleSpeed: 4 + Math.random() * 8,
          squish: 1,
          phase: Math.random() * Math.PI * 2,
          swayFreq: 2 + Math.random() * 3,
          swayScale: 0.5 + Math.random(),
          color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)]!,
          bounces: 0,
          resting: false,
          dead: false,
        });
      }

      state.particles = particles;
      state.fadeStart = null;
      state.burstEnd = now + spawnWindow + 120;
      state.lastT = now;
      state.running = true;

      function step(dt: number, currentNow: number) {
        const g = 1300;
        const sway = 16;
        const restitution = 0.3;

        for (let i = 0; i < state.particles.length; i++) {
          const p = state.particles[i]!;
          if (p.resting || p.dead || currentNow < p.start) continue;

          p.py = p.y;
          p.vy += g * dt;
          if (p.vy > p.maxFall) p.vy = p.maxFall;

          p.phase += p.swayFreq * dt;
          p.x += (p.vx + Math.cos(p.phase) * sway * p.swayScale) * dt;
          p.y += p.vy * dt;
          p.rot += p.vr * dt;
          p.tumble += p.tumbleSpeed * dt;
          p.squish = 0.25 + 0.75 * Math.abs(Math.cos(p.tumble));

          const half = p.h / 2;

          if (!p.resting && p.y + half >= state.stageH - 1) {
            if (p.vy > 170 && p.bounces < 2) {
              p.bounces++;
              p.vy = -p.vy * restitution * (0.5 + Math.random() * 0.4);
              p.vx *= 0.7;
              p.y = state.stageH - 1 - half;
            } else {
              p.resting = true;
              p.y = state.stageH - 1 - half;
              p.vx = 0;
              p.vy = 0;
            }
          }

          if (p.x < -30 || p.x > state.stageW + 30 || p.y > state.stageH + 30) {
            p.dead = true;
          }
        }
      }

      function draw(alpha: number, currentNow: number) {
        if (!ctx) return;
        ctx.clearRect(0, 0, state.stageW, state.stageH);
        ctx.globalAlpha = Math.max(0, Math.min(1, alpha));

        for (let i = 0; i < state.particles.length; i++) {
          const p = state.particles[i]!;
          if (p.dead || currentNow < p.start) continue;

          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.scale(1, p.squish);
          ctx.fillStyle = p.color;
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
          ctx.restore();
        }

        ctx.globalAlpha = 1;
      }

      function frame(frameNow: number) {
        if (!state.running) return;

        let remaining = Math.min((frameNow - state.lastT) / 1000, 0.25);
        state.lastT = frameNow;

        while (remaining > 0) {
          const dt = Math.min(remaining, 1 / 60);
          step(dt, frameNow);
          remaining -= dt;
        }

        let settled = frameNow > state.burstEnd;
        if (settled) {
          for (let i = 0; i < state.particles.length; i++) {
            const p = state.particles[i]!;
            if (!p.resting && !p.dead) {
              settled = false;
              break;
            }
          }
        }

        if (settled && state.fadeStart === null) {
          state.fadeStart = frameNow + 400;
        }

        let alpha = 1;
        if (state.fadeStart !== null && frameNow >= state.fadeStart) {
          const fadeDuration = 450;
          alpha = 1 - (frameNow - state.fadeStart) / fadeDuration;
          if (alpha <= 0) {
            state.running = false;
            state.particles = [];
            state.rafId = null;
            if (ctx) ctx.clearRect(0, 0, state.stageW, state.stageH);
            return;
          }
        }

        draw(alpha, frameNow);
        state.rafId = requestAnimationFrame(frame);
      }

      state.rafId = requestAnimationFrame(frame);
    }, [particleCount]);

    useImperativeHandle(
      ref,
      () => ({
        burst,
      }),
      [burst],
    );

    useEffect(() => {
      return () => {
        stop();
      };
    }, [stop]);

    return (
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-0 z-50 h-full w-full',
          className,
        )}
      />
    );
  },
);
