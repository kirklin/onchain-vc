"use client";

import type { RefObject } from "react";
import type { Pointer, Renderer } from "./motion";
import { cn } from "cn";
import { useRef } from "react";
import { ROLES } from "~/chain/committee";
import { follow, SEAT_LIGHT, useCanvasRenderer } from "./motion";

const VERTEX = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}`;

// Four bands of light, one per seat, drifting across the lower half. The canvas is drawn at a
// fifth of the page's resolution and scaled up without smoothing, which gives the light its
// coarse pixels.
const FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 size;
uniform float time;
uniform vec2 pointer;
uniform vec3 colors[4];
out vec4 colour;

float hash(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 5; i++) {
    value += amplitude * noise(p);
    p = p * 2.03 + 17.1;
    amplitude *= 0.5;
  }
  return value;
}

void main() {
  vec2 uv = gl_FragCoord.xy / size;
  vec2 p = vec2(uv.x * size.x / size.y, uv.y);
  vec2 warp = vec2(fbm(p * 1.3 + vec2(time * 0.035, 0.0)), fbm(p * 1.3 + vec2(4.7, -time * 0.03)));
  vec3 light = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    float f = float(i);
    float centre = 0.1 + 0.085 * f + 0.06 * sin(p.x * 0.9 + time * 0.09 + f * 2.1) + (warp.y - 0.5) * 0.3 - pointer.y * 0.03;
    float spread = 0.03 + 0.05 * warp.x;
    float band = exp(-pow((uv.y - centre) / spread, 2.0));
    float reach = smoothstep(0.08 * f - 0.15, 1.0, uv.x + (warp.x - 0.5) * 0.45 + pointer.x * 0.04);
    float streak = 0.35 + 1.4 * pow(noise(vec2(p.x * 5.0 - time * (0.5 + 0.15 * f), f * 9.0 + uv.y * 55.0)), 2.5);
    light += colors[i] * band * reach * streak;
  }
  light += mix(colors[2], colors[1], uv.x) * 0.07 * smoothstep(0.7, 0.0, uv.y) * fbm(p * 2.0 + time * 0.02);
  light = 1.0 - exp(-light * 1.4);
  colour = vec4(light, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`The light field's shader did not compile: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

function lightField(canvas: HTMLCanvasElement, pointer: RefObject<Pointer>): Renderer {
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, powerPreference: "low-power" });
  // Without WebGL the hero keeps its plain black background.
  if (gl === null) {
    return { resize: () => {}, draw: () => {}, dispose: () => {} };
  }

  const program = gl.createProgram();
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`The light field's shaders did not link: ${gl.getProgramInfoLog(program)}`);
  }
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  gl.uniform3fv(gl.getUniformLocation(program, "colors"), ROLES.flatMap(role => SEAT_LIGHT[role].map(channel => channel / 255)));
  const size = gl.getUniformLocation(program, "size");
  const time = gl.getUniformLocation(program, "time");
  const pointerAt = gl.getUniformLocation(program, "pointer");
  const eased = { x: 0, y: 0 };

  return {
    resize: (width, height) => {
      gl.viewport(0, 0, width, height);
      gl.uniform2f(size, width, height);
    },
    draw: (seconds, delta) => {
      follow(eased, pointer.current, delta);
      gl.uniform1f(time, seconds);
      gl.uniform2f(pointerAt, eased.x, eased.y);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose: () => {
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
    },
  };
}

/** The hero's moving light, one colour for each seat. */
export function LightField({ pointer, className }: { pointer: RefObject<Pointer>; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useCanvasRenderer(canvasRef, canvas => lightField(canvas, pointer), { scale: () => 0.2, stillTime: 40 });
  return <canvas ref={canvasRef} aria-hidden className={cn("[image-rendering:pixelated]", className)} />;
}
