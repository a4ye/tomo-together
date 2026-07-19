terraform {
  required_version = ">= 1.5"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.52"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }
}

# Auth: azurerm via `az login` + ARM_SUBSCRIPTION_ID env var,
# cloudflare via CLOUDFLARE_API_TOKEN env var. No secrets in this file.
provider "azurerm" {
  features {}
}

provider "cloudflare" {}

# Secret values are managed outside Terraform. Only the existing Key Vault's
# metadata is configurable, so credentials never enter Terraform inputs.
variable "crypto_key_vault_name" {
  description = "Name of the existing RBAC-enabled Key Vault that stores crypto service secrets."
  type        = string
  default     = "ht6tomoyardkv4831"

  validation {
    condition     = length(trimspace(var.crypto_key_vault_name)) > 0
    error_message = "crypto_key_vault_name must not be empty."
  }
}

variable "mongodb_db_name" {
  description = "MongoDB Atlas database containing the crypto ledger collections."
  type        = string
  default     = "ht6_crypto"

  validation {
    condition     = length(trimspace(var.mongodb_db_name)) > 0
    error_message = "mongodb_db_name must not be empty."
  }
}

variable "auth0_issuer_base_url" {
  description = "Auth0 tenant issuer URL, for example https://tenant.eu.auth0.com."
  type        = string

  validation {
    condition     = startswith(var.auth0_issuer_base_url, "https://")
    error_message = "auth0_issuer_base_url must be an HTTPS URL."
  }
}

variable "auth0_audience" {
  description = "Auth0 API identifier accepted by the main server."
  type        = string

  validation {
    condition     = length(trimspace(var.auth0_audience)) > 0
    error_message = "auth0_audience must not be empty."
  }
}

variable "allow_legacy_auth" {
  description = "Temporarily accept legacy app tokens while Auth0 rolls out. Keep false in production."
  type        = bool
  default     = false
}

variable "crypto_enabled" {
  description = "Expose the crypto service to the main server only after the service passes /ready."
  type        = bool
  default     = false
}

locals {
  location        = "westeurope"
  app_name        = "ht6-tomoyard"
  crypto_app_name = "ht6-tomoyard-crypto"
  domain          = "ht6.icinoxis.net"
  web_domain      = "ht6-app.icinoxis.net" # react-native-web build of the app itself
}

data "cloudflare_zone" "icinoxis" {
  name = "icinoxis.net"
}

resource "azurerm_resource_group" "rg" {
  name     = "ht6-tomoyard-rg"
  location = local.location
}

# This vault and its secret values are managed outside Terraform. The data
# source reads vault metadata only; App Service resolves each secret at runtime.
data "azurerm_key_vault" "crypto" {
  name                = var.crypto_key_vault_name
  resource_group_name = azurerm_resource_group.rg.name
}

# B1 is the cheapest tier that supports custom domains + TLS (~13 EUR/mo).
resource "azurerm_service_plan" "plan" {
  name                = "ht6-tomoyard-plan"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  os_type             = "Linux"
  sku_name            = "B1"
  worker_count        = 1
}

# Generated once and retained in Terraform state. Both services receive the
# same value, but it is never exposed to the client or committed to the repo.
resource "random_password" "crypto_service_token" {
  length  = 64
  special = false
}

