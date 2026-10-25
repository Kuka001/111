# =============================================================================
# AGY Roleplay Studio - OTA Bundle Signing Tool
# =============================================================================
# The OTA channel ships executable JavaScript that runs inside the app's WebView
# with full access to chats, workspace files and the Google session. The app
# therefore refuses to install any bundle that is not signed with the release key.
#
# Usage:
#   .\sign-ota.ps1 -Init     # one time: create the OTA release keypair
#   .\sign-ota.ps1           # sign current mobile/www + version.json
#
# After -Init, paste the printed public key into LocalBackendServer.java
# (OTA_PUBLIC_KEY_B64) and rebuild the APK.
#
# SECURITY: ota-release-private.pem must never be committed or shipped in the
# APK. Keep an offline backup — losing it means no further OTA updates.
# =============================================================================

param(
    [switch]$Init
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AndroidDir  = "$ProjectRoot\android"
$WebDir      = "$ProjectRoot\mobile\www"
$VersionJson = "$ProjectRoot\version.json"
$PrivateKey  = "$AndroidDir\ota-release-private.pem"
$PublicKey   = "$AndroidDir\ota-release-public.der"

# Reuse the portable JDK that build-apk.ps1 provisions (keytool/openssl-free path)
$ToolsCache = "C:\Users\Kazuma\.gemini\antigravity-cli\brain\5fcbe0c0-e9e8-4f16-9fa1-c4f2a1a5c107\scratch\android-sdk"
$JdkExtract = "$ToolsCache\jdk"
if (-not (Test-Path "$JdkExtract\*\bin\java.exe")) {
    throw "Portable JDK not found. Run .\build-apk.ps1 once first to provision it."
}
$JdkHome = (Get-ChildItem -Directory $JdkExtract | Select-Object -First 1).FullName
$Java  = "$JdkHome\bin\java.exe"
$Javac = "$JdkHome\bin\javac.exe"

# -----------------------------------------------------------------------------
# Helper Java program: keygen + signing (uses only JDK crypto, no OpenSSL needed)
# -----------------------------------------------------------------------------
$HelperDir = "$AndroidDir\build\otatool"
New-Item -ItemType Directory -Force -Path $HelperDir | Out-Null

$HelperSrc = @'
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.security.spec.*;
import java.util.Base64;

public class OtaTool {
    public static void main(String[] args) throws Exception {
        if (args[0].equals("keygen")) {
            KeyPairGenerator kpg = KeyPairGenerator.getInstance("RSA");
            kpg.initialize(2048);
            KeyPair kp = kpg.generateKeyPair();

            String pem = "-----BEGIN PRIVATE KEY-----\n"
                + Base64.getMimeEncoder(64, new byte[]{'\n'})
                    .encodeToString(kp.getPrivate().getEncoded())
                + "\n-----END PRIVATE KEY-----\n";
            Files.write(Paths.get(args[1]), pem.getBytes(StandardCharsets.US_ASCII));
            Files.write(Paths.get(args[2]), kp.getPublic().getEncoded());

            System.out.println(Base64.getEncoder().encodeToString(kp.getPublic().getEncoded()));
            return;
        }

        if (args[0].equals("sign")) {
            // args: sign <privatePem> <payloadFile>
            String pem = new String(Files.readAllBytes(Paths.get(args[1])), StandardCharsets.US_ASCII)
                .replace("-----BEGIN PRIVATE KEY-----", "")
                .replace("-----END PRIVATE KEY-----", "")
                .replaceAll("\\s", "");
            PrivateKey key = KeyFactory.getInstance("RSA")
                .generatePrivate(new PKCS8EncodedKeySpec(Base64.getDecoder().decode(pem)));

            byte[] payload = Files.readAllBytes(Paths.get(args[2]));
            Signature sig = Signature.getInstance("SHA256withRSA");
            sig.initSign(key);
            sig.update(payload);
            System.out.println(Base64.getEncoder().encodeToString(sig.sign()));
            return;
        }

        throw new IllegalArgumentException("Unknown mode: " + args[0]);
    }
}
'@

$HelperFile = "$HelperDir\OtaTool.java"
$Utf8NoBomSrc = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($HelperFile, $HelperSrc, $Utf8NoBomSrc)
& $Javac -d $HelperDir $HelperFile
if ($LASTEXITCODE -ne 0) { throw "Failed to compile OtaTool helper" }

# -----------------------------------------------------------------------------
# -Init: generate the release keypair
# -----------------------------------------------------------------------------
if ($Init) {
    if (Test-Path $PrivateKey) {
        throw "Key already exists: $PrivateKey`nDelete it ONLY if you accept that previously signed bundles stop verifying."
    }
    Write-Host "Generating RSA-2048 OTA release keypair..."
    $PubB64 = & $Java -cp $HelperDir OtaTool keygen $PrivateKey $PublicKey
    if ($LASTEXITCODE -ne 0) { throw "keygen failed" }

    Write-Host ""
    Write-Host "=== OTA keypair created ===" -ForegroundColor Green
    Write-Host "Private key: $PrivateKey  (NEVER commit or ship this)"
    Write-Host ""
    Write-Host "Paste this into LocalBackendServer.java -> OTA_PUBLIC_KEY_B64:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host $PubB64
    Write-Host ""
    Write-Host "Then rebuild the APK so the key is embedded in the signed binary."
    exit 0
}

# -----------------------------------------------------------------------------
# Sign the current bundle
# -----------------------------------------------------------------------------
if (-not (Test-Path $PrivateKey)) {
    throw "OTA private key not found. Run: .\sign-ota.ps1 -Init"
}

foreach ($f in @("$WebDir\index.html", "$WebDir\app.js", "$WebDir\styles.css", $VersionJson)) {
    if (-not (Test-Path $f)) { throw "Missing required file: $f" }
}

function Get-Sha256Hex([string]$Path) {
    # Hash raw file bytes exactly as the device reads them (UTF-8, no BOM rewrite)
    (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLower()
}

# -Encoding UTF8: Windows PowerShell 5.1 otherwise reads the BOM-less file as ANSI (cp1251)
$Manifest = Get-Content $VersionJson -Raw -Encoding UTF8 | ConvertFrom-Json
$Version  = $Manifest.version
$Build    = [int]$Manifest.build

if (-not $Version -or $Build -le 0) { throw "version.json must contain valid 'version' and 'build'" }

# Canonical payload - must match buildOtaManifestPayload() in LocalBackendServer.java
$Payload = "agy-ota-v1`n" +
           "version=$Version`n" +
           "build=$Build`n" +
           "index.html=$(Get-Sha256Hex "$WebDir\index.html")`n" +
           "app.js=$(Get-Sha256Hex "$WebDir\app.js")`n" +
           "styles.css=$(Get-Sha256Hex "$WebDir\styles.css")`n"

Write-Host "Signing OTA bundle v$Version (build $Build)..."
Write-Host "--- canonical payload ---"
Write-Host $Payload

# Write payload as raw UTF-8 bytes with LF endings (no BOM, no CRLF translation)
$PayloadFile = "$HelperDir\payload.bin"
[System.IO.File]::WriteAllBytes($PayloadFile, [System.Text.Encoding]::UTF8.GetBytes($Payload))

$Signature = & $Java -cp $HelperDir OtaTool sign $PrivateKey $PayloadFile
if ($LASTEXITCODE -ne 0) { throw "signing failed" }
$Signature = $Signature.Trim()

# Embed the signature into version.json.
# Written as UTF-8 WITHOUT BOM: the device parses these exact bytes with
# org.json, and a BOM would make JSONObject() throw.
$Manifest | Add-Member -NotePropertyName otaSignature -NotePropertyValue $Signature -Force
$Json = $Manifest | ConvertTo-Json -Depth 20
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($VersionJson, $Json, $Utf8NoBom)

Write-Host ""
Write-Host "=== OTA bundle signed ===" -ForegroundColor Green
Write-Host "otaSignature written into version.json"
Write-Host ""
Write-Host "IMPORTANT: commit and push mobile/www/* together with version.json." -ForegroundColor Yellow
Write-Host "Changing any of those files after signing invalidates the signature."
