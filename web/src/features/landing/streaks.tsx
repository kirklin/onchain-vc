"use client";

import type { Renderer } from "./motion";
import { cn } from "cn";
import { useRef } from "react";
import { ROLES } from "~/chain/committee";
import { rgb, SEAT_LIGHT, useCanvasRenderer } from "./motion";

interface Streak {
  x: number;
  y: number;
  length: number;
  speed: number;
  thickness: number;
  colour: readonly [number, number, number];
  alpha: number;
}

const WHITE = [235, 240, 255] as const;

/** A number from about -1 to 1, most often near 0. */
function centred(random: () => number) {
  return (random() + random() + random()) / 1.5 - 1;
}

function streaks(canvas: HTMLCanvasElement, around: boolean): Renderer {
  const context = canvas.getContext("2d")!;
  let width = 0;
  let height = 0;
  let scale = 1;
  let lines: Streak[] = [];

  const spawn = (x: number): Streak => {
    const length = 60 + Math.random() * 360;
    return {
      x,
      y: around ? height * Math.random() : height * (0.5 + centred(Math.random) * 0.32),
      length,
      speed: 50 + length * (0.3 + Math.random() * 0.5),
      thickness: 0.6 + Math.random() * 1.8,
      colour: Math.random() < 0.2 ? WHITE : SEAT_LIGHT[ROLES[Math.floor(Math.random() * ROLES.length)]!],
      alpha: 0.35 + Math.random() * 0.65,
    };
  };

  return {
    resize: (pixelWidth, pixelHeight, factor) => {
      scale = factor;
      width = pixelWidth / factor;
      height = pixelHeight / factor;
      lines = Array.from({ length: Math.min(44, Math.round(width / 34)) }, () => spawn(Math.random() * (width + 400) - 200));
    },
    draw: (_time, delta) => {
      const ctx = context;
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = "lighter";
      for (const [index, line] of lines.entries()) {
        line.x += line.speed * delta;
        if (line.x - line.length > width) {
          lines[index] = spawn(-Math.random() * width * 0.4);
          continue;
        }
        const gradient = ctx.createLinearGradient(line.x - line.length, 0, line.x, 0);
        gradient.addColorStop(0, rgb(line.colour, 0));
        gradient.addColorStop(0.8, rgb(line.colour, line.alpha * 0.8));
        gradient.addColorStop(1, rgb(WHITE, line.alpha));
        ctx.shadowColor = rgb(line.colour, line.alpha);
        ctx.shadowBlur = 10;
        ctx.fillStyle = gradient;
        ctx.fillRect(line.x - line.length, line.y - line.thickness / 2, line.length, line.thickness);
      }
      ctx.shadowBlur = 0;
      ctx.globalCompositeOperation = "source-over";
    },
    dispose: () => {},
  };
}

/**
 * Lines of light running across the page, in the seats' colours. With `around`, the middle
 * is left dark for the text set over them.
 */
export function Streaks({ around = false, className }: { around?: boolean; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useCanvasRenderer(canvasRef, canvas => streaks(canvas, around), { scale: ratio => Math.min(ratio, 2), stillTime: 0 });
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={cn(
        "pointer-events-none block w-full",
        around
          ? "[mask-image:radial-gradient(ellipse_42%_48%_at_center,transparent_55%,black_100%)]"
          : "[mask-image:linear-gradient(to_bottom,transparent,black_30%,black_70%,transparent)]",
        className,
      )}
    />
  );
}
