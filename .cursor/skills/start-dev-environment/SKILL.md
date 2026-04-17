---
name: start-dev-environment
description: Start the local development environment using Docker Compose. Use when the user asks to start the dev environment, run the app locally, or bring up the dev stack.
---

# Start Dev Environment

## Instructions

When starting the development environment locally, follow these steps:

1. Ensure you are running commands as the appropriate user. For dev applications, you should use the `firestar` user (e.g. `sudo su firestar`).
2. Use the dev Docker Compose file to start the stack:
   ```bash
   docker compose -f env/dev/docker-compose.yml up -d
   ```
3. The dev environment uses the following ports:
   - App: 8092
   - Postgres: 5001
   - Redis: 6001
4. Remember that the dev environment uses separate databases from prod, and stores its Docker volumes in the `/data` directory.
5. **Always** test the dev UI using the external URL: `http://panel.dev.kaiad.dev/` or `https://panel.dev.kaiad.dev/`. Do not test directly via localhost.
