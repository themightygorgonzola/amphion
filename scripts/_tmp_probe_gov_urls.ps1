$targets = @(
  'https://medlineplus.gov/diabetes.html',
  'https://medlineplus.gov/nutrition.html',
  'https://medlineplus.gov/highbloodpressure.html',
  'https://medlineplus.gov/asthma.html',
  'https://medlineplus.gov/heartdiseases.html',
  'https://medlineplus.gov/stroke.html',
  'https://www.cdc.gov/handwashing/when-how-handwashing.html',
  'https://www.cdc.gov/flu/prevention/index.html',
  'https://www.cdc.gov/healthy-weight-growth/about/index.html',
  'https://www.cdc.gov/diabetes/about/index.html',
  'https://www.cdc.gov/diabetes/risk-factors/index.html',
  'https://www.nist.gov/cyberframework',
  'https://www.nist.gov/privacy-framework',
  'https://www.sba.gov/business-guide',
  'https://www.sba.gov/funding-programs/loans',
  'https://www.osha.gov/heat-exposure',
  'https://www.osha.gov/noise',
  'https://www.consumerfinance.gov/consumer-tools/credit-reports-and-scores/',
  'https://www.consumerfinance.gov/ask-cfpb/what-is-a-credit-score-en-315/',
  'https://www.consumerfinance.gov/ask-cfpb/what-is-a-credit-report-en-309/'
)

$results = foreach ($url in $targets) {
  try {
    $resp = Invoke-WebRequest -Uri $url -Method Head -MaximumRedirection 5 -TimeoutSec 20 -UseBasicParsing -ErrorAction Stop
    $final = $resp.BaseResponse.ResponseUri.AbsoluteUri
    $ext = [System.IO.Path]::GetExtension(([uri]$final).AbsolutePath).ToLowerInvariant()
    [pscustomobject]@{
      url = $url
      finalUrl = $final
      status = [int]$resp.StatusCode
      contentType = $resp.Headers['Content-Type']
      extension = $ext
      directStageable = @('.html', '.htm', '.txt', '.md') -contains $ext
      error = $null
    }
  } catch {
    [pscustomobject]@{
      url = $url
      finalUrl = $null
      status = $null
      contentType = $null
      extension = $null
      directStageable = $false
      error = $_.Exception.Message
    }
  }
}

$results | ConvertTo-Json -Depth 4