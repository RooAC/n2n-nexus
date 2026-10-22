param(
    [int]$ParentId,
    [int]$ProcessId,
    [string]$Entry,
    [int]$Port
)

$daemonPattern = '(?:^|\s)"?' + [regex]::Escape($Entry) + '"?\s+daemon\s+--port\s+' + $Port + '(?:\s|$)'
$processFilter = if ($ProcessId) { "ProcessId = $ProcessId" } else { "ParentProcessId = $ParentId" }
Get-CimInstance Win32_Process -Filter $processFilter |
    Where-Object { $_.CommandLine -match $daemonPattern } |
    ForEach-Object { $_.ProcessId }
