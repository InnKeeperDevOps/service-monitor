---
name: start-prod-environment
description: Start the local production environment using Docker Compose. Use when the user asks to start the prod environment, run the production app locally, or bring up the prod stack.
---

# Start Prod Environment

## Instructions

When starting the production environment locally, follow these steps:

1. Ensure you are running commands as the appropriate user.
2. Use the prod Docker Compose file to start the stack:
   ```bash
   docker compose -f env/prod/docker-compose.yml up -d
   ```
3. The prod environment uses the following ports:
   - App: 8091
   - Postgres: 5002
   - Redis: 6002
4. Remember that the prod environment uses separate databases from dev, and stores its Docker volumes in the `/data` directory.
5. The production UI is available at: `http://panel.kaiad.dev/` or `https://panel.kaiad.dev/`.
