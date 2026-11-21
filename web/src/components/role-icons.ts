import type { LucideIcon } from "lucide-react";
import type { RoleKey } from "~/chain/committee";
import { CoinsIcon, CpuIcon, LightbulbIcon, ShieldCheckIcon } from "lucide-react";

/** The icon each seat is shown with. */
export const ROLE_ICONS: Record<RoleKey, LucideIcon> = {
  product: LightbulbIcon,
  technology: CpuIcon,
  tokenomics: CoinsIcon,
  risk: ShieldCheckIcon,
};