resource "azurerm_linux_web_app" "app" {
  name                = local.app_name
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  service_plan_id     = azurerm_service_plan.plan.id
  https_only          = true

  site_config {
    always_on          = true
    websockets_enabled = true
    # No custom app_command_line: Oryx's generated startup script must run —
    # it extracts node_modules before launching `npm start` (node index.js).
    application_stack {
      node_version = "22-lts"
    }
  }

  app_settings = merge({
    # Oryx runs `npm install` on the App Service after zip deploy.
    SCM_DO_BUILD_DURING_DEPLOYMENT = "true"
    # Keep SQLite + uploads + APK outside wwwroot so deploys don't wipe them.
    DATA_DIR = "/home/data"
    # /home is an Azure Files (CIFS) mount where SQLite WAL mode cannot work.
    SQLITE_JOURNAL               = "delete"
    WEBSITE_NODE_DEFAULT_VERSION = "~22"
    # Auth0 validates API access on the main server. Legacy tokens stay off by
    # default and can only be re-enabled through an explicit Terraform input.
    AUTH0_ISSUER_BASE_URL = var.auth0_issuer_base_url
    AUTH0_AUDIENCE        = var.auth0_audience
    ALLOW_LEGACY_AUTH     = tostring(var.allow_legacy_auth)
    # The main server has no Unifold or Atlas credentials. It can only call the
    # separately isolated crypto API with this generated service credential.
    CRYPTO_SERVICE_TOKEN = random_password.crypto_service_token.result
    }, var.crypto_enabled ? {
    # Deliberately absent on the first apply: the main server treats an unset
    # URL as disabled until the deployed crypto service passes /ready.
    CRYPTO_API_URL = "https://${azurerm_linux_web_app.crypto.default_hostname}"
  } : {})

  lifecycle {
    ignore_changes = [app_settings["WEBSITE_RUN_FROM_PACKAGE"]]
  }
}

# The treasury-custody service shares the existing B1 plan to avoid another
# compute charge. The plan is pinned to one worker; Atlas remains the durable
# ledger while /home provides a persistent safety net for local service files.
resource "azurerm_linux_web_app" "crypto" {
  name                = local.crypto_app_name
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  service_plan_id     = azurerm_service_plan.plan.id
  https_only          = true

  # The deployment workflow follows the existing app-scoped publish-profile
  # pattern. FTP remains disabled; only SCM/WebDeploy basic auth is enabled.
  ftp_publish_basic_authentication_enabled       = false
  webdeploy_publish_basic_authentication_enabled = true

  identity {
    type = "SystemAssigned"
  }

  site_config {
    always_on                         = true
    app_command_line                  = "node dist/index.js"
    ftps_state                        = "Disabled"
    health_check_path                 = "/ready"
    health_check_eviction_time_in_min = 5

    application_stack {
      node_version = "22-lts"
    }
  }

  app_settings = {
    # GitHub Actions builds TypeScript and packages production dependencies, so
    # App Service must deploy the zip verbatim rather than rebuilding it.
    SCM_DO_BUILD_DURING_DEPLOYMENT      = "false"
    WEBSITE_WEBDEPLOY_USE_SCM           = "true"
    WEBSITE_NODE_DEFAULT_VERSION        = "~22"
    WEBSITES_ENABLE_APP_SERVICE_STORAGE = "true"
    NODE_ENV                            = "production"
    DATA_DIR                            = "/home/data"
    UNIFOLD_SECRET_KEY                  = "@Microsoft.KeyVault(VaultName=${data.azurerm_key_vault.crypto.name};SecretName=unifold-secret-key)"
    UNIFOLD_PUBLISHABLE_KEY             = "@Microsoft.KeyVault(VaultName=${data.azurerm_key_vault.crypto.name};SecretName=unifold-publishable-key)"
    TREASURY_ACCOUNT_ID                 = "@Microsoft.KeyVault(VaultName=${data.azurerm_key_vault.crypto.name};SecretName=treasury-account-id)"
    TREASURY_SOURCE_CHAIN_ID            = "8453"
    MONGODB_URI                         = "@Microsoft.KeyVault(VaultName=${data.azurerm_key_vault.crypto.name};SecretName=mongodb-uri)"
    MONGODB_DB_NAME                     = var.mongodb_db_name
    CRYPTO_STORE_BACKEND                = "mongodb"
    CRYPTO_SERVICE_TOKEN                = random_password.crypto_service_token.result
  }

  lifecycle {
    ignore_changes = [app_settings["WEBSITE_RUN_FROM_PACKAGE"]]
  }
}

