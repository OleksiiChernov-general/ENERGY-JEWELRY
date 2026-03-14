param(
    [int]$Port = 8086,
    [switch]$OpenBrowser
)

$ErrorActionPreference = "Stop"

$script:AppRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:ProjectRoot = Split-Path -Parent $script:AppRoot
$script:StaticRoot = Join-Path $script:AppRoot "static"
$script:DataRoot = Join-Path $script:AppRoot "data"
$script:ProductsDir = Join-Path $script:ProjectRoot "CSV_Export"
$script:ProductsCsvPath = (Get-ChildItem -LiteralPath $script:ProductsDir -Filter "*_csv.csv" | Select-Object -First 1 -ExpandProperty FullName)
$script:OrdersJsonPath = Join-Path $script:DataRoot "product-orders.json"
$script:OrdersXlsPath = Join-Path $script:DataRoot "product-orders.xls"
$script:Culture = [System.Globalization.CultureInfo]::InvariantCulture

[System.IO.Directory]::CreateDirectory($script:DataRoot) | Out-Null

function ConvertTo-FlatJson {
    param([object]$Value)

    $Value | ConvertTo-Json -Depth 10 -Compress
}

function Write-HttpResponse {
    param(
        [System.Net.Sockets.NetworkStream]$Stream,
        [int]$StatusCode,
        [byte[]]$Body,
        [string]$ContentType,
        [hashtable]$Headers = @{}
    )

    $statusText = switch ($StatusCode) {
        200 { "OK" }
        201 { "Created" }
        400 { "Bad Request" }
        404 { "Not Found" }
        default { "OK" }
    }

    $headerLines = New-Object System.Collections.Generic.List[string]
    $headerLines.Add("HTTP/1.1 $StatusCode $statusText") | Out-Null
    $headerLines.Add("Content-Type: $ContentType") | Out-Null
    $headerLines.Add("Content-Length: $($Body.Length)") | Out-Null
    $headerLines.Add("Connection: close") | Out-Null
    foreach ($key in $Headers.Keys) {
        $headerLines.Add("${key}: $($Headers[$key])") | Out-Null
    }
    $headerLines.Add("") | Out-Null
    $headerLines.Add("") | Out-Null

    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes(($headerLines -join "`r`n"))
    $Stream.Write($headerBytes, 0, $headerBytes.Length)
    $Stream.Write($Body, 0, $Body.Length)
}

function Send-JsonResponse {
    param(
        [System.Net.Sockets.NetworkStream]$Stream,
        [int]$StatusCode,
        [object]$Payload
    )

    $json = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-FlatJson $Payload))
    Write-HttpResponse -Stream $Stream -StatusCode $StatusCode -Body $json -ContentType "application/json; charset=utf-8"
}

function Send-TextResponse {
    param(
        [System.Net.Sockets.NetworkStream]$Stream,
        [int]$StatusCode,
        [string]$Text,
        [string]$ContentType = "text/plain; charset=utf-8"
    )

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
    Write-HttpResponse -Stream $Stream -StatusCode $StatusCode -Body $bytes -ContentType $ContentType
}

function Get-MimeType {
    param([string]$Path)

    switch ([System.IO.Path]::GetExtension($Path).ToLowerInvariant()) {
        ".html" { "text/html; charset=utf-8"; break }
        ".css" { "text/css; charset=utf-8"; break }
        ".js" { "application/javascript; charset=utf-8"; break }
        ".json" { "application/json; charset=utf-8"; break }
        ".jpg" { "image/jpeg"; break }
        ".jpeg" { "image/jpeg"; break }
        ".xls" { "application/vnd.ms-excel"; break }
        default { "application/octet-stream" }
    }
}

function Send-FileResponse {
    param(
        [System.Net.Sockets.NetworkStream]$Stream,
        [string]$Path,
        [hashtable]$Headers = @{}
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        Send-TextResponse -Stream $Stream -StatusCode 404 -Text "Not found"
        return
    }

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if (-not $Headers.ContainsKey("Cache-Control")) {
        $Headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    }
    if (-not $Headers.ContainsKey("Pragma")) {
        $Headers["Pragma"] = "no-cache"
    }
    if (-not $Headers.ContainsKey("Expires")) {
        $Headers["Expires"] = "0"
    }

    Write-HttpResponse -Stream $Stream -StatusCode 200 -Body $bytes -ContentType (Get-MimeType -Path $Path) -Headers $Headers
}

