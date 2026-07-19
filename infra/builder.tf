# Fast APK builder: 32-core VM driven over SSH by the build-apk workflow.
# The workflow starts it before the build and deallocates it right after, so
# compute bills only for ~3 minutes per build (~0.10 EUR); between builds only
# the disk (~12 EUR/mo) and static IP bill. Caches persist on the OS disk.

resource "azurerm_virtual_network" "builder" {
  name                = "ht6-builder-vnet"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  address_space       = ["10.10.0.0/24"]
}

resource "azurerm_subnet" "builder" {
  name                 = "default"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.builder.name
  address_prefixes     = ["10.10.0.0/26"]
}

resource "azurerm_public_ip" "builder" {
  name                = "ht6-builder-ip"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  allocation_method   = "Static"
  sku                 = "Standard"
}

resource "azurerm_network_security_group" "builder" {
  name                = "ht6-builder-nsg"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location

  security_rule {
    name                       = "ssh"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefix      = "*" # key-only auth; GitHub runner IPs vary
    destination_address_prefix = "*"
  }
}

resource "azurerm_network_interface" "builder" {
  name                = "ht6-builder-nic"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location

  ip_configuration {
    name                          = "primary"
    subnet_id                     = azurerm_subnet.builder.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.builder.id
  }
}

resource "azurerm_network_interface_security_group_association" "builder" {
  network_interface_id      = azurerm_network_interface.builder.id
  network_security_group_id = azurerm_network_security_group.builder.id
}

resource "azurerm_linux_virtual_machine" "builder" {
  name                = "ht6-builder"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  size                = "Standard_D32as_v6"
  admin_username      = "azureuser"

  network_interface_ids = [azurerm_network_interface.builder.id]

  admin_ssh_key {
    username   = "azureuser"
    public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBdTrME8pE3d6nPYmb3pIvMIMlIeVUmg78Ghzf79TFjq ht6-builder"
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
    disk_size_gb         = 64
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }

  custom_data = filebase64("${path.module}/builder-init.yml")
}

output "builder_ip" {
  value = azurerm_public_ip.builder.ip_address
}
