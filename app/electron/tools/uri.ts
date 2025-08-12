// import { ExecException } from "node:child_process"; // Unused
import { execPromise } from "../utils/utils";

export interface OpenUriReturnType {
  type: "uri";
  error: string;
}
export async function openUri(body: string): Promise<OpenUriReturnType> {
  const uri = body;
  try {
    await execPromise(`open -g ${uri}`);
    return { type: "uri", error: "" };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { type: "uri", error: errorMessage };
  }
}
