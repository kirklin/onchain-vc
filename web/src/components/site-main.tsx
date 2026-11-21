"use client";

import type { ReactNode } from "react";
import { cn } from "cn";
import { usePathname } from "next/navigation";
import { isFullScreen } from "./full-screen";

export function SiteMain({ children }: { children: ReactNode }) {
  const full = isFullScreen(usePathname());
  return <main className={cn(full ? "w-full" : "mx-auto w-full max-w-6xl px-5 pt-6 pb-28 sm:px-8")}>{children}</main>;
}
