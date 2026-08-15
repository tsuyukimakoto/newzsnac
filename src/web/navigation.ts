export function moveSelection(current: number, direction: -1 | 1, itemCount: number): number {
  if (itemCount <= 0) return 0;
  return Math.max(0, Math.min(itemCount - 1, current + direction));
}
