# -Debuggable: a local test build (android:debuggable, WebView remote
# debugging, run-as) written to %TEMP%; the release APK and version.json are
# left untouched. Never publish it.
param([switch]$Debuggable)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AndroidDir = "$ProjectRoot\android"
$WebDir = "$ProjectRoot\mobile\www"
$AssetsWwwDir = "$AndroidDir\assets\www"
$BuildDir = "$AndroidDir\build"
$OutputApk = "$ProjectRoot\agy-roleplay-android16.apk"
if ($Debuggable) { $OutputApk = "$env:TEMP\agy-roleplay-debug.apk" }
$ToolsCache = "C:\Users\Kazuma\.gemini\antigravity-cli\brain\5fcbe0c0-e9e8-4f16-9fa1-c4f2a1a5c107\scratch\android-sdk"

New-Item -ItemType Directory -Force -Path $ToolsCache | Out-Null

# 1. Ensure Portable JDK 17
$JdkZip = "$ToolsCache\jdk17.zip"
$JdkExtract = "$ToolsCache\jdk"
if (-not (Test-Path "$JdkExtract\*\bin\javac.exe")) {
    Write-Host "[1/6] Downloading Portable OpenJDK 17..."
    & curl.exe -L -s "https://aka.ms/download-jdk/microsoft-jdk-17.0.13-windows-x64.zip" -o $JdkZip
    Write-Host "Extracting OpenJDK 17..."
    Expand-Archive -Path $JdkZip -DestinationPath $JdkExtract -Force
}
$JdkHome = (Get-ChildItem -Directory $JdkExtract | Select-Object -First 1).FullName
$env:JAVA_HOME = $JdkHome
$env:PATH = "$JdkHome\bin;$env:PATH"
$Javac = "$JdkHome\bin\javac.exe"
$Java = "$JdkHome\bin\java.exe"
$Keytool = "$JdkHome\bin\keytool.exe"

# 2. Ensure Android Build-Tools 35
$BtZip = "$ToolsCache\build-tools-35.zip"
$BtExtract = "$ToolsCache\build-tools"
if (-not (Test-Path "$BtExtract\*\aapt2.exe")) {
    Write-Host "[2/6] Downloading Android SDK Build-Tools 35..."
    & curl.exe -L -s "https://dl.google.com/android/repository/build-tools_r35_windows.zip" -o $BtZip
    Write-Host "Extracting Build-Tools 35..."
    Expand-Archive -Path $BtZip -DestinationPath $BtExtract -Force
}
$BtHome = (Get-ChildItem -Directory $BtExtract | Select-Object -First 1).FullName
$Aapt2 = "$BtHome\aapt2.exe"
$Zipalign = "$BtHome\zipalign.exe"
$D8Jar = "$BtHome\lib\d8.jar"
$ApksignerJar = "$BtHome\lib\apksigner.jar"

# 3. Ensure Android Platform 35 (android.jar)
$PlatZip = "$ToolsCache\platform-35.zip"
$PlatExtract = "$ToolsCache\platforms"
if (-not (Test-Path "$PlatExtract\*\android.jar")) {
    Write-Host "[3/6] Downloading Android Platform 35 (android.jar)..."
    & curl.exe -L -s "https://dl.google.com/android/repository/platform-35_r01.zip" -o $PlatZip
    Write-Host "Extracting Platform 35..."
    Expand-Archive -Path $PlatZip -DestinationPath $PlatExtract -Force
}
$AndroidJar = (Get-ChildItem -Path $PlatExtract -Filter "android.jar" -Recurse | Select-Object -First 1).FullName

Write-Host "Using JAVA_HOME: $JdkHome"
Write-Host "Using Build-Tools: $BtHome"
Write-Host "Using android.jar: $AndroidJar"

# 4. Sync Mobile Web UI & version.json into Android assets
Write-Host "[4/6] Syncing version.json and mobile/www into android/assets/www..."

# Run the web-layer unit tests before bundling them into the APK.
# Set $env:AGY_SKIP_TESTS = "1" to bypass (not recommended for releases).
if ($env:AGY_SKIP_TESTS -ne "1") {
    $NodeExe = (Get-Command node -ErrorAction SilentlyContinue)
    if ($NodeExe) {
        Write-Host "Running web unit tests (mobile/tests)..."
        Push-Location $ProjectRoot
        & node --test "mobile/tests/*.test.js"
        $TestExit = $LASTEXITCODE
        Pop-Location
        if ($TestExit -ne 0) {
            throw "Web unit tests failed - aborting build. Fix the tests or set AGY_SKIP_TESTS=1 to override."
        }
    } else {
        Write-Host "WARNING: node not found - skipping web unit tests." -ForegroundColor Yellow
    }
}

