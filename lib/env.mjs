/**
 * Loads bot/.env into process.env — the one secrets file for the whole
 * marketing pipeline (Telegram, Gemini, Upload-Post). Real environment
 * variables win, so a server's env store overrides the file.
 *
 * A deliberately small reader rather than the dotenv dependency: this is a
 * standalone tool outside backend/, and a node_modules tree to read a dozen
 * lines is not worth it.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { MARKETING_ROOT } from "./paths.mjs";

export const ENV_FILE = join(MARKETING_ROOT, "bot", ".env");

export function loadDotEnv(file = ENV_FILE) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv();
