import re
import sys

def update_settings():
    path = "apps/web/src/features/settings/SettingsPage.tsx"
    with open(path, "r") as f:
        content = f.read()

    # Remove GitBranch import
    content = content.replace("Settings, Key, GitBranch, Lock", "Settings, Key, Lock")

    # Remove canManageGithub
    content = re.sub(r'  const canManageGithub = [^\n]+\n', '', content)

    # Remove Github state variables
    state_vars = r'''  const \[githubAppId.*?setIsSavingGithub\(false\);\n  const \[tokens'''
    content = re.sub(state_vars, '  const [tokens', content, flags=re.DOTALL)

    # Remove Github useEffect
    useEffect_github = r'''  useEffect\(\(\) => \{\n    api\n      \.getGithubAppSettings[^\}]+} \}, \[canManageGithub\]\);\n'''
    content = re.sub(useEffect_github, '', content, flags=re.DOTALL)

    # Remove handleSaveGithubApp
    handle_save = r'''  async function handleSaveGithubApp[^\}]+finally \{\n      setIsSavingGithub\(false\);\n    \}\n  \}\n'''
    content = re.sub(handle_save, '', content, flags=re.DOTALL)

    # Remove Github JSX block
    github_jsx = r'''      \{\/\* GitHub App — server credentials; per-tenant install lives under Tenants → Configure \*\/\}[\s\S]+?      \}[\s\S]+?    </section>'''
    content = re.sub(github_jsx, '    </section>', content)

    with open(path, "w") as f:
        f.write(content)

def update_setup_wizard():
    path = "apps/web/src/features/setup/SetupWizardPage.tsx"
    with open(path, "r") as f:
        content = f.read()

    # Remove github from STEPS
    content = content.replace('"welcome" | "infra" | "admin" | "github" | "oauth" | "tenant" | "k8s" | "review"', '"welcome" | "infra" | "admin" | "oauth" | "tenant" | "k8s" | "review"')
    content = content.replace('["welcome", "infra", "admin", "github", "oauth", "tenant", "k8s", "review"]', '["welcome", "infra", "admin", "oauth", "tenant", "k8s", "review"]')
    content = re.sub(r'  github: "GitHub App",\n', '', content)

    # Remove state vars
    content = re.sub(r'  const \[githubAppId.*?setGithubWebhookSecret\(""\);\n', '', content, flags=re.DOTALL)

    # Remove from completeSetup payload
    content = re.sub(r'        githubAppId:[^\n]+\n        githubAppPrivateKeyPem:[^\n]+\n        githubWebhookSecret:[^\n]+\n', '', content)

    # Remove case "github":
    case_github = r'''      case "github":[\s\S]*?      case "oauth":'''
    content = re.sub(case_github, '      case "oauth":', content)

    # Remove from isSkippable
    content = content.replace('currentStep === "github" || currentStep === "oauth"', 'currentStep === "oauth"')

    # Remove from ReviewRow
    content = re.sub(r'              <ReviewRow label="GitHub App ID"[^\n]+\n              <ReviewRow label="GitHub Webhook Secret"[^\n]+\n              <ReviewRow label="GitHub Private Key"[^\n]+\n', '', content)

    with open(path, "w") as f:
        f.write(content)


def update_tenant_config():
    path = "apps/web/src/features/tenants/TenantConfigurationPage.tsx"
    with open(path, "r") as f:
        content = f.read()

    # Remove TenantGithubInstallationSection
    content = re.sub(r'import \{ TenantGithubInstallationSection \} from "\./TenantGithubInstallationSection\.js";\n', '', content)
    content = re.sub(r'  const canManageServerCredentials = user\?\.role === "owner" \|\| user\?\.role === "admin";\n\n', '', content)
    
    jsx_to_remove = r'''      \{aligned && \(\n        <TenantGithubInstallationSection\n          tenantActive=\{aligned\}\n          canManageServerCredentials=\{canManageServerCredentials\}\n        \/>\n      \)\}\n\n'''
    content = re.sub(jsx_to_remove, '', content)

    with open(path, "w") as f:
        f.write(content)

update_settings()
update_setup_wizard()
update_tenant_config()
