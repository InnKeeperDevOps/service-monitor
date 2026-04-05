import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/*",
  "apps/api",
  "apps/worker",
  "apps/web",
  "e2e/acceptance"
]);
