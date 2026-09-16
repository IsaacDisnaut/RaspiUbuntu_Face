# Generates a self-signed TLS certificate for Mosquitto WSS.
# Pure PowerShell — no openssl required.
# Run from project root:  .\mosquitto\generate-certs.ps1

$outDir   = "$PSScriptRoot\certs"
$certFile = "$outDir\cert.pem"
$keyFile  = "$outDir\key.pem"
$pfxPath  = "$outDir\temp.pfx"

New-Item -ItemType Directory -Force $outDir | Out-Null

# ── DER encoding helpers ──────────────────────────────────────
function DerLength([int]$len) {
    if ($len -lt 128)  { return [byte[]]@($len) }
    if ($len -le 0xFF) { return [byte[]]@(0x81, $len) }
    return [byte[]]@(0x82, (($len -shr 8) -band 0xFF), ($len -band 0xFF))
}
function DerInt([byte[]]$val) {
    if ($val -eq $null -or $val.Length -eq 0) { $val = @(0x00) }
    $i = 0; while ($i -lt $val.Length - 1 -and $val[$i] -eq 0) { $i++ }
    $val = [byte[]]$val[$i..($val.Length-1)]
    if ($val[0] -band 0x80) { $val = [byte[]](@(0x00) + $val) }
    return [byte[]](@(0x02) + (DerLength $val.Length) + $val)
}
function DerSeq([byte[]]$c) {
    return [byte[]](@(0x30) + (DerLength $c.Length) + $c)
}

# ── 1. Create self-signed cert ────────────────────────────────
Write-Host "Creating certificate..."
$cert = New-SelfSignedCertificate `
    -DnsName "localhost" `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -NotAfter (Get-Date).AddYears(10) `
    -KeyAlgorithm RSA -KeyLength 2048 `
    -KeyExportPolicy Exportable `
    -Provider "Microsoft Enhanced RSA and AES Cryptographic Provider"

# ── 2. Export PFX, reload with CAPI flags ─────────────────────
$pwd = ConvertTo-SecureString "x" -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $pwd | Out-Null

# Load with both Exportable and UserKeySet so .PrivateKey returns
# RSACryptoServiceProvider (CAPI) instead of RSACng — CAPI allows ExportParameters
$flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable `
       -bor [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::UserKeySet
$x509 = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($pfxPath, "x", $flags)

# ── 3. Write cert.pem ─────────────────────────────────────────
$rawCert = $x509.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
$b64 = ($([Convert]::ToBase64String($rawCert)) -split "(.{64})" | Where-Object { $_ }) -join "`n"
Set-Content $certFile -Encoding ASCII "-----BEGIN CERTIFICATE-----`n$b64`n-----END CERTIFICATE-----"
Write-Host "cert.pem written."

# ── 4. Write key.pem via PKCS#1 DER encoding ─────────────────
# .PrivateKey returns RSACryptoServiceProvider which supports ExportParameters
$rsa = $x509.PrivateKey
$p   = $rsa.ExportParameters($true)

[byte[]]$ver   = @(0x02, 0x01, 0x00)
[byte[]]$body  = $ver + (DerInt $p.Modulus) + (DerInt $p.Exponent) +
                 (DerInt $p.D) + (DerInt $p.P) + (DerInt $p.Q) +
                 (DerInt $p.DP) + (DerInt $p.DQ) + (DerInt $p.InverseQ)
[byte[]]$pkcs1 = DerSeq $body

$kb64 = ($([Convert]::ToBase64String($pkcs1)) -split "(.{64})" | Where-Object { $_ }) -join "`n"
Set-Content $keyFile -Encoding ASCII "-----BEGIN RSA PRIVATE KEY-----`n$kb64`n-----END RSA PRIVATE KEY-----"
Write-Host "key.pem  written."

# ── 5. Clean up ───────────────────────────────────────────────
Remove-Item $pfxPath -Force
Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)" -Force

Write-Host ""
Write-Host "Done!  cert.pem and key.pem are in: $outDir"
Write-Host ""
Write-Host "NOTE: Browsers block self-signed certs."
Write-Host "      Visit https://localhost:9443 once, click Advanced -> Proceed."
