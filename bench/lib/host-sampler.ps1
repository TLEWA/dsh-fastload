param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$Stop,
  [string]$Ready = '',
  [int]$IntervalMs = 50
)

$ErrorActionPreference = 'SilentlyContinue'
$samples = New-Object System.Collections.Generic.List[object]
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$readyWritten = $false
while (-not (Test-Path -LiteralPath $Stop)) {
  $p = Get-Process -Id $TargetPid
  if ($p) {
    $samples.Add([pscustomobject]@{
      t = [math]::Round($sw.Elapsed.TotalMilliseconds, 1)
      cpu = [double]$p.CPU
      ws = [long]$p.WorkingSet64
      peak = [long]$p.PeakWorkingSet64
    })
  } else {
    $samples.Add([pscustomobject]@{ t = [math]::Round($sw.Elapsed.TotalMilliseconds, 1); cpu = $null; ws = $null; peak = $null })
  }
  if (-not $readyWritten -and $Ready -ne '') {
    [System.IO.File]::WriteAllText($Ready, '1', [System.Text.UTF8Encoding]::new($false))
    $readyWritten = $true
  }
  Start-Sleep -Milliseconds $IntervalMs
}
$json = $samples | ConvertTo-Json -Compress
if (-not $json) { $json = '[]' }
[System.IO.File]::WriteAllText($Out, $json, [System.Text.UTF8Encoding]::new($false))
