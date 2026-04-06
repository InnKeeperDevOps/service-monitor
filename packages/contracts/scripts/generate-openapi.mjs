import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const outputDir = new URL("../openapi", import.meta.url).pathname;
const outputPath = join(outputDir, "openapi.yaml");

const yaml = `openapi: 3.1.0
info:
  title: Kaiad API
  version: 0.1.0
paths:
  /health:
    get:
      operationId: getHealth
      description: Liveness probe
      responses:
        '200':
          description: OK
  /ready:
    get:
      operationId: getReady
      description: Readiness probe
      responses:
        '200':
          description: Ready
  /api/v1/auth/login:
    post:
      operationId: postAuthLogin
      description: Exchange credentials for a session
      responses:
        '200':
          description: Session established
        '401':
          description: Unauthorized
  /api/v1/me:
    get:
      operationId: getCurrentUser
      description: Current authenticated user
      responses:
        '200':
          description: Authenticated user
        '401':
          description: Unauthorized
  /api/v1/session/active-tenant:
    post:
      operationId: postSessionActiveTenant
      description: Switch active tenant for the current session
      responses:
        '200':
          description: Updated session user payload
        '401':
          description: Unauthorized
        '403':
          description: Forbidden
  /api/v1/tenants:
    post:
      operationId: postTenant
      description: Create a tenant and switch the current session to it
      responses:
        '200':
          description: Current user payload after creating tenant
        '401':
          description: Unauthorized
        '409':
          description: Tenant id already in use
        '500':
          description: Internal error
  /api/v1/tenants/{tenantId}:
    delete:
      operationId: deleteTenant
      description: Delete a tenant (owner or admin membership on that tenant)
      parameters:
        - name: tenantId
          in: path
          required: true
          schema:
            type: string
      responses:
        '204':
          description: Tenant deleted
        '401':
          description: Unauthorized
        '403':
          description: Forbidden
        '404':
          description: Tenant not found
        '409':
          description: Protected default webhook tenant
  /api/v1/settings:
    get:
      operationId: getSettings
      description: Tenant or user settings
      responses:
        '200':
          description: Settings
        '401':
          description: Unauthorized
    post:
      operationId: updateSettings
      description: Update settings
      responses:
        '200':
          description: Updated
        '401':
          description: Unauthorized
        '403':
          description: Forbidden
  /api/v1/services:
    get:
      operationId: listServices
      description: List monitored services
      responses:
        '200':
          description: Service list
        '401':
          description: Unauthorized
    post:
      operationId: createService
      description: Register a service
      responses:
        '201':
          description: Created
        '401':
          description: Unauthorized
        '403':
          description: Forbidden
  /api/v1/services/{id}:
    delete:
      operationId: deleteService
      description: Remove a monitored service
      responses:
        '200':
          description: Deleted
        '401':
          description: Unauthorized
        '404':
          description: Not found
  /api/v1/incidents:
    get:
      operationId: listIncidents
      description: List incidents
      responses:
        '200':
          description: Incident list
        '401':
          description: Unauthorized
  /api/v1/incidents/{id}:
    get:
      operationId: getIncident
      description: Incident detail
      responses:
        '200':
          description: Incident
        '401':
          description: Unauthorized
        '404':
          description: Not found
  /api/v1/incidents/{id}/status:
    patch:
      operationId: patchIncidentStatus
      description: Update incident status
      responses:
        '200':
          description: Updated
        '401':
          description: Unauthorized
        '404':
          description: Not found
  /api/v1/agents:
    get:
      operationId: listAgents
      description: List agents
      responses:
        '200':
          description: Agent list
        '401':
          description: Unauthorized
  /api/v1/agents/enrollment-tokens:
    get:
      operationId: listEnrollmentTokens
      description: List enrollment tokens
      responses:
        '200':
          description: Token list
        '401':
          description: Unauthorized
    post:
      operationId: createEnrollmentToken
      description: Issue an enrollment token
      responses:
        '201':
          description: Created
        '401':
          description: Unauthorized
        '403':
          description: Forbidden
  /api/v1/agents/enrollment-tokens/{tokenId}/deactivate:
    post:
      operationId: deactivateEnrollmentToken
      description: Revoke an unused enrollment token before it is consumed or expires
      parameters:
        - name: tokenId
          in: path
          required: true
          schema:
            type: string
      responses:
        '204':
          description: Token deactivated
        '401':
          description: Unauthorized
        '404':
          description: Token not found
        '409':
          description: Token cannot be deactivated
  /api/v1/github/installations:
    get:
      operationId: listGithubInstallations
      description: List GitHub App installations
      responses:
        '200':
          description: Installations
        '401':
          description: Unauthorized
    post:
      operationId: connectGithubInstallation
      description: Connect or register a GitHub installation
      responses:
        '200':
          description: Connected
        '401':
          description: Unauthorized
        '403':
          description: Forbidden
  /api/v1/github/policy/check:
    post:
      operationId: postGithubPolicyCheck
      description: Evaluate policy for a GitHub event or resource
      responses:
        '200':
          description: Policy result
        '401':
          description: Unauthorized
        '403':
          description: Forbidden
  /api/v1/workflows:
    get:
      operationId: listWorkflows
      description: List workflows
      responses:
        '200':
          description: Workflows
        '401':
          description: Unauthorized
    post:
      operationId: createWorkflow
      description: Create a workflow
      responses:
        '201':
          description: Created
        '401':
          description: Unauthorized
        '403':
          description: Forbidden
  /webhooks/github:
    post:
      operationId: postGithubWebhook
      description: GitHub App webhook delivery
      responses:
        '200':
          description: Accepted
        '401':
          description: Unauthorized
        '403':
          description: Forbidden
`;

await mkdir(outputDir, { recursive: true });
await writeFile(outputPath, yaml, "utf8");
console.log(`OpenAPI written to ${outputPath}`);
