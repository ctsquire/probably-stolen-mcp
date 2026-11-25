param(
    [Parameter(Mandatory)]
    [string] $GameDirectory,
    [string] $OutputPath = (Join-Path $PSScriptRoot 'ProbablyStolenMcpBridge.dll')
)

$ErrorActionPreference = 'Stop'
$managed = Join-Path (Resolve-Path -LiteralPath $GameDirectory).Path 'Probably Stolen_Data\Managed'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler -PathType Leaf)) {
    throw 'The 64-bit .NET Framework C# compiler is required.'
}

$references = @(
    'Assembly-CSharp.dll',
    'Assembly-CSharp-firstpass.dll',
    'UnityEngine.CoreModule.dll',
    'UnityEngine.UI.dll',
    'UnityEngine.UIModule.dll',
    'UnityEngine.TextRenderingModule.dll',
    'Unity.TextMeshPro.dll',
    'UnityEngine.dll',
    'UnityEngine.JSONSerializeModule.dll',
    'netstandard.dll'
) | ForEach-Object {
    $assembly = Join-Path $managed $_
    if (!(Test-Path -LiteralPath $assembly -PathType Leaf)) {
        throw "Missing managed game assembly: $assembly"
    }
    '/reference:' + $assembly
}

$sources = Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.cs' -File | Sort-Object Name | Select-Object -ExpandProperty FullName
& $compiler /nologo /target:library /nowarn:0649 ('/out:' + $OutputPath) $references $sources
if ($LASTEXITCODE -ne 0) { throw "Bridge compilation failed with exit code $LASTEXITCODE." }