# Byte copy with a fresh timestamp: Copy-Item keeps the source mtime, and a
# same-size file with an unchanged mtime can slip past git's change detection.
function Copy-Fresh([string]$From, [string]$To) {
    [System.IO.File]::WriteAllBytes($To, [System.IO.File]::ReadAllBytes($From))
}
if (Test-Path "$ProjectRoot\version.json") {
    Copy-Fresh "$ProjectRoot\version.json" "$WebDir\version.json"
}
if (Test-Path $AssetsWwwDir) { Remove-Item -Recurse -Force $AssetsWwwDir }
New-Item -ItemType Directory -Force -Path $AssetsWwwDir | Out-Null
Copy-Item -Path "$WebDir\*" -Destination $AssetsWwwDir -Recurse -Force

# Clean build directory
if (Test-Path $BuildDir) { Remove-Item -Recurse -Force $BuildDir }
New-Item -ItemType Directory -Force -Path "$BuildDir\compiled_res" | Out-Null
New-Item -ItemType Directory -Force -Path "$BuildDir\gen" | Out-Null
New-Item -ItemType Directory -Force -Path "$BuildDir\classes" | Out-Null
New-Item -ItemType Directory -Force -Path "$BuildDir\dex" | Out-Null

# 5. Compile Resources & Link APK
Write-Host "[5/6] Compiling Android resources and Java source..."
$ResFiles = Get-ChildItem -Path "$AndroidDir\res" -File -Recurse
foreach ($f in $ResFiles) {
    & $Aapt2 compile $f.FullName -o "$BuildDir\compiled_res"
    if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed on $($f.FullName)" }
}

$FlatFiles = (Get-ChildItem -Path "$BuildDir\compiled_res" -Filter "*.flat").FullName
$UnalignedApk = "$BuildDir\unaligned.apk"

