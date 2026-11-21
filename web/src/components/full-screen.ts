/**
 * Pages that fill the whole window without the site header: the landing page, which has a
 * header of its own, and the projector's meeting room.
 */
export function isFullScreen(pathname: string): boolean {
  return pathname === "/" || pathname === "/screen";
}
