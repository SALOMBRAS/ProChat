[CmdletBinding()]
param(
    [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$serverName = 'kit-mcp'
$packageSpec = '@luanpdd/kit-mcp@1.46.0'
$header = "[mcp_servers.$serverName]"
$expectedBlock = @(
    $header
    'command = "npx"'
    "args = [`"-y`", `"$packageSpec`"]"
    'env = { KIT_MCP_NO_UI = "1" }'
    'enabled = true'
    'enabled_tools = ["kit"]'
    'default_tools_approval_mode = "prompt"'
)

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
    $ConfigPath = Join-Path $codexHome 'config.toml'
}

$npx = Get-Command npx.cmd -ErrorAction SilentlyContinue
if (-not $npx) {
    $npx = Get-Command npx -ErrorAction SilentlyContinue
}
if (-not $npx) {
    throw 'npx nao esta disponivel. Instale uma versao compativel do Node.js antes de configurar o Kit-MCP.'
}

$configDirectory = Split-Path -Parent $ConfigPath
if (-not (Test-Path -LiteralPath $configDirectory -PathType Container)) {
    [System.IO.Directory]::CreateDirectory($configDirectory) | Out-Null
}

$content = if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
    [System.IO.File]::ReadAllText($ConfigPath)
} else {
    ''
}

$newline = if ($content.Contains("`r`n")) { "`r`n" } else { "`n" }
$lines = if ($content.Length -eq 0) { @() } else { @([regex]::Split($content, '\r?\n')) }
while ($lines.Count -gt 0 -and $lines[-1] -eq '') {
    $lines = @($lines | Select-Object -First ($lines.Count - 1))
}

$matches = @()
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i].Trim() -eq $header) {
        $matches += $i
    }
}

if ($matches.Count -gt 1) {
    throw "Foram encontradas secoes duplicadas $header. Revise o arquivo manualmente; nada foi alterado."
}

if ($matches.Count -eq 1) {
    $start = $matches[0]
    $end = $lines.Count
    for ($i = $start + 1; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^\s*\[') {
            $end = $i
            break
        }
    }

    $currentBlock = @($lines[$start..($end - 1)] | Where-Object { $_.Trim().Length -gt 0 })
    if ($currentBlock -notcontains 'command = "npx"') {
        throw "A secao $header ja existe com comando diferente. Nada foi sobrescrito."
    }
    $escapedPackage = [regex]::Escape($packageSpec)
    $argsPattern = '^args\s*=\s*\[\s*"-y"\s*,\s*"' + $escapedPackage + '"\s*\]\s*$'
    if (-not ($currentBlock | Where-Object { $_ -match $argsPattern })) {
        throw "A secao $header ja existe com argumentos diferentes. Nada foi sobrescrito."
    }

    foreach ($line in $currentBlock) {
        if (($expectedBlock -notcontains $line) -and ($line -notmatch $argsPattern)) {
            throw "A secao $header contem uma opcao nao reconhecida: $line. Nada foi sobrescrito."
        }
    }

    $before = if ($start -gt 0) { @($lines[0..($start - 1)]) } else { @() }
    $after = if ($end -lt $lines.Count) { @($lines[$end..($lines.Count - 1)]) } else { @() }
    $updatedLines = @($before + $expectedBlock + $after)
} else {
    $updatedLines = @($lines)
    if ($updatedLines.Count -gt 0 -and $updatedLines[-1] -ne '') {
        $updatedLines += ''
    }
    $updatedLines += $expectedBlock
}

$updated = ($updatedLines -join $newline) + $newline
if ($updated -eq $content) {
    Write-Output "Kit-MCP $packageSpec ja esta configurado com allowlist consultiva em $ConfigPath"
    exit 0
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($ConfigPath, $updated, $utf8NoBom)
Write-Output "Kit-MCP $packageSpec configurado em $ConfigPath; outros servidores MCP foram preservados."
