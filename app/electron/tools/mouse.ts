import { execPromise } from "../utils/utils";

export async function hoverAt(x: number, y: number, durationMs = 200) {
  const durationSeconds = Math.max(0, durationMs) / 1000;
  console.log(`[COORDINATES] 🎯 Mouse hover at coordinates: (${Math.round(x)}, ${Math.round(y)}) duration: ${durationMs}ms`);
  await execPromise(`swift swift/hoverMove.swift ${Math.round(x)} ${Math.round(y)} ${durationSeconds}`);
  return { type: "hover", x, y } as const;
}

export async function rightClickAt(x: number, y: number) {
  console.log(`[COORDINATES] 🖱️ Mouse right click at coordinates: (${Math.round(x)}, ${Math.round(y)})`);
  await execPromise(`swift swift/rightClickAtCoordinates.swift ${Math.round(x)} ${Math.round(y)}`);
  return { type: "right-click", x, y } as const;
}

export async function middleClickAt(x: number, y: number) {
  console.log(`[COORDINATES] 🖱️ Mouse middle click at coordinates: (${Math.round(x)}, ${Math.round(y)})`);
  await execPromise(`swift swift/middleClickAtCoordinates.swift ${Math.round(x)} ${Math.round(y)}`);
  return { type: "middle-click", x, y } as const;
}

export async function doubleClickAt(x: number, y: number) {
  console.log(`[COORDINATES] 🖱️ Mouse double click at coordinates: (${Math.round(x)}, ${Math.round(y)})`);
  await execPromise(`swift swift/doubleClickAtCoordinates.swift ${Math.round(x)} ${Math.round(y)}`);
  return { type: "double-click", x, y } as const;
}

export async function scrollAt(x: number, y: number, deltaX = 0, deltaY = -120) {
  console.log(`[COORDINATES] 🔄 Mouse scroll at coordinates: (${Math.round(x)}, ${Math.round(y)}) delta: (${Math.round(deltaX)}, ${Math.round(deltaY)})`);
  await execPromise(`swift swift/scrollAtCoordinates.swift ${Math.round(x)} ${Math.round(y)} ${Math.round(deltaX)} ${Math.round(deltaY)}`);
  return { type: "scroll", x, y, deltaX, deltaY } as const;
}

export async function dragAndDrop(startX: number, startY: number, endX: number, endY: number, durationMs = 200) {
  const durationSeconds = Math.max(0, durationMs) / 1000;
  console.log(`[COORDINATES] ↔️ Mouse drag from coordinates: (${Math.round(startX)}, ${Math.round(startY)}) to (${Math.round(endX)}, ${Math.round(endY)}) duration: ${durationMs}ms`);
  await execPromise(`swift swift/dragAndDrop.swift ${Math.round(startX)} ${Math.round(startY)} ${Math.round(endX)} ${Math.round(endY)} ${durationSeconds}`);
  return { type: "drag-drop", startX, startY, endX, endY } as const;
} 