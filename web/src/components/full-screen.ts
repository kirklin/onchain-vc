/** Pages that fill the whole window, without the site header: the projector's meeting room. */
export function isFullScreen(pathname: string): boolean {
  return pathname === "/screen";
}
