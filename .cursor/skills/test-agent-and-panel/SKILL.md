---
name: test-agent-and-panel
description: Guide for testing the Kaiad agent and the dev panel Web UI. Use when you need to test the agent, run panel tests, interact with the Kaiad UI, or verify features without using the API directly.
---

# Testing the Agent and Panel

## Core Principles

1. **No API Testing**: Never test features using the API directly (e.g., via `curl` or HTTP requests). Always use the dev panel Web UI via the `cursor-ide-browser` tool.
2. **Dev Environment Only**: Always use the dev environment for testing (`http://panel.dev.kaiad.dev`). Never test in the prod environment.
3. **User Contexts**: You must switch to the appropriate user before running commands for the agent or the panel.

## User Context Switching

When executing commands in the terminal, use the correct user context:
- **Kaiad Agent**: `sudo su claud` (or `sudo su claude` depending on the host configuration)
- **Kaiad Panel**: `sudo su kaiad`
- **App/Database/Redis (Dev)**: `firestar`

## How to Test

### 1. Panel Testing (Web UI)

Whenever you make any functional changes (especially UI, API, or workflow changes), you must verify them using the development UI.

- **URL**: `http://panel.dev.kaiad.dev` (or `https://panel.dev.kaiad.dev/`)
- **Port Context**: The Dev App runs on port `8092`.
- **Tool**: Use the `cursor-ide-browser` tool to navigate to the dev panel.
- **Login Credentials** (Dev):
  - Email: `test@example.com`
  - Password: `mypassword123`
- **Action**: Log in if necessary, interact with the feature you just changed, and ensure there are no console errors and the UI behaves as expected.
- **Manual Verification**: If the browser tool is not available, you must explicitly ask the user to verify the changes in their browser at `http://panel.dev.kaiad.dev`.

*Note: Do not say "I have completed the changes" without confirming they actually work in the live dev panel UI.*

### 2. Agent Testing

- Ensure you are operating as the agent user (e.g., `sudo su claud`).
- Run the agent locally and verify its connection to the realtime server (connecting to the API on port `8092`).
- Monitor Docker container logs and lifecycle events if applicable.

### 3. Database & Redis Verification

If your testing requires checking the state in the database or Redis:
- Use the `firestar` user context.
- **Postgres (Dev)**: Port `5001`
- **Redis (Dev)**: Port `6001`
- Both must be running via Docker using the `/data` directory.

## Testing Checklist

Before concluding your work on a feature, verify:
- [ ] Dev environment is running (using the `start-dev-environment` skill if needed).
- [ ] Tested via `http://panel.dev.kaiad.dev` (NOT via API/curl).
- [ ] UI changes were verified using `cursor-ide-browser` (or manual user check).
- [ ] Agent changes were tested running as the correct agent user (`claud`/`claude`).
- [ ] Panel commands were tested running as the `kaiad` user.