function Parse-Decimal {
    param([AllowNull()][string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return 0.0
    }

    $normalized = $Value.Trim() -replace "\s", "" -replace ",", "."
    $result = 0.0
    if ([double]::TryParse($normalized, [System.Globalization.NumberStyles]::Float, $script:Culture, [ref]$result)) {
        return $result
    }

    return 0.0
}

function Format-Decimal {
    param([double]$Value)

    $Value.ToString("0.00", $script:Culture)
}

function Escape-Xml {
    param([AllowNull()][string]$Value)

    if ($null -eq $Value) {
        return ""
    }

    [System.Security.SecurityElement]::Escape($Value)
}

function Get-ProductCatalog {
    if ([string]::IsNullOrWhiteSpace($script:ProductsCsvPath) -or -not (Test-Path -LiteralPath $script:ProductsCsvPath)) {
        throw "CSV catalog was not found in $script:ProductsDir"
    }

    $bytes = [System.IO.File]::ReadAllBytes($script:ProductsCsvPath)
    $lines = [System.Text.Encoding]::GetEncoding(1251).GetString($bytes)
    $rows = ConvertFrom-Csv -InputObject $lines
    $items = New-Object System.Collections.Generic.List[object]

    foreach ($row in $rows) {
        $name = ([string]$row."Type of product").Trim()
        if ([string]::IsNullOrWhiteSpace($name)) {
            continue
        }

        $items.Add([pscustomobject]@{
            id = $name
            name = $name
        }) | Out-Null
    }

    @($items.ToArray() | Sort-Object name -Unique)
}

function Normalize-Order {
    param([pscustomobject]$Order)

    $openedAt = [string]$Order.openedAt
    if ([string]::IsNullOrWhiteSpace($openedAt)) {
        $openedAt = [string]$Order.createdAt
    }

    $createdAt = [string]$Order.createdAt
    if ([string]::IsNullOrWhiteSpace($createdAt)) {
        $createdAt = $openedAt
    }

    $status = [string]$Order.status
    if ([string]::IsNullOrWhiteSpace($status)) {
        $status = "Open"
    }

    [pscustomobject]@{
        orderId = [string]$Order.orderId
        product = [string]$Order.product
        quantity = [int]$Order.quantity
        price = [Math]::Round((Parse-Decimal ([string]$Order.price)), 2)
        total = [Math]::Round((Parse-Decimal ([string]$Order.total)), 2)
        requestDescription = [string]$Order.requestDescription
        customerName = [string]$Order.customerName
        customerAddress = [string]$Order.customerAddress
        openedAt = $openedAt
        createdAt = $createdAt
        status = $status
        completedAt = [string]$Order.completedAt
    }
}

function Get-SortedOrders {
    param([object[]]$Orders)

    @(
        $Orders |
        Sort-Object @{ Expression = { if ([string]$_.status -eq "Completed") { 1 } else { 0 } } }, `
                    @{ Expression = { [string]$_.openedAt }; Descending = $true }
    )
}

function Load-Orders {
    if (-not (Test-Path -LiteralPath $script:OrdersJsonPath)) {
        return @()
    }

    $raw = Get-Content -LiteralPath $script:OrdersJsonPath -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return @()
    }

    $data = $raw | ConvertFrom-Json
    $items = if ($data -is [System.Array]) { @($data) } else { @($data) }
    @($items | ForEach-Object { Normalize-Order $_ })
}

function Save-Orders {
    param([object[]]$Orders)

    (ConvertTo-Json -InputObject @($Orders) -Depth 10) | Set-Content -LiteralPath $script:OrdersJsonPath -Encoding UTF8
}

function Build-SpreadsheetXml {
    param([object[]]$Orders)

    $headers = @(
        "Order ID", "Product", "Quantity", "Price", "Total",
        "Request Description", "Customer Name", "Customer Address",
        "Opened At", "Status", "Completed At"
    )

    $rowBuilder = New-Object System.Text.StringBuilder
    [void]$rowBuilder.AppendLine('<Row ss:StyleID="Header">')
    foreach ($header in $headers) {
        [void]$rowBuilder.AppendLine("<Cell><Data ss:Type=`"String`">$([string](Escape-Xml $header))</Data></Cell>")
    }
    [void]$rowBuilder.AppendLine("</Row>")

    foreach ($order in $Orders) {
        [void]$rowBuilder.AppendLine("<Row>")
        [void]$rowBuilder.AppendLine("<Cell><Data ss:Type=`"String`">$([string](Escape-Xml $order.orderId))</Data></Cell>")
        [void]$rowBuilder.AppendLine("<Cell><Data ss:Type=`"String`">$([string](Escape-Xml $order.product))</Data></Cell>")
        [void]$rowBuilder.AppendLine("<Cell><Data ss:Type=`"Number`">$([string](Format-Decimal ([double]$order.quantity)))</Data></Cell>")
        [void]$rowBuilder.AppendLine("<Cell><Data ss:Type=`"Number`">$([string](Format-Decimal ([double]$order.price)))</Data></Cell>")
        [void]$rowBuilder.AppendLine("<Cell><Data ss:Type=`"Number`">$([string](Format-Decimal ([double]$order.total)))</Data></Cell>")
        [void]$rowBuilder.AppendLine("<Cell><Data ss:Type=`"String`">$([string](Escape-Xml $order.requestDescription))</Data></Cell>")
        [void]$rowBuilder.AppendLine("<Cell><Data ss:Type=`"String`">$([string](Escape-Xml $order.customerName))</Data></Cell>")
        [void]$rowBuilder.AppendLine("<Cell><Data ss:Type=`"String`">$([string](Escape-Xml $order.customerAddress))</Data></Cell>")
        [void]$rowBuilder.AppendLine("<Cell><Data ss:Type=`"String`">$([string](Escape-Xml $order.openedAt))</Data></Cell>")
        [void]$rowBuilder.AppendLine("<Cell><Data ss:Type=`"String`">$([string](Escape-Xml $order.status))</Data></Cell>")
        [void]$rowBuilder.AppendLine("<Cell><Data ss:Type=`"String`">$([string](Escape-Xml $order.completedAt))</Data></Cell>")
        [void]$rowBuilder.AppendLine("</Row>")
    }

    @"
<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="Default" ss:Name="Normal">
   <Alignment ss:Vertical="Top" ss:WrapText="1"/>
   <Borders/>
   <Font ss:FontName="Calibri" ss:Size="11"/>
   <Interior/>
   <NumberFormat/>
   <Protection/>
  </Style>
  <Style ss:ID="Header">
   <Font ss:Bold="1"/>
   <Interior ss:Color="#E6D4BC" ss:Pattern="Solid"/>
  </Style>
 </Styles>
 <Worksheet ss:Name="Orders">
  <Table>
$($rowBuilder.ToString())
  </Table>
 </Worksheet>
</Workbook>
"@
}

function Export-OrdersWorkbook {
    param([object[]]$Orders)

    $xml = Build-SpreadsheetXml -Orders $Orders
    [System.IO.File]::WriteAllText($script:OrdersXlsPath, $xml, [System.Text.UTF8Encoding]::new($false))
}

function Validate-Order {
    param([pscustomobject]$Payload)

    foreach ($field in @("product", "requestDescription", "customerName", "customerAddress")) {
        if ([string]::IsNullOrWhiteSpace([string]$Payload.$field)) {
            throw "Field '$field' is required."
        }
    }

    $productNames = @(Get-ProductCatalog | ForEach-Object { $_.name })
    if ($productNames -notcontains [string]$Payload.product) {
        throw "Selected product is missing from the CSV catalog."
    }

    $quantity = [int]$Payload.quantity
    if ($quantity -lt 1) {
        throw "Quantity must be greater than zero."
    }

    $price = Parse-Decimal ([string]$Payload.price)
    if ($price -lt 0) {
        throw "Price must not be negative."
    }
}

function New-Order {
    param([pscustomobject]$Payload)

    Validate-Order -Payload $Payload

    $quantity = [int]$Payload.quantity
    $price = Parse-Decimal ([string]$Payload.price)
    $openedAt = [DateTime]::Now.ToString("yyyy-MM-dd HH:mm:ss")

    [pscustomobject]@{
        orderId = "ORD-$([DateTime]::Now.ToString("yyyyMMddHHmmssfff"))"
        product = ([string]$Payload.product).Trim()
        quantity = $quantity
        price = [Math]::Round($price, 2)
        total = [Math]::Round(($quantity * $price), 2)
        requestDescription = ([string]$Payload.requestDescription).Trim()
        customerName = ([string]$Payload.customerName).Trim()
        customerAddress = ([string]$Payload.customerAddress).Trim()
        openedAt = $openedAt
        createdAt = $openedAt
        status = "Open"
        completedAt = ""
    }
}

function Complete-Order {
    param([string]$OrderId)

    $orders = New-Object System.Collections.Generic.List[object]
    $updatedOrder = $null

    foreach ($item in (Load-Orders)) {
        $order = Normalize-Order $item
        if ($order.orderId -eq $OrderId) {
            if ([string]$order.status -eq "Completed") {
                throw "Order is already completed."
            }

            $order.status = "Completed"
            $order.completedAt = [DateTime]::Now.ToString("yyyy-MM-dd HH:mm:ss")
            $updatedOrder = $order
        }
        $orders.Add($order) | Out-Null
    }

    if ($null -eq $updatedOrder) {
        throw "Order not found."
    }

    $sortedOrders = @(Get-SortedOrders -Orders $orders.ToArray())
    Save-Orders -Orders $sortedOrders
    Export-OrdersWorkbook -Orders $sortedOrders

    @{
        item = $updatedOrder
        workbook = "/download/product-orders.xls"
    }
}

function Cancel-Order {
    param([string]$OrderId)

    $remainingOrders = New-Object System.Collections.Generic.List[object]
    $removed = $false

    foreach ($item in (Load-Orders)) {
        $order = Normalize-Order $item
        if ($order.orderId -eq $OrderId) {
            $removed = $true
            continue
        }

        $remainingOrders.Add($order) | Out-Null
    }

    if (-not $removed) {
        throw "Order not found."
    }

    $sortedOrders = @(Get-SortedOrders -Orders $remainingOrders.ToArray())
    Save-Orders -Orders $sortedOrders
    Export-OrdersWorkbook -Orders $sortedOrders

    @{
        removedOrderId = $OrderId
        workbook = "/download/product-orders.xls"
    }
}

function Read-HttpRequest {
    param([System.Net.Sockets.NetworkStream]$Stream)

    $headerBytes = New-Object System.Collections.Generic.List[byte]
    $lastBytes = New-Object System.Collections.Generic.Queue[byte]

    while ($true) {
        $value = $Stream.ReadByte()
        if ($value -lt 0) {
            return $null
        }

        $byteValue = [byte]$value
        $headerBytes.Add($byteValue) | Out-Null
        $lastBytes.Enqueue($byteValue)
        if ($lastBytes.Count -gt 4) {
            [void]$lastBytes.Dequeue()
        }

        if ($lastBytes.Count -eq 4) {
            $ending = $lastBytes.ToArray()
            if ($ending[0] -eq 13 -and $ending[1] -eq 10 -and $ending[2] -eq 13 -and $ending[3] -eq 10) {
                break
            }
        }
    }

    $headerText = [System.Text.Encoding]::ASCII.GetString($headerBytes.ToArray())
    $headerLines = $headerText -split "`r`n"
    $requestLine = $headerLines[0]
    $parts = $requestLine -split " "
    if ($parts.Count -lt 2) {
        throw "Invalid HTTP request line."
    }

    $headers = @{}
    foreach ($line in $headerLines[1..($headerLines.Length - 1)]) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        $separator = $line.IndexOf(":")
        if ($separator -gt 0) {
            $headers[$line.Substring(0, $separator).Trim().ToLowerInvariant()] = $line.Substring($separator + 1).Trim()
        }
    }

    $contentLength = 0
    if ($headers.ContainsKey("content-length")) {
        $contentLength = [int]$headers["content-length"]
    }

    $bodyBytes = New-Object byte[] $contentLength
    $offset = 0
    while ($offset -lt $contentLength) {
        $read = $Stream.Read($bodyBytes, $offset, $contentLength - $offset)
        if ($read -le 0) {
            break
        }
        $offset += $read
    }

    [pscustomobject]@{
        Method = $parts[0].ToUpperInvariant()
        Path = $parts[1]
        Headers = $headers
        Body = [System.Text.Encoding]::UTF8.GetString($bodyBytes, 0, $offset)
    }
}

function Handle-Request {
    param(
        [System.Net.Sockets.TcpClient]$Client,
        [pscustomobject]$Request
    )

    $stream = $Client.GetStream()
    $path = ($Request.Path -split "\?")[0]

    try {
        if ($Request.Method -eq "POST" -and $path -match "^/api/orders/.+/complete$") {
            $orderId = [System.Uri]::UnescapeDataString(($path -replace "^/api/orders/", "" -replace "/complete$", ""))
            Send-JsonResponse -Stream $stream -StatusCode 200 -Payload (Complete-Order -OrderId $orderId)
            return
        }

        if ($Request.Method -eq "POST" -and $path -match "^/api/orders/.+/cancel$") {
            $orderId = [System.Uri]::UnescapeDataString(($path -replace "^/api/orders/", "" -replace "/cancel$", ""))
            Send-JsonResponse -Stream $stream -StatusCode 200 -Payload (Cancel-Order -OrderId $orderId)
            return
        }

        switch ("$($Request.Method) $path") {
            "GET /" {
                Send-FileResponse -Stream $stream -Path (Join-Path $script:StaticRoot "index.html")
                return
            }
            "GET /app.js" {
                Send-FileResponse -Stream $stream -Path (Join-Path $script:StaticRoot "app.js")
                return
            }
            "GET /styles.css" {
                Send-FileResponse -Stream $stream -Path (Join-Path $script:StaticRoot "styles.css")
                return
            }
            "GET /background-photo.jpg" {
                Send-FileResponse -Stream $stream -Path (Join-Path $script:StaticRoot "background-photo.jpg")
                return
            }
            "GET /api/products" {
                Send-JsonResponse -Stream $stream -StatusCode 200 -Payload @{ items = @(Get-ProductCatalog) }
                return
            }
            "GET /api/orders" {
                Send-JsonResponse -Stream $stream -StatusCode 200 -Payload @{
                    items = @(Get-SortedOrders -Orders (Load-Orders))
                    workbook = "/download/product-orders.xls"
                }
                return
            }
            "GET /download/product-orders.xls" {
                if (-not (Test-Path -LiteralPath $script:OrdersXlsPath)) {
                    Export-OrdersWorkbook -Orders (Load-Orders)
                }

                Send-FileResponse -Stream $stream -Path $script:OrdersXlsPath -Headers @{
                    "Content-Disposition" = "attachment; filename=product-orders.xls"
                }
                return
            }
            "POST /api/orders" {
                $order = New-Order -Payload ($Request.Body | ConvertFrom-Json)
                $orders = New-Object System.Collections.Generic.List[object]
                foreach ($item in (Load-Orders)) {
                    $orders.Add($item) | Out-Null
                }
                $orders.Add($order) | Out-Null

                $sortedOrders = @(Get-SortedOrders -Orders $orders.ToArray())
                Save-Orders -Orders $sortedOrders
                Export-OrdersWorkbook -Orders $sortedOrders

                Send-JsonResponse -Stream $stream -StatusCode 201 -Payload @{
                    item = $order
                    workbook = "/download/product-orders.xls"
                }
                return
            }
            default {
                Send-TextResponse -Stream $stream -StatusCode 404 -Text "Not found"
                return
            }
        }
    } catch {
        Send-JsonResponse -Stream $stream -StatusCode 400 -Payload @{ error = $_.Exception.Message }
    }
}

if (-not (Test-Path -LiteralPath $script:OrdersJsonPath)) {
    Save-Orders -Orders @()
}

$normalizedOrders = @(Get-SortedOrders -Orders (Load-Orders))
Save-Orders -Orders $normalizedOrders
Export-OrdersWorkbook -Orders $normalizedOrders

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()

$url = "http://localhost:$Port/"
Write-Host "Product order app started at $url"
Write-Host "Catalog source: $script:ProductsCsvPath"
Write-Host "Workbook output: $script:OrdersXlsPath"
Write-Host "Press Ctrl+C to stop the server."

if ($OpenBrowser) {
    Start-Process $url
}

try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        try {
            $request = Read-HttpRequest -Stream ($client.GetStream())
            if ($null -ne $request) {
                Handle-Request -Client $client -Request $request
            }
        } finally {
            $client.Close()
        }
    }
} finally {
    $listener.Stop()
}
