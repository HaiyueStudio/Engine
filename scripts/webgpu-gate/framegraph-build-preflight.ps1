function Assert-G09DiagnosticBuild {
 $node=Join-Path $env:ProgramFiles 'nodejs/node.exe'
 $checker=Join-Path $PSScriptRoot 'check-framegraph-build.mjs'
 if(-not(Test-Path -LiteralPath $node -PathType Leaf)){throw ('G09_BUILD_NOT_READY: missing '+$node)}
 $json=& $node $checker
 $code=$LASTEXITCODE
 try{$result=($json -join "`n")|ConvertFrom-Json}catch{throw 'G09_BUILD_NOT_READY: invalid build preflight response; sampling and power changes did not start'}
 if($code -ne 0 -or $result.ready -ne $true){throw ('G09_BUILD_NOT_READY: '+$result.error)}
 return $result
}
