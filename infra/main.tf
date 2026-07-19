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
  }
}

# Auth: azurerm via `az login` + ARM_SUBSCRIPTION_ID env var,
# cloudflare via CLOUDFLARE_API_TOKEN env var. No secrets in this file.
provider "azurerm" {
  features {}
}

provider "cloudflare" {}

# Crypto (Unifold) credentials for the deposit feature. Values live in
# terraform.tfvars (gitignored) and land as App Service settings — persistent
# on Azure, never in the repo.
variable "unifold_secret_key" {
  type      = string
  sensitive = true
  default   = ""
}

variable "unifold_publishable_key" {
  type    = string
  default = ""
}

variable "treasury_account_id" {
  type      = string
  sensitive = true
  default   = ""
}

locals {
  location   = "westeurope"
  app_name   = "ht6-tomoyard"
  domain     = "ht6.icinoxis.net"
  web_domain = "ht6-app.icinoxis.net" # react-native-web build of the app itself
}

data "cloudflare_zone" "icinoxis" {
  name = "icinoxis.net"
}

resource "azurerm_resource_group" "rg" {
  name     = "ht6-tomoyard-rg"
  location = local.location
}

# B1 is the cheapest tier that supports custom domains + TLS (~13 EUR/mo).
resource "azurerm_service_plan" "plan" {
  name                = "ht6-tomoyard-plan"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  os_type             = "Linux"
  sku_name            = "B1"
}

resource "azurerm_linux_web_app" "app" {
  name                = local.app_name
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  service_plan_id     = azurerm_service_plan.plan.id
  https_only          = true

  site_config {
    always_on = true
    # No custom app_command_line: Oryx's generated startup script must run —
    # it extracts node_modules before launching `npm start` (node index.js).
    application_stack {
      node_version = "22-lts"
    }
  }

  app_settings = {
    # Oryx runs `npm install` on the App Service after zip deploy.
    SCM_DO_BUILD_DURING_DEPLOYMENT = "true"
    # Keep SQLite + uploads + APK outside wwwroot so deploys don't wipe them.
    DATA_DIR = "/home/data"
    # /home is an Azure Files (CIFS) mount where SQLite WAL mode cannot work.
    SQLITE_JOURNAL = "delete"
    WEBSITE_NODE_DEFAULT_VERSION = "~22"
    # Crypto/deposit backend (Unifold treasury custody)
    UNIFOLD_SECRET_KEY       = var.unifold_secret_key
    UNIFOLD_PUBLISHABLE_KEY  = var.unifold_publishable_key
    TREASURY_ACCOUNT_ID      = var.treasury_account_id
    TREASURY_SOURCE_CHAIN_ID = "8453"
  }

  lifecycle {
    ignore_changes = [app_settings["WEBSITE_RUN_FROM_PACKAGE"]]
  }
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
