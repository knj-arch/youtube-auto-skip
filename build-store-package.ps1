[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$taskRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
# Generated scripts stay at the extension root for ordinary unpacked installs.
# Refuse to publish stale JavaScript after editing its TypeScript source.
& node (Join-Path $taskRoot 'scripts/build.mjs') --check
if ($LASTEXITCODE -ne 0) {
    throw 'Generated scripts are missing or stale. Run npm ci and npm run build first.'
}
$taskManifestPath = Join-Path $taskRoot 'manifest.json'
$taskManifest = Get-Content -LiteralPath $taskManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($taskManifest.manifest_version -ne 3 -or $taskManifest.version -notmatch '^\d+(\.\d+){0,3}$') {
    throw 'Expected a Manifest V3 extension with a valid numeric version.'
}

# An explicit allowlist keeps store artwork and documentation out of the upload.
$taskFiles = @('manifest.json', 'content.js', 'background.js', 'popup.html', 'popup.css', 'popup.js')
$taskFiles += @($taskManifest.icons.PSObject.Properties.Value)
$taskFiles = @($taskFiles | Sort-Object -Unique)
$taskRootPrefix = $taskRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
foreach ($taskFile in $taskFiles) {
    $taskAbsolute = [System.IO.Path]::GetFullPath((Join-Path $taskRoot $taskFile))
    if (-not $taskAbsolute.StartsWith($taskRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Package file is outside the extension directory: $taskFile"
    }
    if (-not (Test-Path -LiteralPath $taskAbsolute -PathType Leaf)) {
        throw "Missing package file: $taskFile"
    }
}

$taskDist = [System.IO.Path]::GetFullPath((Join-Path $taskRoot 'dist'))
if (-not $taskDist.StartsWith($taskRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Output directory must be within the extension directory.'
}
New-Item -ItemType Directory -Path $taskDist -Force | Out-Null
$taskOutput = [System.IO.Path]::GetFullPath((Join-Path $taskDist "youtube-auto-skip-$($taskManifest.version).zip"))
$taskTemp = [System.IO.Path]::GetFullPath((Join-Path $taskDist "$([System.Guid]::NewGuid()).building.zip"))
$taskDistPrefix = $taskDist + [System.IO.Path]::DirectorySeparatorChar
foreach ($taskTarget in @($taskTemp, $taskOutput)) {
    if (-not $taskTarget.StartsWith($taskDistPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Archive target must stay within the verified output directory.'
    }
}

$taskArchive = [System.IO.Compression.ZipFile]::Open($taskTemp, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($taskFile in $taskFiles) {
        $taskAbsolute = Join-Path $taskRoot $taskFile
        $taskEntryName = $taskFile.Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $taskArchive, $taskAbsolute, $taskEntryName, [System.IO.Compression.CompressionLevel]::Optimal
        ) | Out-Null
    }
} finally {
    $taskArchive.Dispose()
}

$taskCheck = [System.IO.Compression.ZipFile]::OpenRead($taskTemp)
try {
    if ($null -eq $taskCheck.GetEntry('manifest.json') -or $taskCheck.Entries.Count -ne $taskFiles.Count) {
        throw 'Archive validation failed: manifest.json must be at the ZIP root.'
    }
} finally {
    $taskCheck.Dispose()
}

# Replace only this generated ZIP file, after checking its absolute target.
if (Test-Path -LiteralPath $taskOutput -PathType Leaf) {
    Remove-Item -LiteralPath $taskOutput
}
Move-Item -LiteralPath $taskTemp -Destination $taskOutput
Write-Output "Chrome Web Store package: $taskOutput"
Write-Output "Runtime files: $($taskFiles.Count); manifest.json is at the archive root."
