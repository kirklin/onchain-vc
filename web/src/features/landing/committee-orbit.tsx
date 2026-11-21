"use client";

import type { Ref, RefObject } from "react";
import type { Pointer, Renderer } from "./motion";
import type { RoleKey } from "~/chain/committee";
import { cn } from "cn";
import { useEffect, useImperativeHandle, useRef } from "react";
import { ROLES } from "~/chain/committee";
import { AGAINST_LIGHT, follow, rgb, SEAT_LIGHT, useCanvasRenderer } from "./motion";

export interface OrbitHandle {
  /** Sends a vote from a seat to the table, where it becomes a block on the chain. */
  vote: (seat: number, inFavour: boolean) => void;
}

type Colour = readonly [number, number, number];

interface Pulse {
  seat: number;
  colour: Colour;
  start: number;
}

interface Block {
  colour: Colour;
  start: number;
}

const PULSE_SECONDS = 1.15;
/** Votes that arrive together leave their seats this far apart. */
const PULSE_SPACING = 0.32;
const BLOCK_SPEED = 110;
const CUBE_EDGES = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]] as const;

function easeInOut(x: number) {
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

function orbit(
  canvas: HTMLCanvasElement,
  pointer: RefObject<Pointer>,
  labels: RefObject<Record<RoleKey, string>>,
  queue: { pending: { seat: number; inFavour: boolean }[] },
): Renderer {
  const context = canvas.getContext("2d")!;
  let width = 0;
  let height = 0;
  let scale = 1;
  let nextPulse = 0;
  let flash = 0;
  let flashColour: Colour = [255, 255, 255];
  const pulses: Pulse[] = [];
  const blocks: Block[] = [];
  const eased = { x: 0, y: 0 };

  return {
    resize: (pixelWidth, pixelHeight, factor) => {
      scale = factor;
      width = pixelWidth / factor;
      height = pixelHeight / factor;
    },
    draw: (time, delta) => {
      const ctx = context;
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.clearRect(0, 0, width, height);

      for (const vote of queue.pending.splice(0)) {
        nextPulse = Math.max(nextPulse, time);
        pulses.push({ seat: vote.seat, colour: vote.inFavour ? SEAT_LIGHT[ROLES[vote.seat]!] : AGAINST_LIGHT, start: nextPulse });
        nextPulse += PULSE_SPACING;
      }

      follow(eased, pointer.current, delta);
      // The outer ring, at 1.34 times the radius, stays inside the canvas.
      const radius = Math.min(width * 0.37, height * 0.7);
      const tilt = 0.34 + eased.y * 0.05;
      const cx = width * 0.5 + eased.x * 16;
      const cy = height * 0.56 + eased.y * 10;
      const cube = radius * 0.24;
      const tableY = cy - cube * 0.55;

      // The floor: three rings and the spokes between them.
      ctx.lineWidth = 1;
      for (const [ring, alpha] of [[0.6, 0.08], [1, 0.2], [1.34, 0.08]] as const) {
        ctx.strokeStyle = `rgb(255 255 255 / ${alpha})`;
        ctx.beginPath();
        ctx.ellipse(cx, cy, radius * ring, radius * ring * tilt, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([2, 9]);
      ctx.lineDashOffset = -time * 16;
      ctx.strokeStyle = "rgb(255 255 255 / 0.22)";
      ctx.beginPath();
      ctx.ellipse(cx, cy, radius * 1.18, radius * 1.18 * tilt, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      for (let spoke = 0; spoke < 24; spoke++) {
        const angle = (spoke / 24) * Math.PI * 2 + time * 0.03;
        ctx.strokeStyle = "rgb(255 255 255 / 0.04)";
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(angle) * radius * 0.6, cy + Math.sin(angle) * radius * 0.6 * tilt);
        ctx.lineTo(cx + Math.cos(angle) * radius * 1.34, cy + Math.sin(angle) * radius * 1.34 * tilt);
        ctx.stroke();
      }

      // The chain: blocks already made drift right from the table, and new ones run along it.
      const chainStart = cx + cube * 1.1;
      ctx.strokeStyle = "rgb(255 255 255 / 0.12)";
      ctx.beginPath();
      ctx.moveTo(chainStart, tableY);
      ctx.lineTo(width, tableY);
      ctx.stroke();
      const gap = 26;
      const drift = (time * 14) % gap;
      for (let x = chainStart + drift; x < width; x += gap) {
        const fade = 1 - (x - chainStart) / (width - chainStart);
        ctx.strokeStyle = `rgb(255 255 255 / ${0.28 * fade})`;
        ctx.strokeRect(x - 4, tableY - 4, 8, 8);
      }
      for (let index = blocks.length - 1; index >= 0; index--) {
        const block = blocks[index]!;
        const x = chainStart + (time - block.start) * BLOCK_SPEED;
        if (x > width + 10) {
          blocks.splice(index, 1);
          continue;
        }
        const fade = Math.max(0, 1 - (x - chainStart) / (width - chainStart));
        ctx.shadowColor = rgb(block.colour);
        ctx.shadowBlur = 14;
        ctx.fillStyle = rgb(block.colour, 0.35 + 0.65 * fade);
        ctx.fillRect(x - 5, tableY - 5, 10, 10);
        ctx.shadowBlur = 0;
      }

      const seats = ROLES.map((role, index) => {
        const angle = time * 0.16 + index * (Math.PI / 2) + Math.PI / 4;
        return {
          index,
          label: labels.current[role],
          colour: SEAT_LIGHT[role],
          x: cx + Math.cos(angle) * radius,
          y: cy + Math.sin(angle) * radius * tilt,
          depth: (Math.sin(angle) + 1) / 2,
        };
      });

      const drawSeat = (seat: (typeof seats)[number]) => {
        const breathe = 1 + 0.08 * Math.sin(time * 2 + seat.index * 1.7);
        const near = 0.55 + 0.45 * seat.depth;
        const beam = ctx.createLinearGradient(seat.x, seat.y, seat.x, seat.y - 70 * near);
        beam.addColorStop(0, rgb(seat.colour, 0.55 * near));
        beam.addColorStop(1, rgb(seat.colour, 0));
        ctx.strokeStyle = beam;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(seat.x, seat.y);
        ctx.lineTo(seat.x, seat.y - 70 * near);
        ctx.stroke();

        const spoke = ctx.createLinearGradient(seat.x, seat.y, cx, tableY);
        spoke.addColorStop(0, rgb(seat.colour, 0.3 * near));
        spoke.addColorStop(1, rgb(seat.colour, 0));
        ctx.strokeStyle = spoke;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(seat.x, seat.y);
        ctx.lineTo(cx, tableY);
        ctx.stroke();

        const glow = ctx.createRadialGradient(seat.x, seat.y, 0, seat.x, seat.y, 40 * near * breathe);
        glow.addColorStop(0, rgb(seat.colour, 0.5));
        glow.addColorStop(1, rgb(seat.colour, 0));
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(seat.x, seat.y, 40 * near * breathe, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = rgb(seat.colour, 0.7 * near);
        ctx.beginPath();
        ctx.ellipse(seat.x, seat.y, 15 * near * breathe, 15 * near * breathe * 0.45, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = rgb([255, 255, 255], 0.95);
        ctx.beginPath();
        ctx.arc(seat.x, seat.y, 3.6 * near + 1.4, 0, Math.PI * 2);
        ctx.fill();

        ctx.font = "500 12px \"Geist Mono Variable\", ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = rgb(seat.colour, 0.45 + 0.5 * near);
        ctx.fillText(seat.label, seat.x, seat.y + 12 + 10 * near);
      };

      const ordered = [...seats].sort((a, b) => a.depth - b.depth);
      for (const seat of ordered.filter(seat => seat.depth < 0.5)) {
        drawSeat(seat);
      }

      // The table: a block that turns, and lights up as votes reach it.
      flash *= Math.exp(-delta * 2.2);
      const halo = ctx.createRadialGradient(cx, tableY, 0, cx, tableY, cube * 2.6);
      halo.addColorStop(0, rgb(flashColour, 0.1 + flash * 0.55));
      halo.addColorStop(1, rgb(flashColour, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, tableY, cube * 2.6, 0, Math.PI * 2);
      ctx.fill();
      const turn = time * 0.35;
      const lean = 0.5;
      const corners = [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map((z) => {
        const rx = x * Math.cos(turn) + z * Math.sin(turn);
        const rz = -x * Math.sin(turn) + z * Math.cos(turn);
        return { x: cx + rx * cube * 0.5, y: tableY - y * cube * 0.5 * Math.cos(lean) + rz * cube * 0.5 * Math.sin(lean) };
      })));
      ctx.strokeStyle = `rgb(255 255 255 / ${0.55 + flash * 0.45})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (const [from, to] of CUBE_EDGES) {
        ctx.moveTo(corners[from]!.x, corners[from]!.y);
        ctx.lineTo(corners[to]!.x, corners[to]!.y);
      }
      ctx.stroke();

      for (const seat of ordered.filter(seat => seat.depth >= 0.5)) {
        drawSeat(seat);
      }

      // Votes on their way to the table.
      for (let index = pulses.length - 1; index >= 0; index--) {
        const pulse = pulses[index]!;
        const progress = (time - pulse.start) / PULSE_SECONDS;
        if (progress < 0) {
          continue;
        }
        if (progress >= 1) {
          pulses.splice(index, 1);
          flash = 1;
          flashColour = pulse.colour;
          blocks.push({ colour: pulse.colour, start: time });
          continue;
        }
        const seat = seats[pulse.seat]!;
        const lift = { x: (seat.x + cx) / 2, y: (seat.y + tableY) / 2 - radius * 0.45 };
        const at = (t: number) => ({
          x: (1 - t) ** 2 * seat.x + 2 * (1 - t) * t * lift.x + t ** 2 * cx,
          y: (1 - t) ** 2 * seat.y + 2 * (1 - t) * t * lift.y + t ** 2 * tableY,
        });
        const head = easeInOut(progress);
        for (let step = 0; step < 16; step++) {
          const t = Math.max(0, head - step * 0.018);
          const point = at(t);
          ctx.fillStyle = rgb(pulse.colour, 0.7 * (1 - step / 16));
          ctx.beginPath();
          ctx.arc(point.x, point.y, 3 * (1 - step / 20), 0, Math.PI * 2);
          ctx.fill();
        }
        const point = at(head);
        ctx.shadowColor = rgb(pulse.colour);
        ctx.shadowBlur = 18;
        ctx.fillStyle = "rgb(255 255 255)";
        ctx.beginPath();
        ctx.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    },
    dispose: () => {},
  };
}

/**
 * The committee around its table, drawn in light, each seat named by `labels`. Votes sent
 * with `vote` fly to the table.
 */
export function CommitteeOrbit({ ref, pointer, labels, className }: {
  ref: Ref<OrbitHandle>;
  pointer: RefObject<Pointer>;
  labels: Record<RoleKey, string>;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const queueRef = useRef({ pending: [] as { seat: number; inFavour: boolean }[] });
  const labelsRef = useRef(labels);
  useEffect(() => {
    labelsRef.current = labels;
  }, [labels]);
  useImperativeHandle(ref, () => ({ vote: (seat, inFavour) => void queueRef.current.pending.push({ seat, inFavour }) }), []);
  useCanvasRenderer(canvasRef, canvas => orbit(canvas, pointer, labelsRef, queueRef.current), { scale: ratio => Math.min(ratio, 2), stillTime: 3 });
  return <canvas ref={canvasRef} aria-hidden className={cn("block", className)} />;
}
