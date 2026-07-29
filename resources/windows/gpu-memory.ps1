$ErrorActionPreference = 'Stop'

function Convert-MiBToBytes([double]$value) {
  return [int64]($value * 1024 * 1024)
}

$results = @()
$nvidia = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
if ($nvidia) {
  try {
    $lines = & $nvidia.Source --query-gpu=name,memory.total,memory.used,memory.free --format=csv,noheader,nounits 2>$null
    foreach ($line in $lines) {
      $parts = $line -split ',' | ForEach-Object { $_.Trim() }
      if ($parts.Count -ge 4) {
        $results += [pscustomobject]@{
          name = $parts[0]
          vendor = 'NVIDIA'
          totalBytes = Convert-MiBToBytes ([double]$parts[1])
          usedBytes = Convert-MiBToBytes ([double]$parts[2])
          availableBytes = Convert-MiBToBytes ([double]$parts[3])
          dedicated = $true
          source = 'nvidia-smi'
          note = 'Memória dedicada informada pelo driver NVIDIA.'
        }
      }
    }
  } catch { }
}

if ($results.Count -eq 0) {
  $controllers = @(Get-CimInstance Win32_VideoController | Where-Object { $_.Name })
  $dedicatedUsage = 0
  $sharedUsage = 0
  try {
    $samples = (Get-Counter '\GPU Adapter Memory(*)\Dedicated Usage','\GPU Adapter Memory(*)\Shared Usage' -ErrorAction Stop).CounterSamples
    foreach ($sample in $samples) {
      if ($sample.Path -like '*Dedicated Usage') { $dedicatedUsage += [int64]$sample.CookedValue }
      elseif ($sample.Path -like '*Shared Usage') { $sharedUsage += [int64]$sample.CookedValue }
    }
  } catch { }

  foreach ($controller in $controllers) {
    $total = 0
    if ($controller.AdapterRAM) { $total = [int64]$controller.AdapterRAM }
    $vendor = if ($controller.Name -match 'NVIDIA') { 'NVIDIA' } elseif ($controller.Name -match 'Intel') { 'Intel' } elseif ($controller.Name -match 'AMD|Radeon') { 'AMD' } else { '' }
    $used = if ($controllers.Count -eq 1) { $dedicatedUsage } else { 0 }
    $available = if ($total -gt 0 -and $used -ge 0) { [Math]::Max(0, $total - $used) } else { $null }
    $results += [pscustomobject]@{
      name = [string]$controller.Name
      vendor = $vendor
      totalBytes = if ($total -gt 0) { $total } else { $null }
      usedBytes = if ($used -gt 0) { $used } else { $null }
      availableBytes = $available
      dedicated = $vendor -ne 'Intel'
      source = 'windows-cim-performance-counter'
      note = 'Estimativa do Windows. GPUs integradas usam memória compartilhada e podem não expor orçamento preciso.'
    }
  }
}

@($results) | ConvertTo-Json -Depth 4 -Compress
