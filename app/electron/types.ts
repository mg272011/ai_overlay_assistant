import { AppleScriptReturnType } from "./tools/appleScript";
import { BashScriptReturnType } from "./tools/bash";
import { ClickReturnType } from "./tools/click";
import { KeyReturnType } from "./tools/key";
import { OpenUriReturnType } from "./tools/uri";

export interface Window {
  pid: string;
  name: string;
  app: string;
}

export interface Element {
  id: number;
  AXRole?: string;
  AXTitle?: string;
  AXHelp?: string;
  AXValue?: string;
  AXURL?: string;
  AXDescription?: string;
  AXSubrole?: string;
  AXFrame?: string;
}

export type ActionResult =
  | AppleScriptReturnType
  | OpenUriReturnType
  | BashScriptReturnType
  | ClickReturnType
  | KeyReturnType
  | { type: "cursor-move"; x: number; y: number }
  | { type: "cursor-click"; x: number; y: number }
  | { type: "cursor-drag-start"; x: number; y: number }
  | { type: "cursor-drag-move"; x: number; y: number }
  | { type: "cursor-drag-end"; x: number; y: number }
  | { type: "cursor-scroll"; x: number; y: number }
  | { type: "unknown tool" };
