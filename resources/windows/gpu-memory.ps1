[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function To-Int64([object]$value) {
    if ($null -eq $value -or "$value" -eq '') { return [int64]0 }
    return [Convert]::ToInt64($value, [Globalization.CultureInfo]::InvariantCulture)
}

$items = @()
$nvidia = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
if ($nvidia) {
    $rows = & $nvidia.Source --query-gpu=name,memory.total,memory.used,memory.free --format=csv,noheader,nounits 2>$null
    foreach ($row in $rows) {
        $parts = $row -split ',' | ForEach-Object { $_.Trim() }
        if ($parts.Count -ge 4) {
            $total = (To-Int64 $parts[1]) * [int64]1MB
            $used = (To-Int64 $parts[2]) * [int64]1MB
            $free = (To-Int64 $parts[3]) * [int64]1MB
            $items += [pscustomobject]@{
                name = $parts[0]
                totalBytes = $total
                usedBytes = $used
                freeBytes = $free
                dedicated = $true
                source = 'nvidia-smi'
            }
        }
    }
}

if ($items.Count -eq 0) {
    $controllers = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue
    foreach ($gpu in $controllers) {
        $total = To-Int64 $gpu.AdapterRAM
        # WMI não fornece uso atual confiável. Mantemos zero/total sem inventar precisão.
        $used = [int64]0
        $free = if ($total -gt 0) { [Math]::Max([int64]0, [int64]($total - $used)) } else { [int64]0 }
        $items += [pscustomobject]@{
            name = [string]$gpu.Name
            totalBytes = $total
            usedBytes = $used
            freeBytes = $free
            dedicated = $false
            source = 'windows-cim'
        }
    }
}

@($items) | ConvertTo-Json -Depth 4 -Compress
