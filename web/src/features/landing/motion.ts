"use client";

import type { RefObject } from "react";
import type { RoleKey } from "~/chain/committee";
import { useEffect, useRef, useState } from "react";

/** The light each seat gives off on the landing page, as red, green and blue from 0 to 255. */
export const SEAT_LIGHT: Record<RoleKey, readonly [number, number, number]> = {
  product: [255, 177, 61],
  technology: [46, 211, 245],
  tokenomics: [140, 112, 255],
  risk: [51, 227, 154],
};

/** A vote against arrives in this colour, whichever seat cast it. */
export const AGAINST_LIGHT = [255, 95, 87] as const;

export function rgb([red, green, blue]: readonly [number, number, number], alpha = 1): string {
  return `rgb(${red} ${green} ${blue} / ${alpha})`;
}

/** Where the pointer is over the hero, from -1 to 1 on each axis. */
export interface Pointer {
  x: number;
  y: number;
}

/** Moves `eased` part of the way to `target`, so the scene follows the pointer smoothly. */
export function follow(eased: Pointer, target: Pointer, delta: number) {
  const step = Math.min(1, delta * 3);
  eased.x += (target.x - eased.x) * step;
  eased.y += (target.y - eased.y) * step;
}

/** Draws into a canvas whose size in canvas pixels is `width` by `height`. */
export interface Renderer {
  resize: (width: number, height: number, scale: number) => void;
  /** `time` is seconds since the canvas started, `delta` seconds since the last frame. */
  draw: (time: number, delta: number) => void;
  dispose: () => void;
}

/** Whether the visitor has asked their system for less motion. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Keeps a canvas sized to its box, at `scale` canvas pixels per CSS pixel, and draws a frame
 * of `create`'s renderer on every animation frame while the canvas is on screen. A visitor
 * who asks for less motion gets one frame, drawn at `stillTime`, again whenever it resizes.
 */
export function useCanvasRenderer(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  create: (canvas: HTMLCanvasElement) => Renderer,
  { scale, stillTime }: { scale: (devicePixelRatio: number) => number; stillTime: number },
) {
  const createRef = useRef(create);
  const scaleRef = useRef(scale);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const renderer = createRef.current(canvas);
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let onScreen = false;
    let elapsed = 0;
    let last: number | undefined;

    const drawStill = () => renderer.draw(stillTime, 0);
    const tick = (now: number) => {
      const delta = last === undefined ? 0 : Math.min(0.1, (now - last) / 1000);
      last = now;
      elapsed += delta;
      renderer.draw(elapsed, delta);
      frame = requestAnimationFrame(tick);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      last = undefined;
      if (!onScreen) {
        return;
      }
      if (motion.matches) {
        drawStill();
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    const resize = () => {
      const factor = scaleRef.current(window.devicePixelRatio);
      const width = Math.max(1, Math.round(canvas.clientWidth * factor));
      const height = Math.max(1, Math.round(canvas.clientHeight * factor));
      canvas.width = width;
      canvas.height = height;
      renderer.resize(width, height, factor);
      // Resizing clears the canvas. Drawing at once keeps it from flashing empty.
      renderer.draw(motion.matches ? stillTime : elapsed, 0);
    };

    const sizes = new ResizeObserver(resize);
    sizes.observe(canvas);
    const visibility = new IntersectionObserver(([entry]) => {
      onScreen = entry!.isIntersecting;
      schedule();
    });
    visibility.observe(canvas);
    motion.addEventListener("change", schedule);

    return () => {
      cancelAnimationFrame(frame);
      sizes.disconnect();
      visibility.disconnect();
      motion.removeEventListener("change", schedule);
      renderer.dispose();
    };
  }, [canvasRef, stillTime]);
}

/**
 * Counts up to `target` when it first arrives and glides to each new value after that. Those
 * who ask for less motion see the value at once.
 */
export function useCountUp(target: number | undefined, durationMs = 900): number | undefined {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target ?? 0);

  useEffect(() => {
    if (target === undefined) {
      return;
    }
    const duration = prefersReducedMotion() ? 0 : durationMs;
    const from = shownRef.current;
    const start = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const progress = duration === 0 ? 1 : Math.min(1, (now - start) / duration);
      const value = from + (target - from) * (1 - (1 - progress) ** 3);
      shownRef.current = value;
      setShown(value);
      if (progress < 1) {
        frame = requestAnimationFrame(step);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs]);

  return target === undefined ? undefined : shown;
}