$ManifestPath = "$AndroidDir\AndroidManifest.xml"
if ($Debuggable) {
    $ManifestPath = "$BuildDir\AndroidManifest.debug.xml"
    $ManifestText = [System.IO.File]::ReadAllText("$AndroidDir\AndroidManifest.xml")
    $ManifestText = $ManifestText.Replace("<application", "<application android:debuggable=`"true`"")
    [System.IO.File]::WriteAllText($ManifestPath, $ManifestText, (New-Object System.Text.UTF8Encoding $false))
}

& $Aapt2 link -o $UnalignedApk `
    -I $AndroidJar `
    --manifest $ManifestPath `
    --java "$BuildDir\gen" `
    --auto-add-overlay `
    $FlatFiles
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed" }

# Compile Java sources
$JavaSources = @(
    "$AndroidDir\src\com\agy\roleplay\MainActivity.java",
    "$AndroidDir\src\com\agy\roleplay\LocalBackendServer.java",
    "$AndroidDir\src\com\agy\roleplay\ClaudeRuntime.java",
    "$AndroidDir\src\com\agy\roleplay\ProcSnapshot.java",
    "$BuildDir\gen\com\agy\roleplay\R.java"
)

& $Javac -encoding UTF-8 -source 8 -target 8 -bootclasspath $AndroidJar -classpath $AndroidJar -d "$BuildDir\classes" $JavaSources
if ($LASTEXITCODE -ne 0) { throw "javac failed" }

# Convert .class to classes.dex using d8.jar
$ClassFiles = (Get-ChildItem -Path "$BuildDir\classes" -Filter "*.class" -Recurse).FullName
& $Java -cp $D8Jar com.android.tools.r8.D8 --lib $AndroidJar --min-api 28 --output "$BuildDir\dex" $ClassFiles
if ($LASTEXITCODE -ne 0) { throw "d8 failed" }

# Add classes.dex and assets/www/* (with POSIX forward slashes!) into unaligned.apk using JDK jar tool
$JarTool = "$JdkHome\bin\jar.exe"
& $JarTool -uf $UnalignedApk -C "$BuildDir\dex" classes.dex
if ($LASTEXITCODE -ne 0) { throw "jar -uf classes.dex failed" }
& $JarTool -uf $UnalignedApk -C $AndroidDir assets
if ($LASTEXITCODE -ne 0) { throw "jar -uf assets failed" }

# 6. Zipalign & Sign with v1 + v2 + v3 for Android 16
Write-Host "[6/6] Zipaligning and signing APK (v1 + v2 + v3) for Android 16..."
$AlignedApk = "$BuildDir\aligned.apk"
& $Zipalign -p -f 4 $UnalignedApk $AlignedApk
if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }

$Keystore = "$AndroidDir\agy-release.keystore"
if (-not (Test-Path $Keystore)) {
    Write-Host ""
    Write-Host "=============================================================" -ForegroundColor Yellow
    Write-Host " CREATING A NEW RELEASE KEYSTORE" -ForegroundColor Yellow
    Write-Host "=============================================================" -ForegroundColor Yellow
    Write-Host " Android only allows an update to install over an existing app"
    Write-Host " when both are signed with the SAME key."
    Write-Host ""
    Write-Host " If this keystore is lost, every future APK must be installed"
    Write-Host " by UNINSTALLING the app first - which DELETES ALL CHATS."
    Write-Host ""
    Write-Host " ACTION REQUIRED: back up this file off this machine:"
    Write-Host "   $Keystore" -ForegroundColor Cyan
    Write-Host " It is gitignored on purpose and is NOT in the repository."
    Write-Host "=============================================================" -ForegroundColor Yellow
    Write-Host ""

    & $Keytool -genkeypair -v `
        -keystore $Keystore `
        -alias agyroleplay `
        -keyalg RSA `
        -keysize 2048 `
        -validity 10000 `
        -storepass agyroleplay123 `
        -keypass agyroleplay123 `
        -dname "CN=AGY Roleplay Studio, OU=Mobile, O=Antigravity, L=Almaty, S=KZ, C=KZ"
    if ($LASTEXITCODE -ne 0) { throw "keytool failed" }
}

& $Java -jar $ApksignerJar sign `
    --ks $Keystore `
    --ks-key-alias agyroleplay `
    --ks-pass pass:agyroleplay123 `
    --key-pass pass:agyroleplay123 `
    --v1-signing-enabled true `
    --v2-signing-enabled true `
    --v3-signing-enabled true `
    --out $OutputApk `
    $AlignedApk
if ($LASTEXITCODE -ne 0) { throw "apksigner sign failed" }

Write-Host "Verifying signed APK..."
& $Java -jar $ApksignerJar verify --verbose $OutputApk
if ($LASTEXITCODE -ne 0) { throw "apksigner verify failed" }

$ApkInfo = Get-Item $OutputApk
$ApkSha = (Get-FileHash -Path $OutputApk -Algorithm SHA256).Hash.ToLower()

Write-Host ""
Write-Host "SUCCESS! Built Android 16 APK: $($ApkInfo.FullName) ($($ApkInfo.Length) bytes)" -ForegroundColor Green
Write-Host "SHA-256: $ApkSha"

# Record the hash in version.json so users can verify a downloaded APK and the
# in-app updater can display it alongside the download link.
$VersionJsonPath = "$ProjectRoot\version.json"
if ($Debuggable) {
    Write-Host "Debuggable test build: version.json left untouched. Do not publish this APK." -ForegroundColor Yellow
    return
}
if (Test-Path $VersionJsonPath) {
    try {
        # -Encoding UTF8: Windows PowerShell 5.1 otherwise reads the BOM-less file as ANSI (cp1251)
        $Manifest = Get-Content $VersionJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $Manifest | Add-Member -NotePropertyName apkSha256 -NotePropertyValue $ApkSha -Force
        $Manifest | Add-Member -NotePropertyName apkSize -NotePropertyValue $ApkInfo.Length -Force
        $Json = $Manifest | ConvertTo-Json -Depth 20
        $Utf8NoBom = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($VersionJsonPath, $Json, $Utf8NoBom)
        Copy-Fresh $VersionJsonPath "$WebDir\version.json"
        Write-Host "Recorded apkSha256 in version.json"
    } catch {
        Write-Host "WARNING: could not update version.json with apkSha256: $_" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "NEXT STEPS:" -ForegroundColor Cyan
Write-Host "  1. Sign the OTA bundle so in-app updates are accepted:"
Write-Host "       .\sign-ota.ps1"
Write-Host "     (first time only: .\sign-ota.ps1 -Init, then paste the public key"
Write-Host "      into LocalBackendServer.java -> OTA_PUBLIC_KEY_B64 and rebuild)"
Write-Host "  2. Publish this APK as a GitHub Release asset and verify SHA-256 above."
Write-Host "  3. Confirm your keystore backup still exists:"
Write-Host "       $Keystore"
Write-Host ""