# The crypto app resolves Key Vault references through its own managed identity.
# No human or Terraform principal is granted access by this assignment.
resource "azurerm_role_assignment" "crypto_key_vault_secrets_user" {
  scope                            = data.azurerm_key_vault.crypto.id
  role_definition_name             = "Key Vault Secrets User"
  principal_id                     = azurerm_linux_web_app.crypto.identity[0].principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

# DNS: CNAME for traffic + TXT for App Service domain verification.
# proxied=false: TLS is terminated by the App Service managed certificate.
resource "cloudflare_record" "ht6" {
  zone_id = data.cloudflare_zone.icinoxis.id
  name    = "ht6"
  type    = "CNAME"
  content = azurerm_linux_web_app.app.default_hostname
  proxied = false
  ttl     = 300
}

resource "cloudflare_record" "asuid" {
  zone_id = data.cloudflare_zone.icinoxis.id
  name    = "asuid.ht6"
  type    = "TXT"
  content = azurerm_linux_web_app.app.custom_domain_verification_id
  ttl     = 300
}

resource "azurerm_app_service_custom_hostname_binding" "ht6" {
  hostname            = local.domain
  app_service_name    = azurerm_linux_web_app.app.name
  resource_group_name = azurerm_resource_group.rg.name

  depends_on = [cloudflare_record.ht6, cloudflare_record.asuid]

  # SSL is attached by the certificate binding below; ignore drift here.
  lifecycle {
    ignore_changes = [ssl_state, thumbprint]
  }
}

resource "azurerm_app_service_managed_certificate" "cert" {
  custom_hostname_binding_id = azurerm_app_service_custom_hostname_binding.ht6.id
}

resource "azurerm_app_service_certificate_binding" "bind" {
  hostname_binding_id = azurerm_app_service_custom_hostname_binding.ht6.id
  certificate_id      = azurerm_app_service_managed_certificate.cert.id
  ssl_state           = "SniEnabled"
}

# --- second hostname: the react-native-web clone of the app ---

resource "cloudflare_record" "ht6_app" {
  zone_id = data.cloudflare_zone.icinoxis.id
  name    = "ht6-app"
  type    = "CNAME"
  content = azurerm_linux_web_app.app.default_hostname
  proxied = false
  ttl     = 300
}

resource "cloudflare_record" "asuid_app" {
  zone_id = data.cloudflare_zone.icinoxis.id
  name    = "asuid.ht6-app"
  type    = "TXT"
  content = azurerm_linux_web_app.app.custom_domain_verification_id
  ttl     = 300
}

resource "azurerm_app_service_custom_hostname_binding" "ht6_app" {
  hostname            = local.web_domain
  app_service_name    = azurerm_linux_web_app.app.name
  resource_group_name = azurerm_resource_group.rg.name

  depends_on = [cloudflare_record.ht6_app, cloudflare_record.asuid_app]

  lifecycle {
    ignore_changes = [ssl_state, thumbprint]
  }
}

resource "azurerm_app_service_managed_certificate" "cert_app" {
  custom_hostname_binding_id = azurerm_app_service_custom_hostname_binding.ht6_app.id
}

resource "azurerm_app_service_certificate_binding" "bind_app" {
  hostname_binding_id = azurerm_app_service_custom_hostname_binding.ht6_app.id
  certificate_id      = azurerm_app_service_managed_certificate.cert_app.id
  ssl_state           = "SniEnabled"
}

output "app_default_hostname" {
  value = azurerm_linux_web_app.app.default_hostname
}

output "site_url" {
  value = "https://${local.domain}"
}

output "crypto_app_name" {
  value = azurerm_linux_web_app.crypto.name
}

output "crypto_service_url" {
  value = "https://${azurerm_linux_web_app.crypto.default_hostname}"
}

output "crypto_possible_outbound_ip_addresses" {
  description = "Allow-list these App Service egress IPs in MongoDB Atlas."
  value       = azurerm_linux_web_app.crypto.possible_outbound_ip_address_list
}
