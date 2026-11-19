[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Close', 'Open')]
    [string] $Action,

    [switch] $RequireAdministrator,

    [ValidateRange(1, 120)]
    [int] $TimeoutSeconds = 5
)

$ErrorActionPreference = 'Stop'

if ($Action -eq 'Open') {
    $appId = 'OpenAI.Codex_2p2nqsd0c76g0!App'
    if ($PSCmdlet.ShouldProcess('ChatGPT', 'Open')) {
        Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList "shell:AppsFolder\$appId"
    }
    return
}

if ($RequireAdministrator) {
    $user = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (!$user.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run the launcher as administrator from File Explorer.'
    }
}

# A terminal owned by ChatGPT can disappear as soon as the client exits.
$child = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $PID"
if (!$child) { throw 'Unable to verify the test terminal process.' }
$sessionId = $child.SessionId
while ($child.ParentProcessId -gt 0) {
    $parent = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($child.ParentProcessId)"
    if (!$parent -or $parent.CreationDate -gt $child.CreationDate -or $parent.ProcessId -eq $child.ProcessId) { break }
    if ($parent.Name -match '^(ChatGPT|Codex|codex-command-runner)\.exe$') {
        throw 'Open the independent launcher from File Explorer before closing ChatGPT.'
    }
    $child = $parent
}

$appsRoot = Join-Path $env:ProgramFiles 'WindowsApps'
$chatGptPath = '^' + [regex]::Escape($appsRoot) + '\\OpenAI\.Codex_[^\\]+__2p2nqsd0c76g0\\app\\ChatGPT\.exe$'
$codexRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
$codexPath = '^' + [regex]::Escape($codexRoot) + '\\[^\\]+\\codex\.exe$'
$knownHelpers = @{}

function Get-ChatGptProcesses {
    $processes = @(Get-CimInstance -ClassName Win32_Process -Filter "SessionId = $sessionId AND (Name = 'ChatGPT.exe' OR Name = 'codex.exe')")
    $clients = @($processes | Where-Object { $_.CreationDate -and $_.ExecutablePath -match $chatGptPath })
    $clientsById = @{}
    foreach ($client in $clients) { $clientsById[[int] $client.ProcessId] = $client }

    $clients
    foreach ($helper in $processes | Where-Object { $_.CreationDate -and $_.ExecutablePath -match $codexPath }) {
        $processId = [int] $helper.ProcessId
        $owner = $clientsById[[int] $helper.ParentProcessId]
        if ($owner -and $owner.CreationDate -le $helper.CreationDate) {
            $knownHelpers[$processId] = $helper.CreationDate
        }
        if ($knownHelpers[$processId] -eq $helper.CreationDate) { $helper }
    }
}

function Close-ClientProcess($Candidate, [switch] $Force) {
    $process = Get-Process -Id $Candidate.ProcessId -ErrorAction SilentlyContinue
    if (!$process) { return }
    try {
        # Pin the process handle before checking its identity again.
        $null = $process.Handle
        $current = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($Candidate.ProcessId)"
        if (!$current -or $process.HasExited -or $current.SessionId -ne $sessionId -or
            $current.ExecutablePath -ne $Candidate.ExecutablePath -or $current.CreationDate -ne $Candidate.CreationDate) { return }
        if ($Force) {
            Stop-Process -InputObject $process -Force
            Write-Host "Stopped $($current.Name) (PID $($current.ProcessId))."
        } elseif ($process.MainWindowHandle -ne [IntPtr]::Zero) {
            [void] $process.CloseMainWindow()
        }
    } catch {
        if (!$process.HasExited) { throw }
    } finally {
        $process.Dispose()
    }
}

$remaining = @(Get-ChatGptProcesses)
if ($remaining.Count -eq 0) { return }
if (!$PSCmdlet.ShouldProcess('ChatGPT in the current desktop session', 'Close')) { return }

foreach ($client in $remaining | Where-Object { $_.Name -ieq 'ChatGPT.exe' }) {
    Close-ClientProcess $client
}

$wait = [Diagnostics.Stopwatch]::StartNew()
while ($wait.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
    $remaining = @(Get-ChatGptProcesses)
    if ($remaining.Count -eq 0) { return }
    Start-Sleep -Milliseconds 250
}

$wait.Restart()
do {
    $remaining = @(Get-ChatGptProcesses)
    if ($remaining.Count -eq 0) { return }
    foreach ($client in $remaining) { Close-ClientProcess $client -Force }
    Start-Sleep -Milliseconds 250
} while ($wait.Elapsed.TotalSeconds -lt 15)

$remaining = @(Get-ChatGptProcesses)
if ($remaining.Count -gt 0) { throw "ChatGPT processes are still running (PIDs: $($remaining.ProcessId -join ', '))." }
