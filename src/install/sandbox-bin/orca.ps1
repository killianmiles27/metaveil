# PowerShell 5.1 drops double quotes when calling a program, so they're escaped here.
# @() keeps a single argument as a list. Splatting a lone string passes it letter by letter.
$escaped = @(foreach ($a in $args) {
  $t = [string]$a -replace '(\\*)"', '$1$1\"'
  if ($t -match '\s') { $t -replace '(\\+)$', '$1$1' } else { $t }
})
$input | & node "$PSScriptRoot\orca-client.cjs" @escaped
exit $LASTEXITCODE
