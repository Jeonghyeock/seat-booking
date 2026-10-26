# 1초마다 전체 CPU와 node·postgres·k6 프로세스의 CPU를 JSON 한 줄로 쓴다(DESIGN 6.6 "지표와 표본").
# 프로세스 값은 한 코어를 100으로 본 %다. node는 여러 개일 수 있어 PID와 함께 쓴다(실행기가 API의 PID로 고른다).
# 영문 카운터 경로가 이 PC에서 동작한다. Get-Process는 서비스 계정으로 도는 postgres의 CPU를 읽지 못한다.
param([Parameter(Mandatory = $true)][string]$Out)

$paths = @(
  '\Processor(_Total)\% Processor Time',
  '\Process(node*)\% Processor Time',
  '\Process(node*)\ID Process',
  '\Process(postgres*)\% Processor Time',
  '\Process(k6*)\% Processor Time'
)
$writer = [System.IO.StreamWriter]::new($Out, $true)
$writer.AutoFlush = $true
try {
  while ($true) {
    $sample = Get-Counter -Counter $paths -SampleInterval 1 -MaxSamples 1 -ErrorAction SilentlyContinue
    if ($null -eq $sample) { continue }
    $total = 0.0; $postgres = 0.0; $k6 = 0.0
    $nodeCpu = @{}; $nodeId = @{}
    foreach ($s in $sample.CounterSamples) {
      $path = $s.Path
      # 같은 이름의 프로세스는 InstanceName이 모두 node이고, 경로에만 node#3처럼 번호가 붙는다. 경로에서 인스턴스를 꺼낸다.
      $instance = $path -replace '^.*\\process\(([^)]*)\)\\.*$', '$1'
      if ($path -like '*\processor(_total)\*') { $total = $s.CookedValue }
      elseif ($path -like '*\process(postgres*') { $postgres += $s.CookedValue }
      elseif ($path -like '*\process(k6*') { $k6 += $s.CookedValue }
      elseif ($path -like '*\process(node*)\id process') { $nodeId[$instance] = [int]$s.CookedValue }
      elseif ($path -like '*\process(node*') { $nodeCpu[$instance] = $s.CookedValue }
    }
    $node = @{}
    foreach ($name in $nodeCpu.Keys) { if ($nodeId.ContainsKey($name)) { $node[[string]$nodeId[$name]] = [math]::Round($nodeCpu[$name], 1) } }
    $line = [ordered]@{
      at = (Get-Date).ToUniversalTime().ToString('o')
      totalPct = [math]::Round($total, 1)
      postgresPct = [math]::Round($postgres, 1)
      k6Pct = [math]::Round($k6, 1)
      nodePctByPid = $node
    }
    $writer.WriteLine(($line | ConvertTo-Json -Compress))
  }
} finally {
  $writer.Dispose()
}
