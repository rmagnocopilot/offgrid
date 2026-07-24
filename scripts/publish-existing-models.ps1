param(
  [string]$ModelDir = "models-local",
  [string]$Tag = "models-v1",
  [int64]$ChunkBytes = 1900MB
)

$ErrorActionPreference = "Stop"
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw "Instale o GitHub CLI (gh)." }

try { gh release view $Tag | Out-Null } catch { gh release create $Tag --title "Modelos GGUF para Offgrid" }

$files = @(
  "qwen2.5-coder-3b-instruct-q4_k_m.gguf",
  "qwen2.5-coder-7b-instruct-q4_k_m.gguf"
)

foreach ($file in $files) {
  $source = Join-Path $ModelDir $file
  if (-not (Test-Path $source)) { Write-Warning "Ignorando: $source não encontrado"; continue }
  $temp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Path $temp | Out-Null
  try {
    $input = [System.IO.File]::OpenRead($source)
    try {
      $index = 0
      $buffer = New-Object byte[] (4MB)
      while ($input.Position -lt $input.Length) {
        $part = Join-Path $temp ("{0}.part-{1:D2}" -f $file, $index)
        $output = [System.IO.File]::Create($part)
        try {
          $written = 0L
          while ($written -lt $ChunkBytes -and $input.Position -lt $input.Length) {
            $remaining = [Math]::Min($buffer.Length, $ChunkBytes - $written)
            $read = $input.Read($buffer, 0, [int]$remaining)
            if ($read -le 0) { break }
            $output.Write($buffer, 0, $read)
            $written += $read
          }
        } finally { $output.Dispose() }
        $index++
      }
    } finally { $input.Dispose() }
    Get-ChildItem $temp -File | ForEach-Object { gh release upload $Tag $_.FullName --clobber }
  } finally { Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue }
}
