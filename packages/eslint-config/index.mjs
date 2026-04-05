const appsRelativePatterns = ["../../apps/*", "../apps/*"];

export default [
  {
    name: "sm/ban-relative-apps-imports",
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: appsRelativePatterns,
        },
      ],
    },
  },
  {
    name: "sm/domain-boundaries",
    files: ["packages/domain/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["fastify", "@fastify/*", "bullmq", "ioredis", "pg"],
              message:
                "Domain must not depend on Fastify, BullMQ, Redis clients, or pg.",
            },
            ...appsRelativePatterns,
          ],
        },
      ],
    },
  },
  {
    name: "sm/contracts-boundaries",
    files: ["packages/contracts/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@sm/api", "@sm/worker", "@sm/web", "@sm/agent"],
              message: "Contracts must not depend on application packages.",
            },
            ...appsRelativePatterns,
          ],
        },
      ],
    },
  },
  {
    name: "sm/web-boundaries",
    files: ["apps/web/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@sm/db",
                "@sm/queue",
                "pg",
                "ioredis",
                "bullmq",
              ],
              message:
                "Web must not import database, queue, or low-level server dependencies directly.",
            },
            ...appsRelativePatterns,
          ],
        },
      ],
    },
  },
  {
    name: "sm/db-boundaries",
    files: ["packages/db/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@sm/api", "@sm/worker", "@sm/web"],
              message: "DB package must not depend on application or web layers.",
            },
            ...appsRelativePatterns,
          ],
        },
      ],
    },
  },
];
