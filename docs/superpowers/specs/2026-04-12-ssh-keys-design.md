# Replace GitHub Integration with Generic Git + SSH Keys

## Overview
This design document details the replacement of the existing GitHub App integration with a generic Git + SSH key integration. The goal is to remove the hard dependency on GitHub, allowing the agent to clone and push to any Git repository (GitLab, Bitbucket, self-hosted, or GitHub) using standard SSH protocols.

## 1. Data Model & API (Backend)

We will introduce a new core entity: **SSH Keys**. These belong to a Tenant.

- **New Table:** `ssh_keys` in PostgreSQL.
  - `id` (uuid, pk)
  - `tenant_id` (varchar, fk)
  - `name` (varchar)
  - `type` (varchar: 'uploaded' | 'local_path')
  - `private_key_encrypted` (text, nullable)
  - `local_path` (varchar, nullable)
  - `created_at`, `updated_at`
- **Service Changes:** The `monitored_services` table will drop `github_repo` and replace it with:
  - `git_repo_url` (varchar) (e.g. `git@github.com:org/repo.git`)
  - `ssh_key_id` (uuid, fk to `ssh_keys`)
- **Removal of GitHub:**
  - Drop the `github_app_installations` table.
  - Remove all GitHub app settings from the tenant configuration and setup wizard.
  - Remove all GitHub webhook ingestion routes (`/webhooks/github`).
  - Remove the entire `@sm/github` package and BullMQ jobs related to GitHub (`githubMutationJobSchema`, etc.).
- **New API Routes:** CRUD operations for `/api/v1/ssh-keys` under the tenant context.

## 2. User Interface (Frontend)

### Sidebar Navigation
- Remove any existing "GitHub App" or "GitHub Install" menu items.
- Add a new "SSH Keys" menu item in the left sidebar, placed near "Services" and "Tenants".

### SSH Keys Page (CRUD)
- **List View:** A table showing all SSH Keys for the current Tenant. Columns: `Name`, `Type` (Uploaded/Local Path), and `Created At`.
- **Add Key Modal/Form:**
  - `Name`: e.g., "Prod Server Key".
  - `Type`: Radio button or toggle for "Upload Private Key" or "Local Path on Agent".
  - If "Upload" is selected: a textarea to paste the PEM/SSH Private Key.
  - If "Local Path" is selected: a text input for the path (e.g., `~/.ssh/id_rsa`).
- **Edit/Delete Actions:** Ability to rename, change the path, or delete keys. We won't allow re-viewing the uploaded private key for security reasons; it can only be overwritten or deleted.

### Services Page Updates
- Remove the "GitHub Repository" text input (e.g., `acme/app`).
- Add a new "Git Repository URL" text input (e.g., `git@github.com:acme/app.git`).
- Add a new "SSH Key" dropdown to select an SSH key from the tenant's configured keys. This is required if the `git_repo_url` uses SSH.
- Update the "Agent workload source" dropdown to rename `github_repo` to `git_repo` (Git Repository).

### Settings & Setup Wizard
- Remove the GitHub App credentials (App ID, PEM, Webhook Secret) from the Setup Wizard (`SetupWizardPage.tsx`) and Tenant Configuration (`TenantConfigurationPage.tsx`).
- The system will no longer require a GitHub App to be configured to work.

## 3. Agent Execution (Data Flow)

When a remediation job or a generic clone/push operation occurs, the control plane needs to pass the Git URL and SSH key instructions down to the Go agent.

1. **Job Enqueue:** The worker looks up the `git_repo_url` and `ssh_key` for the affected service.
2. **WebSocket Message:** The control plane constructs an `AgentCommand` payload. Instead of passing GitHub tokens, it passes:
   - `gitUrl`: `git@github.com:acme/app.git`
   - `sshKeyType`: `uploaded` or `local_path`
   - `sshKeyValue`: The decrypted private key text (if `uploaded`) OR the file path (if `local_path`).
3. **Agent Action (Go):**
   - If `uploaded`: The agent creates a secure temporary file (e.g., `/tmp/kaiad_ssh_key_XXX` with `0600` permissions), writes the `sshKeyValue` to it, and sets `GIT_SSH_COMMAND="ssh -i /tmp/kaiad_ssh_key_XXX -o StrictHostKeyChecking=no"`.
   - If `local_path`: The agent sets `GIT_SSH_COMMAND="ssh -i <local_path> -o StrictHostKeyChecking=no"`.
   - The agent then executes the `git clone`, `git commit`, and `git push` commands.
   - If `uploaded`, the agent deletes the temporary key file immediately after the Git operations complete (using `defer os.Remove(...)`).

## 4. Encryption
Uploaded private keys must be encrypted at rest in PostgreSQL.
- Utilize a single symmetric encryption key provided via environment variable (e.g., `KAIAD_ENCRYPTION_KEY`).
- Use standard AES-256-GCM for encryption/decryption in the Fastify API layer before inserting/reading from the `ssh_keys` table.

## 5. Security & Constraints
- **StrictHostKeyChecking=no**: Required to prevent interactive prompts for unknown hosts on the agent's machine.
- **Ephemeral keys**: Uploaded keys must be deleted from the agent's filesystem even if the Git command fails.
- **No Private Key Read API**: The `/api/v1/ssh-keys` endpoint must NEVER return the decrypted private key to the frontend. It should only return boolean `has_key` or `null`.
