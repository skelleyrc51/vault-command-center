# Copies the plugin into an Obsidian vault.
# Set $VaultPath to your vault root, then run:  pwsh ./deploy.ps1

$VaultPath = "C:\Users\Monster X25\Documents\Claude\Obsidian Data"

$dest = Join-Path $VaultPath ".obsidian\plugins\vault-command-center"
if (-not (Test-Path $VaultPath)) { throw "Vault not found: $VaultPath" }
New-Item -ItemType Directory -Force -Path $dest | Out-Null

foreach ($f in "manifest.json", "main.js", "styles.css") {
    Copy-Item (Join-Path $PSScriptRoot $f) -Destination $dest -Force
    Write-Host "  -> $f"
}

Write-Host "Deployed to $dest"
Write-Host "Reload Obsidian (Ctrl+R) to pick up the changes."
