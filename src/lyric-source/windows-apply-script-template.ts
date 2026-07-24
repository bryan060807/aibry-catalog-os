export type WindowsApplyScriptTemplateInput = {
  proposalId: string;
  proposalSha256: string;
  decisionArtifactSha256: string;
  proposalJsonBase64: string;
  operationCount: number;
  evidenceCount: number;
  guardCount: number;
};

export function renderHardenedWindowsApplyScript(input: WindowsApplyScriptTemplateInput): string {
  const replacements: Record<string, string> = {
    "__PROPOSAL_ID__": escapePowerShell(input.proposalId),
    "__PROPOSAL_SHA256__": input.proposalSha256,
    "__DECISION_SHA256__": input.decisionArtifactSha256,
    "__PROPOSAL_BASE64__": input.proposalJsonBase64,
    "__OPERATION_COUNT__": String(input.operationCount),
    "__EVIDENCE_COUNT__": String(input.evidenceCount),
    "__GUARD_COUNT__": String(input.guardCount)
  };
  let script = SCRIPT_TEMPLATE;
  for (const [marker, value] of Object.entries(replacements)) {
    script = script.replaceAll(marker, value);
  }
  return script;
}

const SCRIPT_TEMPLATE = String.raw`[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$VaultRoot,
    [Parameter(Mandatory = $true)][string]$RollbackRoot,
    [Parameter(Mandatory = $true)][string]$ResultReportPath,
    [Parameter(Mandatory = $true)][string]$ProposalArtifactPath,
    [Parameter(Mandatory = $true)][string]$DecisionArtifactPath,
    [Parameter(Mandatory = $true)][string]$DryRunReportPath,
    [Parameter(Mandatory = $true)][string]$HandoffArtifactPath,
    [Parameter(Mandatory = $true)][string]$WorkflowCommand,
    [string[]]$WorkflowArguments = @(),
    [Parameter(Mandatory = $true)][string]$PreWorkflowReportPath,
    [Parameter(Mandatory = $true)][string]$PostWorkflowReportPath,
    [Parameter(Mandatory = $true)][string]$ValidatorCommand,
    [string[]]$ValidatorArguments = @(),
    [Parameter(Mandatory = $true)][string]$ValidatorReportPath,
    [string]$AuthorizationInput,
    [switch]$CompatibilityMode,
    [switch]$CompatibilityFailBeforeFirstWrite,
    [int]$CompatibilityFailAtWriteIndex = 0,
    [switch]$CompatibilityFailAfterWrites,
    [switch]$CompatibilityFailPostRefresh,
    [switch]$CompatibilityFailValidator,
    [switch]$CompatibilityInvalidValidatorReport,
    [switch]$CompatibilityFailAfterValidator,
    [switch]$CompatibilityInjectUnrelatedFile,
    [ValidateSet('None','Operations','OperationsTwice','Evidence','Guards','ResolverProjects')][string]$CompatibilityNestedCollection = 'None',
    [ValidateSet('Success','Missing','Stale','ZeroContract','MultipleContracts','NestedWrapper','WrongContract','MissingFields','Nonzero','NestedResolver')][string]$CompatibilityWorkflowScenario = 'Success'
)

# contract: lyric-source-windows-apply-script.v1
$ExpectedProposalId = '__PROPOSAL_ID__'
$ExpectedProposalSha256 = '__PROPOSAL_SHA256__'
$ExpectedDecisionArtifactSha256 = '__DECISION_SHA256__'
$ExpectedOperationCount = __OPERATION_COUNT__
$ExpectedEvidenceCount = __EVIDENCE_COUNT__
$ExpectedGuardCount = __GUARD_COUNT__
$EmbeddedProposalBase64 = '__PROPOSAL_BASE64__'
$ExpectedWorkflowContract = 'asos-workflow-read-only-refresh.v1.1'
$ExpectedValidatorContract = 'lyric-source-independent-validation-report.v1'
$script:ScriptPath = $MyInvocation.MyCommand.Path
$script:WritesStarted = $false
$script:RollbackPackage = $null
$script:RollbackManifestPath = $null
$script:PreSnapshot = $null
$script:OutputPathsValidated = $false
$script:CompatibilityInjectedPath = $null
$script:ProposalArtifactSha256 = $null
$script:DecisionFileSha256 = $null
$script:DryRunReportSha256 = $null
$script:HandoffArtifactSha256 = $null
$script:ActualScriptSha256 = $null

function Assert-ScalarString {
    param($Value, [string]$Label)
    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value)) { throw "$Label must be one scalar string." }
}

function Add-FlatArrayItem {
    param($Value, [System.Collections.ArrayList]$Output, [int]$Depth, [int]$MaxDepth)
    if ($Depth -gt $MaxDepth) { throw "Array nesting exceeds supported depth $MaxDepth." }
    if ($Value -is [System.Array]) {
        foreach ($item in $Value) { Add-FlatArrayItem $item $Output ($Depth + 1) $MaxDepth }
    } elseif ($null -ne $Value) {
        [void]$Output.Add($Value)
    }
}

function ConvertTo-FlatArray {
    param([Parameter(ValueFromPipeline = $true)]$Value, [int]$MaxDepth = 4)
    begin { $output = New-Object System.Collections.ArrayList }
    process { Add-FlatArrayItem $Value $output 0 $MaxDepth }
    end { return $output.ToArray() }
}

function ConvertTo-RequiredArray {
    param($Value, [string]$Label, [int]$MaxDepth = 4)
    if ($Value -isnot [System.Array]) { throw "$Label must be a JSON array." }
    return @(ConvertTo-FlatArray $Value $MaxDepth)
}

function ConvertTo-SingleContractObject {
    param([Parameter(Mandatory = $true)]$Value, [Parameter(Mandatory = $true)][string]$ExpectedContract)
    $matches = @(ConvertTo-FlatArray $Value 4 | Where-Object { $_ -isnot [System.Array] -and ($_.contract -eq $ExpectedContract -or $_.schemaVersion -eq $ExpectedContract) })
    if ($matches.Count -ne 1) { throw "Expected exactly one $ExpectedContract object; found $($matches.Count)." }
    return $matches[0]
}

function ConvertTo-ContractPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    Assert-ScalarString $Path 'contract path'
    $normalized = $Path.Replace('\', '/')
    while ($normalized.Contains('//')) { $normalized = $normalized.Replace('//', '/') }
    if ($normalized.StartsWith('/') -or $normalized -match '^[A-Za-z]:/' -or $normalized -match '(^|/)\.{1,2}(/|$)' -or $normalized.EndsWith('/')) { throw "Unsafe contract path: $Path" }
    return $normalized
}

function Assert-PathInsideRoot {
    param([string]$Root, [string]$Candidate)
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    $candidateFull = [System.IO.Path]::GetFullPath($Candidate)
    if ($candidateFull -eq $rootFull) { return }
    $prefix = $rootFull + '\'
    if (-not $candidateFull.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Path escapes root: $Candidate" }
}

function Assert-PathOutsideRoot {
    param([string]$Root, [string]$Candidate, [string]$Label)
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    $candidateFull = [System.IO.Path]::GetFullPath($Candidate)
    if ($candidateFull -eq $rootFull -or $candidateFull.StartsWith($rootFull + '\', [System.StringComparison]::OrdinalIgnoreCase)) { throw "$Label must remain outside VaultRoot." }
}

function Assert-NoReparseInAbsolutePath {
    param([string]$LiteralPath, [switch]$AllowMissing)
    $full = [System.IO.Path]::GetFullPath($LiteralPath)
    $root = [System.IO.Path]::GetPathRoot($full)
    $relative = $full.Substring($root.Length)
    $current = $root
    foreach ($segment in @($relative.Split([char[]]@('\','/'), [System.StringSplitOptions]::RemoveEmptyEntries))) {
        $current = Join-Path $current $segment
        if (-not (Test-Path -LiteralPath $current)) {
            if ($AllowMissing) { return }
            throw "Required path does not exist: $current"
        }
        $item = Get-Item -LiteralPath $current -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Linked or reparse path segment is forbidden: $current" }
    }
}

function Assert-SafeExistingRoot {
    param([string]$Root, [string]$Label)
    Assert-ScalarString $Root $Label
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw "$Label must be an existing directory: $Root" }
    Assert-NoReparseInAbsolutePath $Root
}

function Assert-SafeOutputPath {
    param([string]$Vault, [string]$OutputPath, [string]$Label)
    Assert-ScalarString $OutputPath $Label
    Assert-PathOutsideRoot $Vault $OutputPath $Label
    Assert-NoReparseInAbsolutePath $OutputPath -AllowMissing
    $parent = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($OutputPath))
    Assert-PathOutsideRoot $Vault $parent "$Label parent"
    Assert-NoReparseInAbsolutePath $parent -AllowMissing
}

function Assert-SafeGovernanceArtifactPath {
    param([string]$Vault, [string]$ArtifactPath, [string]$Label)
    Assert-SafeOutputPath $Vault $ArtifactPath $Label
    if (-not (Test-Path -LiteralPath $ArtifactPath -PathType Leaf)) { throw "$Label is missing: $ArtifactPath" }
    Assert-NoReparseInAbsolutePath $ArtifactPath
}

function ConvertTo-NativePath {
    param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][string]$ContractPath)
    $validated = ConvertTo-ContractPath $ContractPath
    $current = $Root
    foreach ($segment in @($validated.Split('/'))) { $current = Join-Path $current $segment }
    Assert-PathInsideRoot $Root $current
    return $current
}

function Assert-NoLinkedPathSegment {
    param([string]$Root, [string]$ContractPath, [switch]$AllowMissingLeaf)
    Assert-NoReparseInAbsolutePath $Root
    $current = [System.IO.Path]::GetFullPath($Root)
    $segments = @((ConvertTo-ContractPath $ContractPath).Split('/'))
    for ($index = 0; $index -lt $segments.Count; $index++) {
        $current = Join-Path $current $segments[$index]
        if (-not (Test-Path -LiteralPath $current)) {
            if ($AllowMissingLeaf -and $index -eq ($segments.Count - 1)) { return }
            throw "Required contract path does not exist: $ContractPath"
        }
        $item = Get-Item -LiteralPath $current -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Linked path segment is forbidden: $ContractPath" }
    }
}

function Get-CompatibleSha256 {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    $stream = [System.IO.File]::OpenRead($LiteralPath)
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try { $hash = $sha.ComputeHash($stream) } finally { $sha.Dispose() }
        return ([System.BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
    } finally { $stream.Dispose() }
}

function Get-CompatibleBytesSha256 {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $hash = $sha.ComputeHash($Bytes) } finally { $sha.Dispose() }
    return ([System.BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
}

function ConvertTo-CanonicalJson {
    param($Value)
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [System.Array]) {
        $items = @()
        foreach ($item in $Value) { $items += (ConvertTo-CanonicalJson $item) }
        return '[' + ($items -join ',') + ']'
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $names = @($Value.Keys | ForEach-Object { [string]$_ } | Sort-Object)
        $parts = @()
        foreach ($name in $names) { $parts += ((ConvertTo-Json -InputObject $name -Compress) + ':' + (ConvertTo-CanonicalJson $Value[$name])) }
        return '{' + ($parts -join ',') + '}'
    }
    if ($Value -is [pscustomobject]) {
        $names = @($Value.PSObject.Properties.Name | Sort-Object)
        $parts = @()
        foreach ($name in $names) { $parts += ((ConvertTo-Json -InputObject $name -Compress) + ':' + (ConvertTo-CanonicalJson $Value.PSObject.Properties[$name].Value)) }
        return '{' + ($parts -join ',') + '}'
    }
    return (ConvertTo-Json -InputObject $Value -Compress)
}

function ConvertTo-CanonicalObjectExcludingFields {
    param($Value, [string[]]$ExcludedFields)
    if ($Value -isnot [pscustomobject]) { throw 'Canonical artifact must be one JSON object.' }
    $copy = [ordered]@{}
    foreach ($property in @($Value.PSObject.Properties | Sort-Object Name)) {
        if ($ExcludedFields -notcontains $property.Name) { $copy[$property.Name] = $property.Value }
    }
    return ConvertTo-CanonicalJson $copy
}

function Assert-ProposalCanonicalIntegrity {
    param($Proposal)
    if ($Proposal.contract -ne 'lyric-source-designation-proposal.v1' -or $Proposal.authority -ne 'PROPOSE' -or $Proposal.approvalState -ne 'pending' -or $Proposal.applyEnabled -ne $false -or $Proposal.vaultMutation -ne 'none') { throw 'Embedded proposal authority or safety state is invalid.' }
    $canonical = ConvertTo-CanonicalObjectExcludingFields $Proposal @('proposalSha256','generatedAt','canonicalHashPayload')
    if ($canonical -cne [string]$Proposal.canonicalHashPayload) { throw 'Embedded proposal live fields do not match canonicalHashPayload.' }
    if ((Get-CompatibleBytesSha256 ([System.Text.Encoding]::UTF8.GetBytes($canonical))) -ne [string]$Proposal.proposalSha256) { throw 'Embedded proposal reconstructed SHA-256 mismatch.' }
    return $canonical
}

function Write-JsonNoBom {
    param([string]$LiteralPath, $Value)
    $json = $Value | ConvertTo-Json -Depth 100
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($LiteralPath, $json + [char]10, $encoding)
}

function Read-JsonReportFromDisk {
    param([Parameter(Mandatory = $true)][string]$LiteralPath, [Parameter(Mandatory = $true)][string]$ExpectedContract)
    if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) { throw "Report not found: $LiteralPath" }
    $raw = [System.IO.File]::ReadAllText($LiteralPath, [System.Text.Encoding]::UTF8)
    $parsed = ConvertFrom-Json $raw
    return ConvertTo-SingleContractObject $parsed $ExpectedContract
}

function Assert-ExpectedCount {
    param($Value, [int]$Expected, [string]$Label)
    $flat = @(ConvertTo-FlatArray $Value 4)
    if ($flat.Count -ne $Expected) { throw "$Label count mismatch. Expected $Expected, found $($flat.Count)." }
}

function Assert-WorkflowReportShape {
    param($Report, [switch]$RequireResolver)
    if ($null -eq $Report.counts -or $null -eq $Report.safety) { throw 'Workflow report is missing counts or safety.' }
    foreach ($field in @('catalogFindings','assetFindings','pendingApply')) { if ($null -eq $Report.counts.$field) { throw "Workflow report is missing counts.$field." } }
    if ($Report.safety.applyEnabled -isnot [bool] -or $null -eq $Report.safety.vaultMutation) { throw 'Workflow report safety shape is invalid.' }
    $routes = @(ConvertTo-RequiredArray $Report.findingRoutes 'findingRoutes')
    foreach ($route in $routes) { Assert-ScalarString $route.route 'finding route'; if ($null -eq $route.count) { throw 'Finding route count is missing.' } }
    if ($RequireResolver) {
        $records = @(ConvertTo-RequiredArray $Report.resolverRecords 'resolverRecords')
        foreach ($record in $records) { Assert-ScalarString $record.projectPath 'resolver project path'; Assert-ScalarString $record.state 'resolver state' }
    }
}

function Invoke-ExternalCommand {
    param([string]$Command, [string[]]$Arguments, [string]$Label)
    Assert-ScalarString $Command "$Label command"
    $stdoutPath = [System.IO.Path]::GetTempFileName()
    $stderrPath = [System.IO.Path]::GetTempFileName()
    try {
        & $Command @Arguments 1> $stdoutPath 2> $stderrPath
        $exitCode = $LASTEXITCODE
        if ($null -eq $exitCode) { $exitCode = 0 }
        if ($exitCode -ne 0) { throw "$Label failed with exit code $exitCode." }
    } finally {
        Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-AsosRefreshAndLoadReport {
    param([string]$Phase, [string]$ReportPath, [switch]$RequireResolver, [switch]$ForceFailure)
    if (Test-Path -LiteralPath $ReportPath) {
        Remove-Item -LiteralPath $ReportPath -Force
        if (Test-Path -LiteralPath $ReportPath) { throw "Stale $Phase workflow report could not be removed." }
    }
    $startedAt = [DateTime]::UtcNow
    $arguments = @($WorkflowArguments) + @('--phase', $Phase, '--output', $ReportPath)
    if ($CompatibilityMode) { $arguments += @('--scenario', $CompatibilityWorkflowScenario) }
    if ($ForceFailure) { $arguments += '--fail' }
    Invoke-ExternalCommand $WorkflowCommand $arguments "$Phase ASOS workflow"
    if (-not (Test-Path -LiteralPath $ReportPath -PathType Leaf)) { throw "$Phase ASOS workflow did not create its report." }
    $item = Get-Item -LiteralPath $ReportPath -Force
    if ($item.LastWriteTimeUtc -lt $startedAt.AddSeconds(-1)) { throw "$Phase ASOS workflow report is stale." }
    $report = Read-JsonReportFromDisk $ReportPath $ExpectedWorkflowContract
    Assert-WorkflowReportShape $report -RequireResolver:$RequireResolver
    return $report
}

function Get-RouteCount {
    param($Report, [string]$Route)
    $routes = @(ConvertTo-RequiredArray $Report.findingRoutes 'findingRoutes')
    $matches = @($routes | Where-Object { $_.route -eq $Route })
    if ($matches.Count -ne 1) { throw "Expected exactly one routed finding count for $Route." }
    return [int]$matches[0].count
}

function Assert-WorkflowState {
    param($Report, [int]$CatalogFindings, [int]$AssetFindings, [hashtable]$RoutedFindings, [switch]$PostApply)
    if ([int]$Report.counts.catalogFindings -ne $CatalogFindings) { throw 'catalogFindings count mismatch.' }
    if ([int]$Report.counts.assetFindings -ne $AssetFindings) { throw 'assetFindings count mismatch.' }
    if ([int]$Report.counts.pendingApply -ne 0) { throw 'pendingApply must be zero.' }
    if ($Report.safety.applyEnabled -ne $false) { throw 'ASOS applyEnabled must be false.' }
    if ([string]$Report.safety.vaultMutation -ne 'none') { throw 'ASOS vaultMutation must be none.' }
    foreach ($route in $RoutedFindings.Keys) { if ((Get-RouteCount $Report $route) -ne [int]$RoutedFindings[$route]) { throw "Routed finding count mismatch for $route." } }
    if ($PostApply) {
        $resolverRecords = @(ConvertTo-RequiredArray $Report.resolverRecords 'resolverRecords')
        foreach ($expectedProject in $resolverProjects) {
            $normalizedExpected = ConvertTo-ContractPath $expectedProject
            $matches = @($resolverRecords | Where-Object { (ConvertTo-ContractPath $_.projectPath) -eq $normalizedExpected -and $_.state -eq 'verified' })
            if ($matches.Count -ne 1) { throw "Expected one verified resolver record for $normalizedExpected; found $($matches.Count)." }
        }
    }
}

function Create-RollbackPackage {
    param([string]$Root, [string]$RollbackBase, $Operations)
    $normalizedOperations = @(ConvertTo-RequiredArray $Operations 'rollback operations')
    Assert-ExpectedCount $normalizedOperations $ExpectedOperationCount 'rollback operations'
    $seen = @{}
    foreach ($operation in $normalizedOperations) {
        Assert-ScalarString $operation.path 'rollback operation path'
        $contractPath = ConvertTo-ContractPath $operation.path
        if ($seen.ContainsKey($contractPath)) { throw "Duplicate rollback target: $contractPath" }
        $seen[$contractPath] = $true
        $source = ConvertTo-NativePath $Root $contractPath
        Assert-PathInsideRoot $Root $source
        Assert-NoLinkedPathSegment $Root $contractPath
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Rollback source does not exist: $contractPath" }
        if ((Get-CompatibleSha256 $source) -ne $operation.currentSha256) { throw "Rollback source hash mismatch: $contractPath" }
    }
    $package = Join-Path $RollbackBase ('lyric-source-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff'))
    Assert-PathInsideRoot $RollbackBase $package
    [System.IO.Directory]::CreateDirectory($package) | Out-Null
    Assert-NoReparseInAbsolutePath $package
    $manifestTargets = @()
    foreach ($operation in $normalizedOperations) {
        $contractPath = ConvertTo-ContractPath $operation.path
        $source = ConvertTo-NativePath $Root $contractPath
        $destination = ConvertTo-NativePath $package $contractPath
        Assert-PathInsideRoot $package $destination
        $destinationParent = [System.IO.Path]::GetDirectoryName($destination)
        Assert-NoReparseInAbsolutePath $destinationParent -AllowMissing
        [System.IO.Directory]::CreateDirectory($destinationParent) | Out-Null
        Assert-NoReparseInAbsolutePath $destinationParent
        Assert-NoLinkedPathSegment $package $contractPath -AllowMissingLeaf
        [System.IO.File]::Copy($source, $destination, $false)
        $sourceLength = (Get-Item -LiteralPath $source).Length
        $destinationLength = (Get-Item -LiteralPath $destination).Length
        $destinationHash = Get-CompatibleSha256 $destination
        if ($destinationLength -ne $sourceLength -or $destinationHash -ne $operation.currentSha256) { throw "Rollback copy verification failed: $contractPath" }
        $manifestTargets += [pscustomobject]@{ path = $contractPath; byteSize = $destinationLength; originalSha256 = $destinationHash }
    }
    Assert-ExpectedCount $manifestTargets $ExpectedOperationCount 'rollback manifest targets'
    $manifestPath = Join-Path $package 'rollback-manifest.json'
    $manifestDocument = [pscustomobject]@{ contract = 'lyric-source-rollback-manifest.v1'; targetCount = $ExpectedOperationCount; targets = @($manifestTargets) }
    Write-JsonNoBom $manifestPath $manifestDocument
    $reloaded = Read-JsonReportFromDisk $manifestPath 'lyric-source-rollback-manifest.v1'
    $reloadedTargets = @(ConvertTo-RequiredArray $reloaded.targets 'rollback targets')
    Assert-ExpectedCount $reloadedTargets $ExpectedOperationCount 'reloaded rollback targets'
    foreach ($target in $reloadedTargets) {
        $matching = @($normalizedOperations | Where-Object { $_.path -eq $target.path -and $_.currentSha256 -eq $target.originalSha256 })
        if ($matching.Count -ne 1) { throw "Rollback manifest target is not bound to one operation: $($target.path)" }
    }
    return [pscustomobject]@{ packagePath = $package; manifestPath = $manifestPath }
}

function Restore-RollbackPackage {
    param([string]$Root, [string]$Package, $Operations)
    $normalizedOperations = @(ConvertTo-RequiredArray $Operations 'restore operations')
    Assert-ExpectedCount $normalizedOperations $ExpectedOperationCount 'restore operations'
    foreach ($operation in $normalizedOperations) {
        $source = ConvertTo-NativePath $Package $operation.path
        $destination = ConvertTo-NativePath $Root $operation.path
        Assert-NoLinkedPathSegment $Package $operation.path
        Assert-NoLinkedPathSegment $Root $operation.path
        [System.IO.File]::Copy($source, $destination, $true)
        if ((Get-CompatibleSha256 $destination) -ne $operation.currentSha256) { throw "Rollback restoration hash mismatch: $($operation.path)" }
    }
}

function Get-VaultSnapshot {
    param([string]$Root)
    $snapshot = @{}
    foreach ($item in @(Get-ChildItem -LiteralPath $Root -Recurse -Force)) {
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Linked segment in vault snapshot: $($item.FullName)" }
        if ($item.PSIsContainer) { continue }
        $relative = $item.FullName.Substring(([System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\').Length).Replace('\', '/')
        $snapshot[$relative] = Get-CompatibleSha256 $item.FullName
    }
    return $snapshot
}

function Compare-VaultSnapshots {
    param($Before, $After, $Operations)
    $allowed = @{}
    foreach ($operation in @(ConvertTo-RequiredArray $Operations 'snapshot operations')) { $allowed[(ConvertTo-ContractPath $operation.path)] = $true }
    $keys = @($Before.Keys + $After.Keys | Sort-Object -Unique)
    foreach ($key in $keys) { if (-not $allowed.ContainsKey($key) -and $Before[$key] -ne $After[$key]) { throw "Unrelated file changed: $key" } }
    return $true
}

function Invoke-IndependentValidatorAndLoadReport {
    if (Test-Path -LiteralPath $ValidatorReportPath) {
        Remove-Item -LiteralPath $ValidatorReportPath -Force
        if (Test-Path -LiteralPath $ValidatorReportPath) { throw 'Stale validator report could not be removed.' }
    }
    $startedAt = [DateTime]::UtcNow
    $arguments = @($ValidatorArguments) + @('--output', $ValidatorReportPath, '--proposal-id', $ExpectedProposalId, '--proposal-sha256', $ExpectedProposalSha256)
    if ($CompatibilityFailValidator) { $arguments += '--fail' }
    if ($CompatibilityInvalidValidatorReport) { $arguments += '--invalid' }
    Invoke-ExternalCommand $ValidatorCommand $arguments 'Independent Validator'
    if (-not (Test-Path -LiteralPath $ValidatorReportPath -PathType Leaf)) { throw 'Independent Validator did not create its persisted report.' }
    $item = Get-Item -LiteralPath $ValidatorReportPath -Force
    if ($item.LastWriteTimeUtc -lt $startedAt.AddSeconds(-1)) { throw 'Independent Validator report is stale.' }
    $report = Read-JsonReportFromDisk $ValidatorReportPath $ExpectedValidatorContract
    if ($report.proposalId -ne $ExpectedProposalId -or $report.proposalSha256 -ne $ExpectedProposalSha256) { throw 'Validator proposal identity mismatch.' }
    if ($report.authority -ne 'OBSERVE' -or $report.persistedArtifactsOnly -ne $true -or $report.status -ne 'passed') { throw 'Validator authority or status is invalid.' }
    $checks = @(ConvertTo-RequiredArray $report.checks 'validator checks')
    if ($null -eq $report.counts -or [int]$report.counts.failed -ne 0) { throw 'Validator failed count must be zero.' }
    if ($null -eq $report.safety -or $report.safety.applyEnabled -ne $false -or $report.safety.vaultMutation -ne 'none' -or [int]$report.safety.pendingApply -ne 0) { throw 'Validator safety state is invalid.' }
    return $report
}

function Write-FailureResult {
    param([string]$Message, [bool]$RollbackRestored)
    if (-not $script:OutputPathsValidated) { return }
    $contract = if ($CompatibilityMode) { 'lyric-source-apply-simulation-result.v1' } else { 'lyric-source-apply-result.v1' }
    $status = if ($CompatibilityMode) { 'simulated-failed' } else { 'failed-rolled-back' }
    $failure = [pscustomobject]@{ contract = $contract; proposalId = $ExpectedProposalId; proposalSha256 = $ExpectedProposalSha256; status = $status; rollbackPackage = $script:RollbackPackage; rollbackRestored = $RollbackRestored; error = $Message; operationCount = $ExpectedOperationCount }
    Write-JsonNoBom $ResultReportPath $failure
}

function Assert-GovernanceChain {
    param($EmbeddedProposal, [string]$EmbeddedCanonicalPayload)
    $script:ActualScriptSha256 = Get-CompatibleSha256 $script:ScriptPath
    $persistedProposal = Read-JsonReportFromDisk $ProposalArtifactPath 'lyric-source-designation-proposal.v1'
    $persistedCanonicalPayload = Assert-ProposalCanonicalIntegrity $persistedProposal
    if ($persistedProposal.proposalId -ne $ExpectedProposalId -or $persistedProposal.proposalSha256 -ne $ExpectedProposalSha256 -or $persistedCanonicalPayload -cne $EmbeddedCanonicalPayload) { throw 'Persisted and embedded proposal identities do not match.' }
    $script:ProposalArtifactSha256 = Get-CompatibleSha256 $ProposalArtifactPath

    $decision = Read-JsonReportFromDisk $DecisionArtifactPath 'asos-authority-decision.v1'
    $decisionCanonical = ConvertTo-CanonicalObjectExcludingFields $decision @('decisionArtifactSha256')
    $decisionCanonicalSha256 = Get-CompatibleBytesSha256 ([System.Text.Encoding]::UTF8.GetBytes($decisionCanonical))
    if ($decisionCanonicalSha256 -ne $decision.decisionArtifactSha256 -or $decision.decisionArtifactSha256 -ne $ExpectedDecisionArtifactSha256) { throw 'Decision artifact SHA-256 is invalid.' }
    if ($decision.decisionState -ne 'approved' -or $decision.proposalId -ne $ExpectedProposalId -or $decision.proposalSha256 -ne $ExpectedProposalSha256) { throw 'Decision artifact does not approve the exact proposal.' }
    $script:DecisionFileSha256 = Get-CompatibleSha256 $DecisionArtifactPath

    $dryRun = Read-JsonReportFromDisk $DryRunReportPath 'lyric-source-apply-dry-run-report.v1'
    $script:DryRunReportSha256 = Get-CompatibleSha256 $DryRunReportPath
    if ($dryRun.status -ne 'passed' -or $dryRun.liveVaultAccess -ne $false -or $dryRun.mutationTarget -ne 'temporary-mirror-only') { throw 'Dry-run report safety state is invalid.' }
    if ($dryRun.proposalIdentity.proposalId -ne $ExpectedProposalId -or $dryRun.proposalIdentity.proposalSha256 -ne $ExpectedProposalSha256 -or $dryRun.proposalIdentity.artifactSha256 -ne $script:ProposalArtifactSha256) { throw 'Dry-run report proposal identity mismatch.' }
    if ($dryRun.scriptIdentity.contract -ne 'lyric-source-windows-apply-script.v1' -or $dryRun.scriptIdentity.scriptSha256 -ne $script:ActualScriptSha256) { throw 'Dry-run report script identity mismatch.' }
    if ([string]$dryRun.powerShellVersion -notmatch '^5\.1\.') { throw 'Dry-run report did not use Windows PowerShell 5.1.' }
    $dryRunFailures = @(ConvertTo-RequiredArray $dryRun.failures 'dry-run failures')
    if ($dryRunFailures.Count -ne 0) { throw 'Dry-run report contains failures.' }
    $dryRunScenarios = @(ConvertTo-RequiredArray $dryRun.scenarios 'dry-run scenarios')
    if ($dryRunScenarios.Count -eq 0) { throw 'Dry-run report contains no scenarios.' }
    foreach ($scenario in $dryRunScenarios) {
        if ($scenario.observed -ne $scenario.expected -or ($scenario.observed -eq 'failed' -and $scenario.restoredAllTargets -ne $true)) { throw "Dry-run scenario failed governance: $($scenario.name)" }
    }

    $handoff = Read-JsonReportFromDisk $HandoffArtifactPath 'lyric-source-apply-handoff.v1'
    $script:HandoffArtifactSha256 = Get-CompatibleSha256 $HandoffArtifactPath
    if ($handoff.proposalId -ne $ExpectedProposalId -or $handoff.proposalSha256 -ne $ExpectedProposalSha256 -or $handoff.proposalArtifactSha256 -ne $script:ProposalArtifactSha256) { throw 'Handoff proposal identity mismatch.' }
    if ($handoff.decisionArtifactSha256 -ne $ExpectedDecisionArtifactSha256 -or $handoff.dryRunReportSha256 -ne $script:DryRunReportSha256 -or $handoff.scriptSha256 -ne $script:ActualScriptSha256) { throw 'Handoff artifact lineage mismatch.' }
    if ($handoff.state -ne 'eligible-for-guarded-apply' -or $handoff.applyExecuted -ne $false) { throw 'Handoff is not eligible or is already executed.' }
    $handoffOperations = @(ConvertTo-RequiredArray $handoff.operations 'handoff operations')
    $handoffRollback = @(ConvertTo-RequiredArray $handoff.rollbackRequirements 'handoff rollback requirements')
    $handoffValidator = @(ConvertTo-RequiredArray $handoff.independentValidatorCriteria 'handoff validator criteria')
    Assert-ExpectedCount $handoffOperations $ExpectedOperationCount 'handoff operations'
    if ($handoffRollback.Count -eq 0 -or $handoffValidator.Count -eq 0) { throw 'Handoff rollback or validator criteria are incomplete.' }
    if ((ConvertTo-CanonicalJson $handoffOperations) -cne (ConvertTo-CanonicalJson $EmbeddedProposal.operations) -or (ConvertTo-CanonicalJson $handoffRollback) -cne (ConvertTo-CanonicalJson $EmbeddedProposal.rollbackRequirements) -or (ConvertTo-CanonicalJson $handoffValidator) -cne (ConvertTo-CanonicalJson $EmbeddedProposal.independentValidatorCriteria)) { throw 'Handoff operation or criteria envelope mismatch.' }
}

$compatibilityFaultUsed = $CompatibilityFailBeforeFirstWrite -or $CompatibilityFailAtWriteIndex -gt 0 -or $CompatibilityFailAfterWrites -or $CompatibilityFailPostRefresh -or $CompatibilityFailValidator -or $CompatibilityInvalidValidatorReport -or $CompatibilityFailAfterValidator -or $CompatibilityInjectUnrelatedFile -or $CompatibilityNestedCollection -ne 'None' -or $CompatibilityWorkflowScenario -ne 'Success'
if (-not $CompatibilityMode -and ($PSBoundParameters.ContainsKey('AuthorizationInput') -or $compatibilityFaultUsed)) { throw 'Compatibility authorization and fault parameters are forbidden outside CompatibilityMode.' }

try {
    Assert-SafeExistingRoot $VaultRoot 'VaultRoot'
    $vaultFull = [System.IO.Path]::GetFullPath($VaultRoot).TrimEnd('\')
    if ($CompatibilityMode) {
        if ($vaultFull -ieq 'C:\AIBRY\music-vault') { throw 'Live Music Vault access is forbidden in compatibility mode.' }
        $fixtureMarker = Join-Path $VaultRoot '.asos-fixture-vault'
        if (-not (Test-Path -LiteralPath $fixtureMarker -PathType Leaf)) { throw 'CompatibilityMode requires a marked temporary fixture mirror.' }
        Assert-NoReparseInAbsolutePath $fixtureMarker
    }
    Assert-ScalarString $RollbackRoot 'RollbackRoot'
    Assert-PathOutsideRoot $VaultRoot $RollbackRoot 'RollbackRoot'
    Assert-NoReparseInAbsolutePath $RollbackRoot -AllowMissing
    if ([System.IO.Path]::GetFullPath($RollbackRoot).TrimEnd('\') -eq $vaultFull) { throw 'RollbackRoot and VaultRoot must be distinct.' }
    foreach ($output in @(@($ResultReportPath,'ResultReportPath'), @($PreWorkflowReportPath,'PreWorkflowReportPath'), @($PostWorkflowReportPath,'PostWorkflowReportPath'), @($ValidatorReportPath,'ValidatorReportPath'))) { Assert-SafeOutputPath $VaultRoot $output[0] $output[1] }
    foreach ($artifact in @(@($ProposalArtifactPath,'ProposalArtifactPath'), @($DecisionArtifactPath,'DecisionArtifactPath'), @($DryRunReportPath,'DryRunReportPath'), @($HandoffArtifactPath,'HandoffArtifactPath'))) { Assert-SafeGovernanceArtifactPath $VaultRoot $artifact[0] $artifact[1] }
    foreach ($directory in @($RollbackRoot, [System.IO.Path]::GetDirectoryName($ResultReportPath), [System.IO.Path]::GetDirectoryName($PreWorkflowReportPath), [System.IO.Path]::GetDirectoryName($PostWorkflowReportPath), [System.IO.Path]::GetDirectoryName($ValidatorReportPath))) {
        [System.IO.Directory]::CreateDirectory($directory) | Out-Null
        Assert-NoReparseInAbsolutePath $directory
        Assert-PathOutsideRoot $VaultRoot $directory 'output directory'
    }
    if (Test-Path -LiteralPath $ResultReportPath) { throw 'Result report already exists; refusing to overwrite it.' }
    $script:OutputPathsValidated = $true

    $proposalBytes = [System.Convert]::FromBase64String($EmbeddedProposalBase64)
    $proposalText = (New-Object System.Text.UTF8Encoding($false, $true)).GetString($proposalBytes)
    $proposal = ConvertTo-SingleContractObject (ConvertFrom-Json $proposalText) 'lyric-source-designation-proposal.v1'
    if ($proposal.proposalId -ne $ExpectedProposalId -or $proposal.proposalSha256 -ne $ExpectedProposalSha256) { throw 'Approved proposal identity mismatch.' }
    $embeddedCanonicalPayload = Assert-ProposalCanonicalIntegrity $proposal
    Assert-GovernanceChain $proposal $embeddedCanonicalPayload

    $rawOperations = $proposal.operations
    $rawEvidence = $proposal.evidence
    $rawGuards = $proposal.guardFiles
    $rawResolverProjects = $proposal.resolverExpectedProjects
    if ($CompatibilityNestedCollection -eq 'Operations') { $rawOperations = ,@($rawOperations) }
    if ($CompatibilityNestedCollection -eq 'OperationsTwice') { $rawOperations = ,@(,@($rawOperations)) }
    if ($CompatibilityNestedCollection -eq 'Evidence') { $rawEvidence = ,@($rawEvidence) }
    if ($CompatibilityNestedCollection -eq 'Guards') { $rawGuards = ,@($rawGuards) }
    if ($CompatibilityNestedCollection -eq 'ResolverProjects') { $rawResolverProjects = ,@($rawResolverProjects) }
    $operations = @(ConvertTo-RequiredArray $rawOperations 'operations')
    $evidence = @(ConvertTo-RequiredArray $rawEvidence 'evidence')
    $guards = @(ConvertTo-RequiredArray $rawGuards 'guards')
    $resolverProjects = @(ConvertTo-RequiredArray $rawResolverProjects 'resolverExpectedProjects')
    Assert-ExpectedCount $operations $ExpectedOperationCount 'operations'
    Assert-ExpectedCount $evidence $ExpectedEvidenceCount 'evidence'
    Assert-ExpectedCount $guards $ExpectedGuardCount 'guards'

    foreach ($operation in $operations) {
        Assert-ScalarString $operation.path 'operation path'
        $operation.path = ConvertTo-ContractPath $operation.path
        Assert-NoLinkedPathSegment $VaultRoot $operation.path
        $target = ConvertTo-NativePath $VaultRoot $operation.path
        if ((Get-CompatibleSha256 $target) -ne $operation.currentSha256 -or (Get-Item -LiteralPath $target).Length -ne [int64]$operation.currentByteCount) { throw "Current operation state mismatch: $($operation.path)" }
        $bytes = [System.Convert]::FromBase64String([string]$operation.contentBase64)
        $decodedText = (New-Object System.Text.UTF8Encoding($false, $true)).GetString($bytes)
        if ($bytes.Length -ne [int]$operation.proposedByteCount -or (Get-CompatibleBytesSha256 $bytes) -ne $operation.proposedSha256 -or ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) -or $decodedText.Contains([char]13)) { throw "Embedded proposed bytes are invalid: $($operation.path)" }
    }
    foreach ($row in $evidence) {
        foreach ($role in @('sourcePath','managedPath')) { Assert-ScalarString $row.$role "evidence $role"; $row.$role = ConvertTo-ContractPath $row.$role; Assert-NoLinkedPathSegment $VaultRoot $row.$role }
        $source = ConvertTo-NativePath $VaultRoot $row.sourcePath
        $managed = ConvertTo-NativePath $VaultRoot $row.managedPath
        if ((Get-CompatibleSha256 $source) -ne $row.sha256 -or (Get-CompatibleSha256 $managed) -ne $row.sha256 -or (Get-Item $source).Length -ne [int64]$row.byteSize -or (Get-Item $managed).Length -ne [int64]$row.byteSize) { throw "Lyric evidence changed: $($row.projectPath)" }
    }
    foreach ($guard in $guards) { Assert-ScalarString $guard.path 'guard path'; $guard.path = ConvertTo-ContractPath $guard.path; Assert-NoLinkedPathSegment $VaultRoot $guard.path; $guardFile = ConvertTo-NativePath $VaultRoot $guard.path; if ((Get-CompatibleSha256 $guardFile) -ne $guard.sha256 -or (Get-Item $guardFile).Length -ne [int64]$guard.byteSize) { throw "Guard changed: $($guard.path)" } }

    $baselineRoutes = @{}
    foreach ($property in $proposal.expectedCounts.routedFindings.PSObject.Properties) { $baselineRoutes[$property.Name] = [int]$property.Value - [int]$proposal.expectedFindingDeltas.routedFindings.($property.Name) }
    $expectedRoutes = @{}
    foreach ($property in $proposal.expectedCounts.routedFindings.PSObject.Properties) { $expectedRoutes[$property.Name] = [int]$property.Value }
    $preReport = Invoke-AsosRefreshAndLoadReport 'pre' $PreWorkflowReportPath
    Assert-WorkflowState $preReport ([int]$proposal.expectedCounts.catalogFindings - [int]$proposal.expectedFindingDeltas.catalogFindings) ([int]$proposal.expectedCounts.assetFindings - [int]$proposal.expectedFindingDeltas.assetFindings) $baselineRoutes

    $script:PreSnapshot = Get-VaultSnapshot $VaultRoot
    $rollback = Create-RollbackPackage $VaultRoot $RollbackRoot $operations
    $script:RollbackPackage = $rollback.packagePath
    $script:RollbackManifestPath = $rollback.manifestPath
    if ($CompatibilityFailBeforeFirstWrite) { throw 'Compatibility failure before first write.' }
    $authorization = if ($CompatibilityMode) { $AuthorizationInput } else { Read-Host 'Type APPLY exactly to continue' }
    if ($authorization -cne 'APPLY') { throw 'Operator did not type APPLY exactly.' }

    $script:WritesStarted = $true
    for ($index = 0; $index -lt $operations.Count; $index++) {
        $operation = $operations[$index]
        $target = ConvertTo-NativePath $VaultRoot $operation.path
        $bytes = [System.Convert]::FromBase64String([string]$operation.contentBase64)
        [System.IO.File]::WriteAllBytes($target, $bytes)
        if ((Get-CompatibleSha256 $target) -ne $operation.proposedSha256) { throw "Post-write hash mismatch: $($operation.path)" }
        if ($CompatibilityFailAtWriteIndex -eq ($index + 1)) { throw "Compatibility failure during write $($index + 1)." }
    }
    if ($CompatibilityFailAfterWrites) { throw 'Compatibility failure after all writes.' }
    foreach ($row in $evidence) { if ((Get-CompatibleSha256 (ConvertTo-NativePath $VaultRoot $row.sourcePath)) -ne $row.sha256 -or (Get-CompatibleSha256 (ConvertTo-NativePath $VaultRoot $row.managedPath)) -ne $row.sha256) { throw "Lyric evidence changed after APPLY: $($row.projectPath)" } }
    foreach ($guard in $guards) { if ((Get-CompatibleSha256 (ConvertTo-NativePath $VaultRoot $guard.path)) -ne $guard.sha256) { throw "Guard changed after APPLY: $($guard.path)" } }

    $postReport = Invoke-AsosRefreshAndLoadReport 'post' $PostWorkflowReportPath -RequireResolver -ForceFailure:$CompatibilityFailPostRefresh
    Assert-WorkflowState $postReport ([int]$proposal.expectedCounts.catalogFindings) ([int]$proposal.expectedCounts.assetFindings) $expectedRoutes -PostApply
    $validatorReport = Invoke-IndependentValidatorAndLoadReport
    if ($CompatibilityFailAfterValidator) { throw 'Compatibility failure after validator and before snapshot comparison.' }
    if ($CompatibilityInjectUnrelatedFile) { $script:CompatibilityInjectedPath = Join-Path $VaultRoot 'compatibility-unrelated-file.txt'; [System.IO.File]::WriteAllText($script:CompatibilityInjectedPath, 'intentional unrelated mutation') }
    $postSnapshot = Get-VaultSnapshot $VaultRoot
    $unrelatedComparison = Compare-VaultSnapshots $script:PreSnapshot $postSnapshot $operations

    $resultContract = if ($CompatibilityMode) { 'lyric-source-apply-simulation-result.v1' } else { 'lyric-source-apply-result.v1' }
    $resultStatus = if ($CompatibilityMode) { 'simulated-passed' } else { 'applied-and-validated' }
    $result = [pscustomobject]@{
        contract = $resultContract; proposalId = $ExpectedProposalId; proposalArtifactSha256 = $script:ProposalArtifactSha256; proposalCanonicalSha256 = $ExpectedProposalSha256
        decisionArtifactSha256 = $script:DecisionFileSha256; handoffArtifactSha256 = $script:HandoffArtifactSha256; dryRunReportSha256 = $script:DryRunReportSha256; actualScriptSha256 = $script:ActualScriptSha256
        rollbackPackage = $script:RollbackPackage; operationCount = $ExpectedOperationCount; changedPaths = @($operations | ForEach-Object { $_.path })
        preWorkflowReportSha256 = (Get-CompatibleSha256 $PreWorkflowReportPath); postWorkflowReportSha256 = (Get-CompatibleSha256 $PostWorkflowReportPath); validatorReportSha256 = (Get-CompatibleSha256 $ValidatorReportPath)
        expectedCounts = $proposal.expectedCounts; actualCounts = $postReport.counts; unrelatedFileComparisonPassed = $unrelatedComparison; status = $resultStatus
    }
    Write-JsonNoBom $ResultReportPath $result
} catch {
    $rollbackRestored = $false
    if ($script:WritesStarted -and $script:RollbackPackage) {
        try { Restore-RollbackPackage $VaultRoot $script:RollbackPackage $operations; $rollbackRestored = $true } catch { $rollbackRestored = $false }
    }
    if ($script:CompatibilityInjectedPath -and (Test-Path -LiteralPath $script:CompatibilityInjectedPath)) { Remove-Item -LiteralPath $script:CompatibilityInjectedPath -Force }
    Write-FailureResult $_.Exception.Message $rollbackRestored
    throw
}
`;

function escapePowerShell(value: string): string {
  return value.replace(/'/g, "''");
}
