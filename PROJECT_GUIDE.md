# AGY Roleplay Studio — руководство по проекту для ИИ‑ассистента

> Этот файл — «вводная» для нового чата с ИИ. Прочитав его, ассистент должен понимать, что за приложение,
> из чего оно состоит, какой файл за что отвечает и какие файлы нужно менять вместе.
> Актуально для **v1.8.0 (build 26)** — облако со сквозным шифрованием (§17); основа — коммит `b76b785`, 26.10.2026.
> Названия функций и разделов даны точно (по ним удобно искать `grep`); номера строк меняются — не опирайтесь на них.

---

## 0. Коротко (TL;DR)

- **Что это:** Android‑приложение для текстовых ролевых игр (RP) с ИИ‑персонажами. Пользователь — один (автор), приложение ставится вручную (sideload), Google Play не используется.
- **Как устроено:** одна Activity (`MainActivity`) с **WebView**. Весь интерфейс — это обычные `index.html` + `app.js` + `styles.css` (без фреймворков). Весь «бэкенд» — Java‑класс **`LocalBackendServer`** внутри APK; интерфейс общается с ним через JS‑мост `window.AndroidServer.requestAsync(...)` по REST‑подобным путям `/api/...`.
- **Данные:** SQLite (`agy_roleplay.db`) + текстовые файлы в папке `workspace` на телефоне (карточки персонажей/персон, память чатов, системный промпт `GEMINI.md`).
- **Облако (с 1.8.0, необязательно):** зашифрованная на телефоне копия данных в **собственном проекте Firebase пользователя** (вход Google через Firebase Auth + Cloud Firestore, REST без SDK, бесплатный тариф Spark). Телефон остаётся рабочей копией, `CloudSync` синхронизирует; ключ — из пароля пользователя. См. §17.
- **Модели (3 провайдера):**
  1. **Gemini** через Google Vertex AI (вход Google OAuth от «Google Antigravity / AGY», без API‑ключа);
  2. **Claude на Vertex** (Anthropic через Vertex `rawPredict`);
  3. **Claude Code CLI прямо на телефоне** (официальный бинарник Claude Code для linux‑arm64‑musl запускается через загрузчик musl из Alpine; вход по подписке Claude).
- **Обновления:** подписанные OTA‑обновления веб‑интерфейса с GitHub (`Kuka001/111`) + скачивание нового APK, если изменился build.
- **Сборка:** **без Gradle** — PowerShell‑скрипт `android/build-apk.ps1` вызывает `aapt2`/`javac`/`d8`/`apksigner` напрямую. Тесты веб‑слоя — `node --test`.
- **Главное правило пользователя:** системный промпт полностью принадлежит пользователю — **никаких скрытых инструкций** и переписывания текста (см. §12).

---

## 1. Назначение и возможности

- Персонажи (character cards): имя, портрет, описание (идёт модели дословно в `<character_persona>`), приветствие (первое сообщение чата).
- Персоны (кто «вы» в истории): имя, аватар, описание (`<user_persona>`). Одна персона — «по умолчанию» для новых чатов.
- Чаты: у каждого свой персонаж, персона, модель и «глубина рассуждений» (effort), своя «память чата» (`<chat_memory>`), название.
- Сообщения: Markdown для RP (`*действие*`, «реплики»), «мысли» модели (thinking), варианты ответа (свайпы), правка, удаление, откат, перегенерация, остановка генерации.
- Живой стриминг ответа (опрос прогресса), журнал генерации (диагностика).
- Экспорт чата (Markdown/JSON), полная резервная копия/восстановление (JSON).
- Оформление: темы (тёмная/AMOLED/светлая), акцентный цвет, размер шрифта, интервал, шрифт с засечками, подсветка реплик.
- Обновления (OTA/APK), история релизов и коммитов.
- Экран Claude Code CLI: скачивание среды (~130 МБ), «Проверить запуск», вход по подписке Claude.
- «Облако и аккаунт»: вход через Google, пароль шифрования и код восстановления, синхронизация с другими устройствами, выход (с очисткой телефона или без), удаление облачной копии (§17).

Интерфейс полностью на **русском**; комментарии в коде — на **английском**.

---

## 2. Технологии и ключевые решения

| Решение | Почему |
|---|---|
| Нативная часть — Java 8, только Android SDK (без androidx, без Gradle) | простая самодельная сборка `build-apk.ps1` |
| UI — ванильный JS (IIFE в `app.js`), без npm‑зависимостей | UI обновляется по воздуху (OTA) тремя файлами |
| UI грузится с виртуального `https://appassets.agy.local/` через `shouldInterceptRequest` | WebView работает с выключенным доступом к файлам, CSP, «безопасный контекст» |
| `targetSdkVersion 28` (minSdk 26) | только так Android разрешает запуск исполняемых файлов из папки приложения (нужно для Claude Code). На API ≥ 29 `execve` из app‑data запрещён |
| SQLite через `SQLiteDatabase.openOrCreateDatabase`, миграции вручную (`addColumnIfMissing`) | нет фреймворка миграций |
| Токены Google шифруются ключом Android Keystore (AES‑GCM) | файл БД сам по себе не даёт доступа к аккаунту |
| OTA подписывается RSA‑2048/SHA‑256, репозиторий «зашит» в APK | OTA‑бандл — исполняемый JS с доступом к мосту |
| Claude Code запускается **напрямую**, без proot | под proot на ядре 4.14 телефона Bun зависает (clone → ERESTARTNOINTR). proot удалён в 1.7.0 |
| Облако — Firebase (Auth + Firestore) на тарифе Spark, через REST без SDK | бесплатно без карты и не «засыпает» (Supabase засыпает через 7 дней); без Gradle/SDK. Firebase Storage не используется: с 2024 г. он требует Blaze |
| Конфигурация Firebase вводится в приложении, а не зашивается в код | репозиторий и APK публичные; секрет клиента хранится в Keystore |
| Local-first: SQLite остаётся рабочей копией, `CloudSync` синхронизирует записи | скорость, офлайн, квоты Spark (50 000 чтений/20 000 записей в сутки); при сквозном шифровании сервер всё равно не может искать |
| Сквозное шифрование: AES-256-GCM, ключ данных обёрнут паролем (PBKDF2-SHA256, 600 000) и кодом восстановления | Google/Firebase видят только шифротекст и метаданные (число, размер, время записей) |
| Изменения замечают триггеры SQLite (`android/assets/cloud-schema.sql`) | ни один путь записи в БД не может «забыть» отправить изменение в облако |

Устройство пользователя: Redmi Note 9 Pro (joyeuse), Android 16 (кастомная прошивка), ядро 4.14, arm64.

---

## 3. Дерево репозитория

```
mobile_project/
├── PROJECT_GUIDE.md              ← этот файл
├── package.json                  ← только npm‑скрипты: test, check, dev (зависимостей нет)
├── version.json                  ← манифест релизов (читается обновлятором с GitHub), подписан OTA
├── agy-roleplay-android16.apk    ← собранный релизный APK (скачивается приложением при обновлении)
├── .gitattributes                ← "* -text": git НЕ меняет переводы строк (важно для подписи OTA)
├── .gitignore                    ← ключи подписи, android/build, android/assets/www, *.idsig и т.п.
│
├── android/                      ← НАТИВНАЯ ЧАСТЬ (APK)
│   ├── AndroidManifest.xml       ← пакет com.agy.roleplay, versionCode/Name, targetSdk 28, singleTask
│   ├── build-apk.ps1             ← сборка APK (release или -Debuggable)
│   ├── sign-ota.ps1              ← подпись OTA‑бандла (пишет otaSignature в обе копии version.json)
│   ├── src/com/agy/roleplay/
│   │   ├── MainActivity.java       ← Activity + WebView, мост, файлы, «Назад», системные панели
│   │   ├── LocalBackendServer.java ← ВЕСЬ бэкенд: API‑роутер, БД, файлы, провайдеры моделей, OAuth, OTA
│   │   ├── ClaudeRuntime.java      ← среда Claude Code на телефоне: загрузка, проверка, запуск процесса
│   │   ├── ProcSnapshot.java       ← снимки /proc: дерево процессов (kill) и отчёты о зависаниях
│   │   ├── CloudCrypto.java        ← облако: шифрование (AES‑GCM, PBKDF2, код восстановления); только JDK
│   │   ├── CloudStore.java         ← облако: вход Google (loopback + PKCE), Firebase Auth, Firestore REST
│   │   └── CloudSync.java          ← облако: хранилище ключа, синхронизация (pull/push), статус, квоты
│   ├── tests/CloudCryptoTest.java ← JVM‑тест CloudCrypto (запускает build-apk.ps1), векторы общие с Node
│   ├── assets/
│   │   ├── cloud-schema.sql       ← облако: служебные таблицы и триггеры SQLite (выполняется при каждом старте)
│   │   ├── claude-diag/           ← JS‑скрипты, которые Bun (внутри Claude Code) подгружает через --preload
│   │   │   ├── android.cjs          ← ВСЕГДА: DNS телефона для Bun + защита os.networkInterfaces
│   │   │   ├── probe.mjs            ← только «Проверить запуск»: пошаговая проверка рантайма Bun
│   │   │   └── trace.cjs            ← только «Проверить запуск»: heartbeat + лог дочерних процессов
│   │   └── www/                   ← (генерируется при сборке, в .gitignore) копия mobile/www
│   └── res/
│       ├── drawable/ic_launcher.xml, ic_launcher_foreground.xml ← адаптивная иконка
│       ├── values/colors.xml, styles.xml, strings.xml           ← тёмная тема запуска, имя приложения
│       └── xml/network_security_config.xml                      ← HTTPS‑only, кроме localhost (OAuth)
│
└── mobile/                       ← ВЕБ‑ИНТЕРФЕЙС (то, что видит пользователь)
    ├── www/                      ← ИСТОЧНИК ИСТИНЫ UI; ровно эти файлы уходят в APK и в OTA
    │   ├── index.html              ← каркас: SVG‑спрайт иконок, вкладки, нижняя навигация, экран чата
    │   ├── app.js                  ← ВСЯ логика UI (~4500 строк)
    │   ├── styles.css              ← дизайн‑система, темы, все компоненты (~2800 строк)
    │   └── version.json            ← копия корневого version.json (должна совпадать байт‑в‑байт)
    ├── dev/
    │   ├── serve.js                ← dev‑сервер http://localhost:5173 (UI в браузере ПК)
    │   └── mock-bridge.js          ← имитация AndroidServer (в памяти) по контракту LocalBackendServer
    └── tests/                    ← node --test (без зависимостей)
        ├── harness.js              ← грузит app.js в vm с заглушками, отдаёт window.__appInternals
        ├── markdown.test.js        ← экранирование/Markdown (безопасность innerHTML)
        ├── ui-helpers.test.js      ← даты, склонения, инициалы, провайдеры, effort, сортировка, аватары
        ├── claude.test.js          ← определение моделей Claude Code CLI
        ├── claude-diag.test.js     ← скрипты claude-diag парсятся и работают под Node
        ├── system-prompt.test.js   ← зеркало buildSystemPrompt() + шаблон старой памяти
        ├── gemini-request.test.js  ← зеркало сборки истории для Gemini + текст deliveryNote
        ├── updates.test.js         ← compareSemver, решение «OTA/APK/нет», формат подписи OTA
        ├── cloud-format.test.js    ← зеркало CloudCrypto на Node crypto (те же векторы, что в JVM‑тесте)
        ├── cloud-schema.test.js    ← cloud-schema.sql на встроенном SQLite Node: триггеры очереди
        └── cloud-ui.test.js        ← индикатор пароля, строка статуса облака
│
└── firebase/                     ← облако: настройка проекта пользователя
    ├── README.md                 ← пошаговая настройка Firebase (её открывает кнопка «Открыть инструкцию»)
    └── firestore.rules           ← правила Firestore (шаблон: OWNER_EMAIL → Gmail пользователя)
```

Чего в репозитории **нет** (и не должно быть в git): `android/agy-release.keystore` (ключ подписи APK), `android/ota-release-private.pem` / `.der` (ключ подписи OTA), `android/build/`, `android/assets/www/`.

---

## 4. Архитектура и поток данных

```
┌────────────────────────── WebView (https://appassets.agy.local/index.html) ──────────────────────────┐
│ index.html + styles.css + app.js                                                                       │
│   api('/api/chats', {method, body})                                                                    │
│     └─► window.AndroidServer.requestAsync(reqId, method, endpoint, bodyJsonString)  ──────────┐        │
│   window.__onAndroidServerResponse(reqId, status, jsonText) ◄─────────────────────────────┐   │        │
└───────────────────────────────────────────────────────────────────────────────────────────│───│────────┘
                                                                                             │   ▼
┌──────────────────────────────── LocalBackendServer (Java, один на процесс) ────────────────│────────────┐
│ requestAsync → executor (пул потоков) → routeRequest(method, path, body) → обработчик       │            │
│   → JSONObject (+ "__status" для HTTP‑кода) → deliverResponse → evaluateJavascript ────────┘            │
│                                                                                                          │
│  SQLite agy_roleplay.db   workspace/*.md   ClaudeRuntime (процесс claude)   HTTPS: Vertex AI, OAuth,     │
│                                                                              GitHub (обновления)        │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Жизненный цикл запроса:**
1. `app.js → api(endpoint, {method, body})` создаёт `reqId`, кладёт Promise в `pendingAndroidRequests`, вызывает `AndroidServer.requestAsync`.
2. `LocalBackendServer.requestAsync` (`@JavascriptInterface`) отдаёт работу в `executor`, там `routeRequest` разбирает путь/квери/тело и вызывает обработчик.
3. Ответ — `JSONObject`. Если в нём есть `__status`, это HTTP‑код (ошибки создаются `errorJson(status, msg)`), ключ удаляется.
4. `deliverResponse` вызывает в WebView `window.__onAndroidServerResponse(reqId, status, "<JSON‑текст>")` (с 1.7.0 — JSON как строковый литерал; движки до 1.7.0 слали base64 — `app.js` понимает оба формата).
5. `app.js` резолвит/реджектит Promise; при ошибке `err.status`, `err.data` (тело), `err.message` (= `data.error`).

**Генерация ответа (долгий запрос):** `POST /api/chats/:id/messages` висит, пока модель не ответит. Параллельно UI каждые 450 мс опрашивает `GET /api/chats/:id/generation` (объект `GenerationProgress`: фаза, текст/мысли «на лету», журнал) и рисует «живое» сообщение. «Стоп» — `POST /api/chats/:id/generation/cancel`.

**Обратные вызовы из натива в JS** (контракт, не переименовывать):

| JS‑функция | Кто вызывает | Зачем |
|---|---|---|
| `window.__onAndroidServerResponse(reqId, status, payload)` | `LocalBackendServer.deliverResponse` | ответ на любой `requestAsync` |
| `window.__onAgyOAuthSuccess()` | `LocalBackendServer.notifyWebViewOAuthSuccess` | вход Google завершён через localhost‑колбэк |
| `window.__onCloudAuthDone(ok)` | `LocalBackendServer.cloudNotifyAuth` (из `CloudSync.onBrowserSignIn`) | вход в облако через браузер завершён (успешно или нет) |
| `window.__onCloudSyncChanged(info)` | `LocalBackendServer.cloudNotifyChanged` (после pull) | данные изменились с другого устройства: `{cards, chats, settings, prompt, chatIds[], deletedChatIds[]}` → UI перезагружает списки и открытый чат |
| `window.__onNativeFileSaved(ok)` | `MainActivity.onActivityResult` (SAF) | файл экспорта/копии сохранён |
| `window.onAndroidKeyboardVisibilityChanged(open)` | `MainActivity` (WindowInsets) | клавиатура открыта/закрыта → класс `kb-open` |
| `window.appUI.handleBack()` → `'exit'`/`'handled'` | `MainActivity.onBackPressed` | системная кнопка «Назад» |

**Методы моста, доступные JS** (`@JavascriptInterface` в `LocalBackendServer`): `requestAsync`, `reloadWebView`, `openExternalUrl(url)`, `shareExportText(name, text)`, `saveExportFile(name, text, mime)` (→ `MainActivity.startSaveDocument`, системный диалог «Сохранить»), `setSystemBars(bgHex, navHex, lightBars)` (→ `MainActivity.applySystemBars`).

---

## 5. Нативная часть (android/)

### 5.1 `AndroidManifest.xml`
- `package="com.agy.roleplay"`, `versionCode` = **build** (25), `versionName` = версия (1.7.0) — меняются при каждом релизе вместе с `version.json`/`package.json`.
- `minSdk 26`, **`targetSdk 28`** (обязательно, см. §2; комментарий в манифесте).
- Разрешения: `INTERNET`, `ACCESS_NETWORK_STATE` (DNS‑серверы сети для Claude Code).
- `application`: `allowBackup="false"`, `networkSecurityConfig`, тема `@style/AppTheme`, иконка `@drawable/ic_launcher` (адаптивная).
- `MainActivity`: `exported`, **`launchMode="singleTask"`** (никогда не два окна), `configChanges` (поворот, тема, размер — без пересоздания), `windowSoftInputMode="adjustResize"`. Второй intent‑filter: `agyroleplay://cloud-signin` (VIEW, BROWSABLE) — кнопка «Вернуться в приложение» на странице входа в облако; только выводит приложение на экран, данных не несёт.

### 5.2 `MainActivity.java` — окно и WebView
- `onCreate`: цвета системных панелей; `FrameLayout` + `WebView`; отладка WebView (`setWebContentsDebuggingEnabled`) **только** в debuggable‑сборке.
  - Слушатель `WindowInsets` (API 30+): отступы под системные панели и клавиатуру, вызов `onAndroidKeyboardVisibilityChanged`.
  - Усиление WebView: JS вкл., DOM storage вкл., доступ к файлам/контенту **выкл.**, `LOAD_NO_CACHE`, `textZoom 100`, смешанный контент запрещён.
  - `WebViewClient.shouldOverrideUrlLoading`: всё, кроме `appassets.agy.local`, открывается во внешнем браузере; `.apk` — тоже в браузере.
  - `WebViewClient.shouldInterceptRequest`: запросы к `appassets.agy.local` отдаёт `LocalBackendServer.serveVirtualAsset` с заголовками `Cache-Control: no-store`, **CSP** (только `self`), `nosniff`.
  - `WebChromeClient.onShowFileChooser`: выбор картинки (аватар) или `.json` (восстановление копии).
  - `LocalBackendServer.attach(this, webView)` (синглтон процесса) → `addJavascriptInterface(backend, "AndroidServer")` → `loadUrl(getStartPageUrl())`.
- `applySystemBars(bg, nav, light)` — цвет статус‑/навигационной панели под тему UI.
- `startSaveDocument(name, content, mime)` + `onActivityResult` — сохранение файла через SAF; результат → `__onNativeFileSaved`.
- `onBackPressed` — спрашивает `appUI.handleBack()`; если `'exit'` → **`moveTaskToBack(true)`** (свернуть, а не закрыть).
- `onResume`/`onPause` → `backend.onAppForeground(true/false)` → `CloudSync.setForeground`: Android 15+ отключает сеть приложению в фоне (`blocked=APP_BACKGROUND` в `dumpsys netpolicy`), поэтому облако работает только на переднем плане.
- `onDestroy` — `backend.detach(this)`, `webView.destroy()`.

Зависимости: `LocalBackendServer` (attach/detach, `VIRTUAL_HOST`, `serveVirtualAsset`, `virtualMimeType`), `app.js` (контракт колбэков выше).

### 5.3 `LocalBackendServer.java` — бэкенд (~5000 строк)

Разделы файла (по комментариям‑заголовкам) и ключевые методы:

| Раздел / группа | Методы и что делают |
|---|---|
| Константы | OAuth‑клиенты AGY (`AGY_CLIENT_ID/SECRET`, `AGY_GCP_CLIENT_ID/SECRET` — публичные значения установленного приложения), `OTA_TRUSTED_REPO = "Kuka001/111"`, `OTA_PUBLIC_KEY_B64` (ключ проверки OTA), `AGY_OAUTH_PORT = 51121`, `AGY_REDIRECT_URI`, `AGY_SCOPES`, `AGY_VERTEX_ENDPOINT`, `AGY_USER_AGENT`… |
| `GenerationProgress` (внутренний класс) | состояние одной генерации: `status`, `phase`, `statusText`, `thoughts`, `text`, модель, `endpoint`, `httpStatus`, счётчики, `finishReason`, `error`, `cancelled`, `logs`; `cancel()` рвёт HTTP‑соединение и убивает процесс CLI; `toJson()` — то, что видит UI |
| Синглтон | `attach(activity, webView)`, `detach(activity)`, приватный конструктор → `initWorkspaceAndDatabase()` и фоновые `ClaudeRuntime.cleanupLegacy()` + `tidyChatFiles()` |
| Виртуальный хост | `VIRTUAL_HOST = "appassets.agy.local"`, `getStartPageUrl()`, `serveVirtualAsset(path)` (сначала `files/ota_www/`, если OTA активен, иначе `assets/www/` из APK), `isOtaBundleActive()`, `virtualMimeType()` |
| Мост | `requestAsync` → `routeRequest` → `deliverResponse`; `reloadWebView`, `openExternalUrl`, `shareExportText`, `saveExportFile`, `setSystemBars` |
| INITIALIZATION | `initWorkspaceAndDatabase()`: папки `characters/personas/memories`, таблицы, `addColumnIfMissing`, индекс `idx_messages_chat`, настройки по умолчанию (`setDefaultSetting`), удаление устаревших ключей, `migratePlaintextSecrets`, создание `GEMINI.md`, правило «OTA только для своего build», нормализация модели и `safety_threshold`, `clearPlaceholderAvatars`, `syncWorkspaceFilesWithDb` |
| SECRET SETTINGS AT REST | `getOrCreateSecretKey` (Keystore AES‑256‑GCM), `encryptSecret`/`decryptSecret` (префикс `enc:v1:`), `getSetting`/`setSetting` (+ кэш расшифрованных секретов `secretCache`). **Строгие** секреты облака (`STRICT_SECRET_KEYS`: ключ данных, refresh‑токен, ожидающий вход) без Keystore не пишутся на диск вовсе (`encryptSecretStrict`, флаг `keystoreUnavailable`) |
| Карточки ↔ файлы | `syncWorkspaceFilesWithDb` (строки без файла удаляются, файлы без строки добавляются; только при старте и после восстановления копии), `pruneMissingCardRows`, `cardFiles`, `parseHeaderName`, `parseFirstMessage`, `parsePreview` |
| Модели | `VERTEX_MODELS`, `CLAUDE_CLI_MODELS` (таблицы), `getCleanBaseModelsJson`, `findCliModel`, `normalizeBaseModelId`, `normalizeEffort`, `normalizeSafetyThreshold`, `getEngineBuild` |
| ROUTER | `routeRequest(...)` — все `/api/*` (таблица в §6); помощники `okJson`, `isEditableWorkspaceFile` (писать можно только `GEMINI.md` и `memories/*.md`), `deleteCard`, `firstId`, `chatExists`, `cliPromptFile`, `deleteChat` |
| FULL BACKUP & RESTORE | `dumpTable`, `collectWorkspaceFiles`, `handleBackupExport` (без секретов и без `cloud_*`), `handleBackupImport` (транзакция; только известные колонки — `tableColumns`; настройки по белому списку `RESTORABLE_SETTINGS`; папки карточек/памяти заменяются целиком; затем sync и `tidyChatFiles`). При включённом облаке: сначала `cloudSync.pullBeforeRestore()`, после — `cloudQueueRestoredFiles()`; триггеры ставят в очередь удалённые и восстановленные строки, так что облако заменяется копией |
| CLOUD SYNC: LOCAL RECORDS | `initCloudSchema` (выполняет `assets/cloud-schema.sql`; при ошибке облако выключено — `cloudSchemaReady`), `cloudSetTracking`/`cloudIsTracking`, `cloudQueueFile` (GEMINI.md и память — их триггеры не видят), `cloudQueueAll`, `cloudExportRecord(kind, sid)` (запись → JSON без конверта), `cloudApplying(work)` (chatWriteLock → транзакция → `applying=1`), `cloudApplyRecord` + `applyCloudCard/Chat/Memory/Message/Settings` (всё из облака проверяется: sid, даты, модели, аватары, имена файлов строятся локально), `cloudResolvePersona`, `cloudWipeLocalData`, `cloudNotifyChanged`/`cloudNotifyAuth`, класс `CloudApplied` |
| CLOUD ROUTES | `handleCloud(method, action, body)` — все `/api/cloud/*` (§6); `CloudStore.CloudException` → HTTP‑код (`cloudErrorStatus`) |
| DATABASE HELPERS | `queryCharactersArray`, `getCharacterByIdJson`, `saveOrUpdateCharacter` (+ `cardFileName`, `cleanAvatarUrl`, `uniqueCardPath`, `lookupFilePath`), то же для персон, `queryChatsListArray` (без аватаров; превью 300 символов), `createNewChat`, `getChatDetailsJson` (**без** `avatar_url` у персонажа/персоны), `getChatMessagesArray`, `getMessageByIdJson`, `cursorToMessageJson` |
| SEND MESSAGE & SWIPE | `startGeneration` (409, если в чате уже идёт генерация), `handleSendChatMessage` (сообщение пользователя → `generateRoleplayReply` → под `chatWriteLock` проверка, что чат жив, → ответ; при ошибке сообщение пользователя удаляется), `generationFailure` (409 отмена / 401 вход — `AuthRequiredException` / 502 прочее), `touchChat`, `alignedThoughtSwipes`, `handleSwipeOrRegenerate` (select / regenerate) |
| GOOGLE (AGY) OAUTH | `isAgyAuthenticated`, `handleAgyAuthStatus/Logout/Start/Exchange`, `startLocalOAuthCallbackServer` (ServerSocket 127.0.0.1:51121, проверка `state`, закрытие через 10 мин), `exchangeAuthorizationCodeForTokens` (PKCE, два клиента по очереди), `getValidAgyAccessToken` (обновление по refresh‑токену), `discoverAgyProjectAndEmail` |
| CLAUDE CODE CLI: среда/вход/проверка | `handleClaudeStatus`, `handleClaudeRuntimeInstall` (→ `ClaudeRuntime.ensureReady`), `handleClaudeAuthStart` (`claude --debug-to-stderr auth login --claudeai`, `BROWSER`=шим, сторож 75 с без ссылки), `startLoginReader`, `refreshGuestDns`, `handleClaudeAuthExchange` (код `xxx#yyy` в stdin), `handleClaudeAuthLogout`, `stopPendingClaudeAuth`, `handleClaudeSelfTest` → `runClaudeSelfTest` (версия → `runProbe` → `runFullStart`; запасные: безопасный режим Bun, чистый профиль), `runStage`/`StageOutput`/`appendStage`/`describeExit`, `liveSandboxRuns`, `handleDevExec` (**только** debuggable) , `sandboxSnapshot` |
| CLAUDE CODE CLI PROVIDER | `resolveClaudeCliModel`, `resolveClaudeCliEffort`, `buildClaudeTranscript` (вся история одним текстом + строка «=== Задание ===»), `callClaudeCodeCli` (аргументы и разбор `stream-json`, см. §8), `joinBlocks` |
| Промпт | `buildSystemPrompt` (§8.1), `applyMacros` (`{{char}}`, `{{user}}`), `readChatMemory`, `tidyChatFiles` (шаблоны старой памяти, файлы удалённых чатов) |
| Gemini / Vertex | `generateRoleplayReply` (маршрутизация по модели + сборка `contents`), `callAntigravityGateway` (Claude на Vertex `rawPredict` или Gemini SSE), `resolveExactVertexModelId`, `resolveThinkingLevel`, `resolveThinkingBudget`, `vertexError` (понятные подсказки для 403/429), `extractReadableApiError`, `buildSafetySettingsArray`, `summarizeSafetyRatings`, `readHttpBody` |
| FILE UTILITIES | `sanitizeRelPath`, `parseQueryParams`, `readTextFile`, `writeTextFile`, `deleteRecursive` |
| GIT AUTO-UPDATE | `readBundledVersionManifest` (кэш), `readLocalVersionManifest`, `httpGetString`, `compareSemver`, `handleUpdatesCheck`, `sha256Hex`, `buildOtaManifestPayload`, `verifyOtaSignature`, `handleUpdatesApply`, `handleUpdatesReset`, `handleUpdatesConfig`; `errorJson` |

Зависимости: `ClaudeRuntime`, `ProcSnapshot`, `CloudSync` (создаётся после init, если `cloudSchemaReady`), `MainActivity` (applySystemBars/startSaveDocument), Android SDK (SQLite, Keystore, ConnectivityManager), `org.json`. После каждого не‑GET запроса `requestAsync` зовёт `cloudSync.onLocalChange()` (выгрузка через 3 с, если очередь не пуста).

### 5.4 `ClaudeRuntime.java` — среда Claude Code
- Описывает **только окружение**; потоковая логика (генерация/вход) — в `LocalBackendServer`.
- `PARTS` — закреплённые (URL + SHA‑256) компоненты: Alpine minirootfs 3.24.3, `libgcc`, `libstdc++` (Alpine CDN) и `@anthropic-ai/claude-code-linux-arm64-musl` 2.1.310 (npm). Ничего не перезаливается на GitHub (Claude Code — проприетарный).
- `RUNTIME_VERSION = "claude-2.1.310+alpine-3.24.3"` (маркер `.ready`; принимается и маркер 1.6.x `…+proot-5.4.0-r2`). **Сменили часть → смените версию** (это заставит перекачать).
- Расположение на телефоне `files/claude_runtime/`: `rootfs/`, `claude` (~283 МБ), `ld-musl-agy.so.1`, `home/` (HOME и рабочая папка: `.claude/.credentials.json`, `.agy/system_prompt_chat_N.md`, `.agy-resolv.conf`), `tmp/`, `bin/agy-open` (шим браузера), `.compat` (`safe` = безопасный режим Bun).
- Ключевые методы: `isReady`, `ensureReady(sink, force)` (скачать → проверить SHA → распаковать tar.gz → chmod), `cleanupLegacy` (остатки proot), `isAuthenticated` (токен в `.credentials.json`), `credentialsStamp`, `logout`, `ensureBrowserShim`, `browserShimPath`, `browserUrlFile`, `writeHomeFile`/`deleteHomeFile`/`homeFiles`, `setDnsServers`/`resolvConf`, **`ensureDirectLoader`** (копия musl‑загрузчика с заменой `/etc/resolv.conf` на `.agy-resolv.conf`, проверка SHA), `BUN_SAFE_FLAGS`, `RunOptions`, `defaultOptions`, `isSafeMode`/`setSafeMode`, `freshHome`/`resetHome`, **`newClaudeProcess(args, opts)`** (команда `ld-musl-agy.so.1 claude args`, env: `HOME`, `TMPDIR`, `LD_LIBRARY_PATH`, `AGY_DNS_SERVERS`, `BUN_OPTIONS=--preload …android.cjs`, `DISABLE_AUTOUPDATER=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`), `probeEnv`, `newHostProcess` (dev exec), `kill`/`killStray`/`pidOf` (SIGKILL всему дереву через `ProcSnapshot`), загрузчик с SHA и мини‑распаковщик tar.

### 5.5 `ProcSnapshot.java`
- `descendants(pid)`, `childrenRunningFrom(pid, dir)` — для убийства зависших процессов (`ClaudeRuntime.kill/killStray`).
- `ofDescendants(rootPid, hide)` — текстовый снимок потоков, системных вызовов, fd и сокетов (в отчёт о зависании при входе и в «Проверить запуск»).

### 5.6 `assets/claude-diag/*`
Копируются `ClaudeRuntime.installScripts()` в `rootfs/opt/agy/` и подгружаются Bun через `BUN_OPTIONS=--preload`:
- `android.cjs` — **на каждом запуске** Claude Code: `dns.setServers(AGY_DNS_SERVERS)`, `os.networkInterfaces()` не падает.
- `probe.mjs` — этап «проверка рантайма Bun» в самопроверке (таймеры, файлы, процессы, DNS, HTTPS); печатает `[probe …]` и `done · всё в порядке`.
- `trace.cjs` — этап «полный запуск»: heartbeat и лог `child_process`/`Bun.spawn`.
Проверяются тестом `mobile/tests/claude-diag.test.js`.

### 5.7 `res/`
- `drawable/ic_launcher.xml` — адаптивная иконка (фон `@color/ic_launcher_background` + `ic_launcher_foreground.xml`, шестиугольник AGY).
- `values/styles.xml` — `AppTheme` (тёмный фон окна/экрана запуска `#0F1115`, панели), `values/colors.xml`, `values/strings.xml` (`app_name` = «AGY Roleplay»).
- `xml/network_security_config.xml` — открытый HTTP только для `127.0.0.1`/`localhost` (колбэк OAuth), доверие только системным CA.

### 5.8 Скрипты сборки
**`android/build-apk.ps1 [-Debuggable]`**
1. Обеспечивает инструменты в кэше `C:\Users\Kazuma\.gemini\antigravity-cli\brain\5fcbe0c0-e9e8-4f16-9fa1-c4f2a1a5c107\scratch\android-sdk` (JDK 17, build‑tools 35, platform 35; там же `platform-tools\adb.exe`).
2. Запускает веб‑тесты `node --test` и JVM‑тест `android/tests/CloudCryptoTest.java` (javac/java из JDK 17; обход обоих: `$env:AGY_SKIP_TESTS="1"`).
3. Копирует корневой `version.json` → `mobile/www/version.json`, затем `mobile/www/*` → `android/assets/www/`.
4. `aapt2 compile/link` (для `-Debuggable` добавляет `android:debuggable="true"`), `javac -source 8 -target 8` семи Java‑файлов (`$JavaSources`) + `R.java`, `d8` → `classes.dex`, `jar -uf` добавляет dex и `assets/` (вместе с `cloud-schema.sql`).
5. `zipalign` + `apksigner` (keystore `android/agy-release.keystore`, alias `agyroleplay`; пароль в скрипте; файл ключа — только на ПК пользователя!).
6. Release: пишет `agy-roleplay-android16.apk` в корень и записывает `apkSha256`/`apkSize` в `version.json` (+ копия в `mobile/www`). Debug: `%TEMP%\agy-roleplay-debug.apk`, `version.json` не трогает.

**`android/sign-ota.ps1 [-Init]`**
- `-Init` — однократно создаёт ключевую пару OTA (`android/ota-release-private.pem` / `.der`), печатает публичный ключ для `OTA_PUBLIC_KEY_B64`.
- Обычный запуск — считает SHA‑256 файлов `mobile/www/{index.html, app.js, styles.css}`, формирует payload (см. §9) и пишет `otaSignature` в **оба** `version.json`.

---

## 6. API моста (`/api/*`)

Обработчики — в `LocalBackendServer.routeRequest`; имитация — в `mobile/dev/mock-bridge.js → route()`.

| Метод и путь | Обработчик (Java) | Что делает | Кто вызывает в app.js |
|---|---|---|---|
| GET `/api/health` | inline | ok, `engineBuild`, `appVersion` | (отладка) |
| GET `/api/settings` | inline | модель/effort по умолчанию, активная персона, `safetyThreshold`, флаги входа Google/Claude, `engineBuild`, `appVersion` | `loadAll`, `refreshSettings` |
| POST `/api/settings` | inline | `projectId`, `selectedModel`, `selectedEffort`, `activePersonaId`, `safetyThreshold` | `openDefaultModelPicker`, `openVertexPage` |
| GET `/api/models` | `getCleanBaseModelsJson` | список моделей с `efforts[]`, `legacy` | `loadAll` |
| GET `/api/files/content?path=` | inline | текст файла workspace | системный промпт, память чата |
| POST `/api/files/file` | inline | записать `GEMINI.md` или `memories/*.md` (другое — 400) | `openSystemPromptPage`, `openMemoryEditor` |
| GET/POST `/api/characters` | `queryCharactersArray` / `saveOrUpdateCharacter` | список (с `fileContent`, `avatar_url`) / создать | `loadAll`, `loadCards`, `openCardEditor` |
| PUT/DELETE `/api/characters/:id` | `saveOrUpdateCharacter` / `deleteCard` | изменить / удалить (чаты остаются) | `openCardEditor` |
| GET/POST `/api/personas` | `queryPersonasArray` / `saveOrUpdatePersona` | + `activePersonaId` | то же |
| PUT/DELETE `/api/personas/:id` | … / `deleteCard` | при удалении активной — активной становится первая | `openCardEditor` |
| POST `/api/personas/:id/activate` | inline | персона по умолчанию | `activatePersona` |
| GET/POST `/api/chats` | `queryChatsListArray` / `createNewChat` | список (без аватаров) / новый чат (+ файл памяти, приветствие) | `loadChats`, `openNewChat` |
| GET/PATCH/DELETE `/api/chats/:id` | `getChatDetailsJson` / inline / `deleteChat` | детали (без аватаров) / модель, effort, персона, название / удаление (+ отмена генерации, файлы) | `openChatRoom`, `patchChat`, `deleteChat` |
| POST `/api/chats/:id/messages` | `handleSendChatMessage` | отправить; ответ `{userMessage, assistantMessage, generation}` | `sendMessage` |
| DELETE `/api/chats/:id/messages?after=ID` | inline | откат: удалить все сообщения после ID | `rewindTo` |
| GET `/api/chats/:id/generation` | inline | `{active, generation, lastGeneration}` | `pollWatched`, `attachToRunningGeneration`, диагностика |
| POST `/api/chats/:id/generation/cancel` | `GenerationProgress.cancel` | «Стоп» | `stopGeneration` |
| GET `/api/chats/:id/system-prompt` | `buildSystemPrompt` | итоговый системный промпт | `openPromptPreview`, `openExport` |
| PUT/DELETE `/api/messages/:id` | inline | правка текущего варианта / удаление | `openEditMessage`, `deleteMessage` |
| POST `/api/messages/:id/swipe` | `handleSwipeOrRegenerate` | `{action:'select', index}` или `{action:'regenerate'}` | `selectSwipe`, `regenerate` |
| GET `/api/updates/check` | `handleUpdatesCheck` | версии, `nativeUpdateRequired`, `otaAvailable`, релизы, коммиты | `checkForUpdates` |
| POST `/api/updates/apply`, `/reset`, `/config` | `handleUpdatesApply/Reset/Config` | установить OTA / вернуть UI из APK / ветка | страница «Обновления» |
| GET `/api/backup/export`, POST `/api/backup/import` | `handleBackupExport/Import` | полная копия / восстановление | `openBackupPage` |
| `/api/agy/auth/status`, `start`, `exchange`, `logout` | `handleAgyAuth*` | вход Google для Vertex | `openVertexPage`, `refreshAgyStatus` |
| GET `/api/claude/status` | `handleClaudeStatus` | среда, вход, прогресс установки/входа/проверки, ссылки входа | `refreshClaudeStatus` |
| POST `/api/claude/runtime/install` | `handleClaudeRuntimeInstall` | скачать/переустановить среду (`force`) | `openClaudePage` |
| POST `/api/claude/auth/start`, `exchange`, `cancel`, `logout` | `handleClaudeAuth*` | вход по подписке Claude | `openClaudePage` |
| POST `/api/claude/selftest` | `handleClaudeSelfTest` | «Проверить запуск» | `openClaudePage` |
| POST `/api/dev/exec` | `handleDevExec` | **только debuggable**: команда в песочнице приложения | (отладка с ПК) |
| GET `/api/cloud/status` | `CloudSync.status` | флаги без секретов: `configured, projectId, signedIn, email, loginPending, loginCaptured, loginError, vault (unknown/none/locked/ready), linked, busy, phase, done, total, pending, parked, skipped, lastSyncAt, lastError, errorKind, quotaUntil, usage, cloudRecords, cloudBytes, minPasswordChars, hasLocalData, certSha1, keystoreUnavailable` | `refreshCloudStatus` |
| POST `/api/cloud/config` | `CloudSync.configure` / `clearConfig` | `{config: текст}` (JSON или фрагменты из консоли) / `{clear: true}`; только когда не выполнен вход | `openCloudPage` |
| POST `/api/cloud/auth/start`, `auth/exchange` | `CloudSync.beginSignIn` (+ браузер) / `exchangeManually` | вход Google; ответ `authUrl`; ручная вставка адреса `http://127.0.0.1:…/cloud-callback?…` | `openCloudPage` |
| POST `/api/cloud/vault/create` | `CloudSync.createVault` | `{password}` → новый ключ, хранилище, выгрузка всего; ответ `recoveryCode` (единственный раз) | `openCloudPage` → `showRecoveryCode` |
| POST `/api/cloud/vault/unlock` | `CloudSync.unlock` | `{password}` или `{recoveryCode}`, `mode: merge/replace` (если на телефоне есть данные и он не был привязан) | `openCloudPage` |
| POST `/api/cloud/vault/password`, `vault/recovery` | `changePassword` / `newRecoveryCode` | смена пароля (по паролю или коду) / новый код (по паролю) | `openCloudPasswordSheet`, `openCloudRecoverySheet` |
| POST `/api/cloud/sync` | `syncNow` / `onResume` | вручную; `{reason:'resume'}` — при возврате в приложение (не чаще раза в минуту) | `openCloudPage`, `visibilitychange` |
| POST `/api/cloud/signout` | `CloudSync.signOut` | `{wipeLocal}`: отвязать телефон (и стереть данные с него) | `openCloudSignOutSheet` |
| POST `/api/cloud/wipe` | `CloudSync.wipeCloud` | `{confirm: 'УДАЛИТЬ', deleteAccount}`: удалить облачную копию (и пользователя Firebase), затем выход | `openCloudWipeSheet` |

Коды ответов: 200; 400 (ввод); 404; **409** — конфликт (идёт генерация / отменено — в теле `cancelled: true`); 401 — нужен вход; 502 — ошибка модели/сети; 403/503 — OTA отклонён/выключен. Облако: 401 — войти заново, 403 — неверный пароль/код или отказ правил Firestore, 409 — нужен выбор/другое состояние, 429 — лимит (или много неверных паролей), 503 — нет сети.

---

## 7. Хранение данных на телефоне

Пути внутри `/data/user/0/com.agy.roleplay/`:
- `databases/agy_roleplay.db` — SQLite.
- `files/workspace/` — `GEMINI.md` (системный промпт), `characters/*.md`, `personas/*.md`, `memories/chat_<id>.md`, `exports/` (наследие старых версий, просто хранится).
- `files/claude_runtime/` — среда Claude Code (§5.4).
- `files/ota_www/` — установленный OTA‑бандл (если активен).
- WebView localStorage `agy_ui_prefs_v1` — настройки оформления (тема, акцент, шрифт…). В облако не попадают.
- Облако: Firestore проекта пользователя, `users/{uid}/…` (§17).

### 7.1 Таблицы
| Таблица | Колонки |
|---|---|
| `settings` | `key` PK, `value` |
| `characters` | `id`, `name`, `file_path` UNIQUE, `avatar_url` (data:image/… или ''), `first_message` (приветствие), `description_preview`, `created_at`, `updated_at` |
| `personas` | `id`, `name`, `file_path` UNIQUE, `avatar_url`, `description_preview`, `is_default`, `created_at` |
| `chats` | `id`, `title` (по умолчанию «Чат: Имя»), `character_id`, `persona_id`, `model_id`, `effort`, `memory_file_path`, `provider`, `created_at`, `updated_at`; **не используются** (наследие): `system_prompt_path`, `first_message_path`, `project_path` |
| `messages` | `id`, `chat_id`, `role` (`user`/`assistant`), `content` (текущий вариант), `thoughts`, `swipes_json` (все варианты), `swipe_index`, `thought_swipes_json` (мысли по вариантам), `created_at`, `sort_key`; индексы `idx_messages_chat(chat_id, id)`, `idx_messages_chat_sort(chat_id, sort_key, id)` |
| облако: колонки | у `characters`, `personas`, `chats`, `messages` — `sync_id` (случайные 128 бит hex, одинаковые на всех устройствах, уникальный индекс); `chats.character_sid`/`persona_sid` — ссылка на карточку, пришедшую из облака позже чата; `messages.sort_key` — порядок (старые строки = `id`, новые — мс, всегда больше остальных в чате). **Порядок сообщений — `ORDER BY sort_key, id`**, не по `id` |
| `cloud_ctl` | одна строка: `tracking` (облако привязано — триггеры пишут очередь), `applying` (идёт применение из облака — триггеры молчат) |
| `cloud_outbox` | очередь выгрузки: `kind`, `sid`, `parent` (sid чата для сообщений/памяти), `queued_at` (мс изменения = версия записи) |
| `cloud_records` | что, по сведениям телефона, лежит в облаке: `doc_id`, `kind`, `sid`, `mt`, `deleted`, `parts`, `bytes` |
| `cloud_parked` | пришедшие из облака сообщения/память, чей чат ещё не пришёл (живут 30 дней) |

Время в БД — `CURRENT_TIMESTAMP` SQLite (UTC, строка `YYYY-MM-DD HH:MM:SS`; UI парсит `parseServerTime`).

### 7.2 Ключи настроек (`settings`)
`project_id` (Vertex Project ID, по умолчанию `project-4c7a8e8a-764a-42bc-bdf`), `selected_model`, `selected_effort`, `active_persona_id`, `safety_threshold` (`OFF`/`BLOCK_NONE`/`BLOCK_ONLY_HIGH`), `agy_access_token`*, `agy_refresh_token`*, `google_auth_token`* (старый ручной токен), `agy_token_expiry`, `agy_user_email`, `agy_discovered_project`, `git_branch`, `installed_version`, `installed_build`, `installed_commit`, `ota_active`. (* — шифруются; никогда не уходят в JS и в резервную копию.)

Облако: `cloud_config` (`projectId`, `apiKey`, `clientId`), `cloud_client_secret`*, `cloud_refresh_token`**, `cloud_dek`** (ключ данных, hex), `cloud_oauth_pending`** (state/verifier/порт входа, 10 мин), `cloud_uid`, `cloud_email`, `cloud_kid` (идентификатор хранилища), `cloud_watermark` (время последней принятой записи облака), `cloud_read_time` (время последнего полного чтения облака), `cloud_last_sync`, `cloud_usage` (расход квоты за тихоокеанские сутки), `cloud_quota_until`, `cloud_pending_persona`. (** — строгие секреты.) Все `cloud_*` не попадают в резервную копию. Синхронизируются (запись `settings`): `selected_model`, `selected_effort`, `safety_threshold`, `project_id`, `active_persona_id` — список совпадает в триггерах `cloud-schema.sql` и в `cloudExportRecord`/`applyCloudSettings`.

### 7.3 Карточки
- Файл карточки = **ровно** описание (редактор отправляет `rawFileContent`), он целиком идёт модели в тег.
- Приветствие — в БД (`first_message`), макросы `{{char}}`/`{{user}}` подставляются при создании чата.
- Портрет — `data:image/...` (UI уменьшает до 640 px, `downscaleImage`); без картинки `avatar_url = ''`, UI рисует инициалы (`initialsAvatar`).

---

## 8. Модели и генерация

### 8.1 Системный промпт (контракт, зеркало — `tests/system-prompt.test.js`)
`buildSystemPrompt(character, persona, memoryRelPath)`:
1. текст пользователя из `GEMINI.md` («Системный промпт» в UI); устаревшее содержимое `# GEMINI.md` = пусто;
2. `<character_persona>` — файл карточки персонажа;
3. `<user_persona>` — файл карточки персоны чата;
4. `<chat_memory>` — память чата без строки‑заголовка `# Память чата…` (только если не пусто).
Везде подставляются `{{char}}` и `{{user}}`. Ничего скрытого не добавляется.

### 8.2 Маршрутизация по `model_id`
- начинается с `claude-code-` → **Claude Code CLI** (`callClaudeCodeCli`);
- начинается с `claude-` → **Claude на Vertex** (`rawPredict`);
- иначе → **Gemini на Vertex**.
Та же логика в UI: `providerOf()` (`'cli'`, `'vertex-claude'`, `'gemini'`).

Списки моделей: `VERTEX_MODELS` (`{id, name, provider, badge, efforts}`) и `CLAUDE_CLI_MODELS` (`{id, --model значение, name, badge, efforts, legacy}`), повтор в `mock-bridge.js → MODELS`. Effort: `low, medium, high, xhigh, max` (у каждой модели свой набор; неподдерживаемый уровень понижается до ближайшего — `resolveClaudeCliEffort` / `effectiveEffort` в UI).

### 8.3 Gemini (`callAntigravityGateway`, ветка Gemini)
- `POST {AGY_VERTEX_ENDPOINT}/{v1beta1|v1}/projects/{proj}/locations/global/publishers/google/models/{model}:streamGenerateContent?alt=sse`, заголовки `Authorization: Bearer`, `x-goog-user-project`.
- Тело: `systemInstruction` (= системный промпт дословно), `contents` (вся история; подряд идущие реплики одной стороны склеиваются; если чат начинается с приветствия — перед ним служебная реплика пользователя `[Начало ролевой игры]`), `safetySettings` (один порог для всех категорий), `generationConfig` (`maxOutputTokens 32768`, `temperature 0.85`, `topP 0.95`, `thinkingConfig` — `thinkingLevel` для gemini‑3/4 или `thinkingBudget`, `includeThoughts`).
- Повторы (не меняют текст): v1beta1 → v1 при 400/404; при `MAX_TOKENS` из‑за мыслей — повтор с минимальным размышлением.
- Блокировка Google → понятная ошибка с причиной и категориями.

### 8.4 Claude на Vertex
`…/publishers/anthropic/models/{model}:rawPredict`, `anthropic_version: vertex-2023-10-16`, `max_tokens 8192`, `temperature 0.85`, `system`, `messages` (из тех же `contents`). Effort не используется.

### 8.5 Claude Code CLI (`callClaudeCodeCli`)
- Проверки: среда установлена, есть вход (иначе `AuthRequiredException` → HTTP 401 → кнопка «Настроить»).
- Системный промпт пишется в `HOME/.agy/system_prompt_chat_<id>.md`.
- Команда: `claude -p --output-format stream-json --verbose --include-partial-messages --model <alias|id> [--effort L] --tools "" --disable-slash-commands --permission-mode dontAsk --no-session-persistence --system-prompt-file <файл>`; env `CI=1`; в stdin — `buildClaudeTranscript` (история «Имя:\nреплика» + «=== Задание ===»).
- Разбор `stream-json`: `stream_event` (`text_delta`/`thinking_delta` → живой текст), `assistant` (блоки собираются по `message.id`), `result` (`is_error`).
- Сторож: нет **ни одной** строки вывода 90 с → процесс убивается, понятная ошибка.

### 8.6 Прогресс, отмена, ошибки
`GenerationProgress` в `activeGenerations` (одна на чат, `startGeneration` → иначе 409) и `lastGenerations` (для «Последняя генерация»). `cancel()` → флаг + разрыв HTTP + kill процесса. Удаление чата отменяет генерацию; запись ответа идёт под `chatWriteLock` после проверки `chatExists`.

---

## 9. Обновления и релиз

**Подпись OTA** (`buildOtaManifestPayload` = `$Payload` в `sign-ota.ps1` = зеркало в `tests/updates.test.js`):
```
agy-ota-v1
version=<version>
build=<build>
index.html=<sha256 hex>
app.js=<sha256 hex>
styles.css=<sha256 hex>
```
RSA‑SHA256, base64 → поле `otaSignature` в `version.json`. Публичный ключ — `OTA_PUBLIC_KEY_B64` в `LocalBackendServer`.

**Правило «один build»** (с 1.7.0): OTA‑бандл ставится только на APK того же build. `handleUpdatesCheck`: `nativeUpdateRequired = latestBuild > bundledBuild` (→ «Скачать APK»), `otaAvailable = latestBuild == bundledBuild && версия новее` (→ «Обновить»). `handleUpdatesApply` сначала читает `version.json`, отказывает при другом build, проверяет подпись, пишет в `files/ota_www.new` и подменяет `files/ota_www`. При старте OTA другого build удаляется.

**`version.json`:** `appName`, `version`, `build`, `releaseDate`, `gitRepo`, `gitBranch`, `apkPath`, `releases[]` (`version`, `build`, `date`, `title`, `ref`, `changelog[]`; хранить последние 10), `apkSha256`, `apkSize`, `otaSignature`. Две копии (корень и `mobile/www`) должны совпадать.

**Чек‑лист релиза:**
1. Поднять `versionCode`/`versionName` (`AndroidManifest.xml`), `version` (`package.json`), `version`/`build`/`releaseDate` + запись в `releases` (`version.json`, обе копии одинаковые).
   - Только веб‑изменения → версию повысить, **build оставить** (уйдёт по OTA).
   - Любые изменения Java/манифеста/ресурсов/assets → **build +1** (нужен APK).
2. `npm run check`.
3. `powershell -ExecutionPolicy Bypass -File android\build-apk.ps1` (релиз).
4. `powershell -ExecutionPolicy Bypass -File android\sign-ota.ps1` — **последним** (любая правка `mobile/www/*` после подписи её ломает).
5. Проверить подпись (node + публичный ключ) и хеш APK.
6. `git commit` («vX.Y.Z (Build N): …») и `git push origin main` (репозиторий `Kuka001/111`).
7. Поставить APK на телефон: `adb install -r agy-roleplay-android16.apk` (данные сохраняются — тот же ключ подписи).

---

## 10. Веб‑интерфейс (mobile/www)

### 10.1 `index.html`
SVG‑спрайт иконок (`<symbol id="i-имя">`, в JS — `ic('имя')`); `#tabsHost` с четырьмя `.tab-pane` (`#tab-chats`, `#tab-characters`, `#tab-personas`, `#tab-settings`); FAB `#newChatFab`; нижняя навигация `#bottomNav` (`data-action="tab"`); экран чата `#chatRoomView` (шапка `#chatHeaderAvatar/#chatHeaderName/#chatHeaderSub/#chatStatusDot`, лента `#chatScroll > #chatFeed`, кнопка `#jumpBtn`, композер `#chatInput` + `#sendBtn`); `#layers` (все страницы/листы/диалоги); `#toastHost`. Подключает `styles.css` и `app.js` (всё содержимое вкладок рисует JS).

### 10.2 `app.js` — разделы (в порядке файла)
| Раздел | Ключевые функции / объекты |
|---|---|
| NATIVE BRIDGE CONTRACT | `hasBridge`, `api()`, `__onAndroidServerResponse`, `decodeBase64Utf8` |
| PURE HELPERS (тестируются) | `escapeHtml`, `stripMarkdownPreview`, `formatRoleplayHtml`/`formatInlineMarkdown`/`highlightDialogue` (Markdown RP, всё экранируется до разметки), `parseServerTime`, `formatRelativeTime`, `formatMessageTime`, `pluralRu`, `formatCount`, `initialsOf`, `hueFromString`, `initialsAvatar`, `objectUrlFor` + `resolveAvatarUrl` (фото → кэшированный `blob:`), `isClaudeCliModel`, `providerOf`, `effortOptionsFor`, `effectiveEffort`, `sortChats`, `filterChats`, `isDefaultChatTitle`, `passwordStrength`, `formatBytes`, `agoText`, `cloudSummary` |
| STATE, PREFERENCES | объект `state` (настройки, модели, карточки, чаты, `room`, `generations`, `drafts`, `updateInfo`…), `prefs` (`agy_ui_prefs_v1`), `MIN_ENGINE_BUILD = 25`, `THEMES`, `ACCENTS`, `applyTheme` |
| DOM HELPERS | `$`, `$$`, `ic`, `htmlToElement`, `autoGrow`, `findChar`, `findPersona`, `modelName`, `PROVIDERS`, `modelSummary`, `providerStatus`, `copyText`, `openExternal`, `reloadApp`, `saveFile` |
| UI KIT: toasts | `toast(message, {type, action, duration})` |
| UI KIT: layers | `openLayer`, `closeLayer`, `requestCloseLayer`, `topLayer`, `refreshLayers`, `bindActs`, `openSheet`, `openPage`, `confirmDialog`, `actionSheet`, `openTextSheet`, `emptyHtml` |
| DATA LOADING | `applySettings`, `loadAll`, `warnOldEngine`, `loadChats`, `loadCards`, `refreshSettings`, `refreshClaudeStatus`, `refreshAgyStatus`, `refreshCloudStatus` (`state.cloud`); хуки `__onAgyOAuthSuccess`, `__onNativeFileSaved`, `__onCloudAuthDone`, `__onCloudSyncChanged` |
| TABS & ROUTING | `openTab`, `renderTab`, `renderAllTabs`, **`handleBack`** |
| CHATS TAB | `renderChatsTab`, `renderChatsList` (фильтр‑чипы по персонажам), `chatRowHtml`, свайп строки (экспорт/удалить), `deleteChat` |
| NEW CHAT | `openNewChat` (персонаж, персона, модель) |
| MODEL PICKER | `openModelPicker` (группы по провайдеру, «Предыдущие версии», effort) |
| CHAT ROOM | `withCardImages` (аватары из списков карточек), `openChatRoom`, `closeChatRoom`, `renderRoomHeader`, `messageHtml`, `liveHtml`, `errorHtml`, **`syncFeed`** (обновляет только изменившиеся сообщения по `data-key`/`data-sig`), `patchLive` |
| generation lifecycle | `startGeneration`, `ensurePolling`, `pollGenerations`/`pollWatched` (без наложения, пауза в фоне), `attachToRunningGeneration`, `endGeneration`, `generationError`, `sendMessage`, `regenerate`, `stopGeneration`, `retryGeneration`, `selectSwipe`, `swipeBy`, `insertAsterisks` |
| message actions | `openMessageActions`, `openEditMessage`, `deleteMessage`, `rewindTo` |
| chat settings | `patchChat`, `openChatSettings`, `deliveryNote` (что ещё получает модель), `openPromptPreview`, `openDiagnostics`/`renderDiagnostics` |
| EXPORT | `buildExport` (md/json), `openExport` (длинный текст → «Сохранить файлом», а не «Поделиться») |
| CHARACTERS TAB | `renderCharactersTab/List`, `openCharacterPage`, `downscaleImage`, **`openCardEditor`** (общий для персонажей и персон) |
| PERSONAS TAB | `renderPersonasTab`, `activatePersona` |
| SETTINGS TAB | `renderSettingsTab` (секция «Аккаунт» — строка облака из `cloudSummary`), `openSettingsPage(page)`: `openSystemPromptPage`, `openDefaultModelPicker`, `openVertexPage` (`SAFETY_OPTIONS`), `openClaudePage`, `openAppearancePage`, `openReadingPage`, `openBackupPage`, `openCloudPage` (+ `showRecoveryCode`, `openCloudPasswordSheet`, `openCloudRecoverySheet`, `openCloudSignOutSheet`, `openCloudWipeSheet`, `strengthHtml`, `cloudPasswordInput`), `openUpdatesPage` (+ `updateAction`, `checkForUpdates`, `applyGitUpdate`), `openMemoryEditor` |
| IMAGE VIEWER | `openImageViewer` (pinch‑zoom, двойной тап) |
| GESTURES | `initGestures`: долгое нажатие → меню, свайп строки чата, свайп ответа = вариант |
| GLOBAL EVENTS | `ACTIONS` (обработчики `data-action` для всего документа), `initEvents`, `showLoadError`, `init` (точка входа на `DOMContentLoaded`) |
| PUBLIC SURFACE | `window.appUI` (`handleBack`, `openTab`, `openChatRoom`, `closeChatRoom`, `openNewChat`, `openCharacterEditor`, `openPersonaEditor`, `openSettingsPage`), `window.__appInternals` (для тестов) |

**Соглашения UI:** глобальные кнопки — `data-action="…"` (обработчики в `ACTIONS`); кнопки внутри слоёв — `data-act="…"` (`bindActs(layer, {...})`). Разметка строится шаблонными строками; **всё пользовательское и модельное экранируется** `escapeHtml` / `formatRoleplayHtml`. Каждый слой может иметь `layer.refresh` (вызывается `refreshLayers()` после обновления данных).

### 10.3 `styles.css`
Разделы: design system (переменные `--bg`, `--surface`, `--text`, `--accent-h` и др.; темы `[data-theme="dark|amoled|light"]`), Base, Tabs & bottom navigation, App bars, Buttons, Avatars, Lists/cards/sections, Chips/pills/badges/segmented, Form fields, Spinner & skeleton, Layers (page/sheet/action sheet/dialog), Toasts, Chats list, Chat room (сообщения, мысли, живая генерация, композер), Roleplay markdown, Characters (страница, редакторы, новый чат), Model picker, Settings (+ диагностика), Image viewer, широкие экраны/тач/`prefers-reduced-motion`. Цвета тёмной темы совпадают с нативными (`#0F1115` фон, `#13161C` навигация) — см. `MainActivity`, `res/values/colors.xml`, `THEMES` в `app.js`.

---

## 11. Разработка и тесты

- `npm test` — все `mobile/tests/*.test.js` (Node 24, без зависимостей).
- `npm run check` — `node --check mobile/www/app.js` + тесты (то же запускает `build-apk.ps1`).
- `npm run dev` → http://localhost:5173 — UI в браузере ПК с `mock-bridge.js`. Переключатели в URL: `?empty=1`, `?long=1`, `?delay=ms`, `?update=ota|apk`, `?loginhang=1`, `?loginfail=1`, `?hang=1|2`, `?engine=N`, `?cloud=none|signedout|novault|locked|ready|quota|error` (пароль мока «мой кот любит зимний чай», код `000G-40R4-0M30-E209-185G-R38E-1W81-24GK`; `&vault=1` — после входа хранилище уже есть).
- Облако: `cloud-format.test.js` и `android/tests/CloudCryptoTest.java` проверяют **одни и те же** векторы (Node ↔ JVM); `cloud-schema.test.js` выполняет `android/assets/cloud-schema.sql` на `node:sqlite`. JVM‑тест вручную: `javac -encoding UTF-8 -d <out> android/src/com/agy/roleplay/CloudCrypto.java android/tests/CloudCryptoTest.java` и `java -cp <out> com.agy.roleplay.CloudCryptoTest` (`--emit` печатает вектор Java для Node‑теста).
- `harness.js` — загружает `app.js` в `vm` с заглушками DOM; тесты используют `window.__appInternals`. Новую чистую функцию для тестов надо добавить в `__appInternals`.
- Тесты‑«зеркала» (system‑prompt, gemini‑request, updates) повторяют Java‑логику на JS: меняете Java — меняйте зеркало.

### 11.1 Отладка на телефоне (adb по Wi‑Fi)
- `adb.exe` — в кэше инструментов (`…\android-sdk\platform-tools\adb.exe`). Телефон уже спарен; найти: `adb mdns services`, затем `adb devices`.
- `run-as` на этой прошивке заблокирован (SELinux + targetSdk 28). Поэтому:
  1. `android\build-apk.ps1 -Debuggable` → `%TEMP%\agy-roleplay-debug.apk`; `adb install -r …` (данные сохраняются).
  2. Запуск как с иконки: `adb shell monkey -p com.agy.roleplay -c android.intent.category.LAUNCHER 1`.
  3. `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` (pid: `adb shell pidof com.agy.roleplay`).
  4. CDP‑скрипты в `%TEMP%\agy_tools\`: `devcall.js <port> <METHOD> <endpoint> [json]` (вызов API), `phoneshot.js` (JS + скриншот). `POST /api/dev/exec {"argv":[...]}` — команда в песочнице приложения.
  5. В Git Bash ставьте `MSYS_NO_PATHCONV=1`, иначе аргумент `/api/...` превратится в путь Windows.
  6. После отладки **вернуть релизный APK**.
- Тестовые данные создавайте на отдельных карточках/чатах («Тест … (удалить)») и удаляйте; перед рискованными проверками делайте `/api/backup/export`.

---

## 12. Правила и предпочтения пользователя (соблюдать!)

1. **Один системный промпт, без скрытого.** Пользователь пишет промпт сам («Системный промпт» = `GEMINI.md`); ниже — только `<character_persona>`, `<user_persona>`, `<chat_memory>`. Не добавлять скрытые инструкции, не переписывать текст пользователя/истории, не внедрять новый авто‑контекст **без спроса**. Всё, что движок обязан добавить (реплика `[Начало ролевой игры]`, задание транскрипта Claude Code), показывается в окне «Итоговый системный промпт» → «Что ещё получает модель» (`deliveryNote`). Лор (lore) не используется.
2. Настройки живут там, где используются: приветствие — в карточке, модель/персона — в чате.
3. UI‑тексты — по‑русски; комментарии/идентификаторы — по‑английски; стиль кода — как в окружающем коде.
4. Переводы строк — LF; `.gitattributes` запрещает git менять байты (иначе ломается подпись OTA).
5. `targetSdk` остаётся 28; Gradle не вводить; зависимости (androidx, npm) не добавлять без необходимости.
6. Ключи подписи (`agy-release.keystore`, `ota-release-private.pem`) — только на ПК, никогда в git. Debuggable‑APK не публиковать.
7. Push в GitHub = публикация обновления для приложения — только с согласия пользователя.

---

## 13. Матрица зависимостей: «меняешь X → проверь Y»

| Что меняете | Что ещё нужно изменить/проверить |
|---|---|
| Любой `/api/*` (путь, поля запроса/ответа) | `LocalBackendServer.routeRequest` + обработчик; вызовы `api()` в `app.js`; `mobile/dev/mock-bridge.js → route()`; при необходимости зеркальные тесты; если старый UI/движок перестаёт понимать — поднять build и `MIN_ENGINE_BUILD` |
| Список моделей / их effort | `VERTEX_MODELS` / `CLAUDE_CLI_MODELS` (Java); `MODELS` в `mock-bridge.js`; префиксы `claude-code-` / `claude-` критичны для маршрутизации (`generateRoleplayReply`, `providerOf`); `tests/ui-helpers.test.js` |
| Сборка системного промпта / память | `buildSystemPrompt`, `readChatMemory`, `tidyChatFiles` (Java); `buildSystemPrompt` в `mock-bridge.js`; `tests/system-prompt.test.js`; тексты `openSystemPromptPage`, `openMemoryEditor` |
| Что уходит Gemini/Claude помимо промпта | `generateRoleplayReply`, `buildClaudeTranscript`; `deliveryNote` в `app.js`; `tests/gemini-request.test.js`. Спросить пользователя (см. §12) |
| Формат подписи OTA | `buildOtaManifestPayload` (Java) **и** `$Payload` в `sign-ota.ps1` **и** зеркало в `tests/updates.test.js` — строго одинаково |
| Логика «есть ли обновление» | `handleUpdatesCheck`, `handleUpdatesApply`, правило в `initWorkspaceAndDatabase`; `updateAction`/`checkForUpdates`/`openUpdatesPage` в `app.js`; `/api/updates/check` в моке; `tests/updates.test.js` |
| Транспорт ответов моста | `deliverResponse` (Java) ↔ `__onAndroidServerResponse` (`app.js`) ↔ `requestAsync` в моке ↔ `%TEMP%\agy_tools\devcall.js` |
| Методы `@JavascriptInterface` | `LocalBackendServer` + места вызова в `app.js` (`openExternal`, `reloadApp`, `saveFile`, экспорт, `applyTheme`) + объект `window.AndroidServer` в моке |
| Колбэки натив → JS | `MainActivity` / `LocalBackendServer` и функции в `app.js` (таблица §4) — имена не переименовывать |
| Схема БД (таблица/колонка) | `initWorkspaceAndDatabase` (`CREATE TABLE` / `addColumnIfMissing`); запросы в DATABASE HELPERS; резервная копия (`BACKUP_TABLES`, импорт фильтрует колонки); данные мока; **облако**: если колонка — часть записи, то триггер `UPDATE OF …` в `cloud-schema.sql`, `cloudExportRecord` и `applyCloud…`; базовые таблицы в `tests/cloud-schema.test.js` |
| Состав записи облака (поля карточки/чата/сообщения) | `cloudExportRecord` **и** `applyCloud*` (LocalBackendServer) — новые поля читать через `opt*` (старые записи их не имеют); триггеры `UPDATE OF` в `cloud-schema.sql`; старые версии приложения проигнорируют незнакомые поля |
| Формат шифрования облака (ключи, AAD, заголовок, docId, код восстановления) | `CloudCrypto` + `android/tests/CloudCryptoTest.java` + `mobile/tests/cloud-format.test.js` — строго одинаково; иначе ни одно устройство не прочитает существующие данные. Новый формат — новая версия байта/поля `v`, старый читать дальше |
| Синхронизируемые настройки | список ключей в триггерах `cloud_settings_*` (`cloud-schema.sql`), `cloudExportRecord("settings")`, `applyCloudSettings` |
| `cloud-schema.sql` | `tests/cloud-schema.test.js`; это нативный asset → новый APK (build +1); триггеры пересоздаются при каждом старте (DROP + CREATE) |
| Правила Firestore / поля документов | `firebase/firestore.rules` (поля `c, u, n`; хранилище `v, kdf, iter, salt, pw, rc, kid, u`) ↔ `CloudSync` (`vaultFields`, `prepare`) ↔ `CloudStore.putWrite`; пользователь публикует правила сам — обновить `firebase/README.md` |
| Новая настройка | `setDefaultSetting` (init); GET/POST `/api/settings`; `applySettings` в `app.js`; `RESTORABLE_SETTINGS` (если должна восстанавливаться из копии); секрет — добавить в `SECRET_SETTING_KEYS` (секрет облака — ещё и в `STRICT_SECRET_KEYS`); если она общая для аккаунта — в синхронизируемые (строка выше) |
| Карточки / аватары | `saveOrUpdateCharacter/Persona`, `cleanAvatarUrl`, `cardFileName`; `openCardEditor`, `downscaleImage`, `resolveAvatarUrl`, `withCardImages` в `app.js` (детали чата приходят **без** аватаров) |
| Среда Claude Code (версии, части) | `ClaudeRuntime.PARTS` + **`RUNTIME_VERSION`** + `MUSL_LOADER_SHA256` (если меняется rootfs); тексты размера загрузки в `openClaudePage`; проверить «Проверить запуск» на телефоне |
| Аргументы/разбор Claude Code CLI | `callClaudeCodeCli`, `handleClaudeAuthStart`, `runFullStart`; помнить: глобальные флаги до подкоманды |
| Скрипты `assets/claude-diag/*` | константы `PRELOAD_*` в `ClaudeRuntime`; `runProbe`/`runFullStart`; `tests/claude-diag.test.js`; это нативные assets → нужен новый APK (build +1) |
| Иконка в UI | `<symbol id="i-…">` в `index.html` ↔ `ic('…')` в `app.js` |
| CSS‑классы | шаблоны в `app.js` ↔ `styles.css` |
| Цвет фона/панелей | `THEMES` в `app.js`; `MainActivity` (стартовые цвета); `res/values/colors.xml` |
| Любой файл `mobile/www/*` | после правки перед релизом: `sign-ota.ps1` (подпись), коммит вместе с `version.json` |
| Java / манифест / res / assets | build +1, новый APK (OTA этого не доставит) |
| Версия | `AndroidManifest.xml`, `package.json`, оба `version.json` (`build-apk.ps1` пишет `apkSha256`, `sign-ota.ps1` — подпись) |

---

## 14. Типовые задачи (рецепты)

- **Добавить модель Gemini/Vertex:** строка в `VERTEX_MODELS` (`{id, name, provider, badge, efforts}`); если реальный ID на Vertex другой — `resolveExactVertexModelId`; то же в `mock-bridge.js MODELS`. Нужен APK (Java).
- **Добавить модель Claude Code:** строка в `CLAUDE_CLI_MODELS` (`id` с префиксом `claude-code-`, значение `--model`, имя, бейдж, уровни effort, legacy `"0"/"1"`); мок.
- **Новый эндпоинт:** ветка в `routeRequest` (+ обработчик, ошибки через `errorJson`), вызов `api()` в `app.js`, имитация в `mock-bridge.js`, тест при необходимости.
- **Новый экран настроек:** функция `openXxxPage()` по образцу `openAppearancePage` (`openPage`, `bindActs`, `layer.refresh`), строка в `renderSettingsTab` (`settingsRow({page:'xxx'})`) и в `openSettingsPage`.
- **Изменить текст/вид UI:** `app.js` (шаблоны) и `styles.css`; проверить `npm run dev`; для релиза — подпись OTA.
- **Изменить системный промпт/контекст:** см. §8.1 и §12 (с согласия пользователя), обновить зеркальные тесты.
- **Изменить БД:** `addColumnIfMissing` / `CREATE INDEX IF NOT EXISTS` в init; не удалять колонки (SQLite); обновить копию/импорт.
- **Проблема «Claude Code не отвечает»:** UI «Настройки → Claude Code CLI → Проверить запуск» (отчёт по этапам); на ПК — debuggable‑сборка и `/api/claude/selftest`.
- **Проблема «Gemini не отвечает»:** журнал генерации (иконка «Ход генерации» / «Последняя генерация»): 401 — перевойти; 403 billing — включить оплату проекта Google Cloud или сменить Project ID; 429 — квота.

---

## 15. Известные ловушки и текущее состояние

- **Vertex 403 «billing not enabled»** (с 26.10.2026) на проекте `project-4c7a8e8a-764a-42bc-bdf`: Gemini и Claude на Vertex не работают до включения оплаты или смены Project ID. Это не баг кода.
- proot удалён: на ядре 4.14 под ptrace Bun зависает. Не возвращать.
- Вход Claude: «выполнен» только при токене в `~/.claude/.credentials.json` (`~/.claude.json` пишется при каждом запуске). «Войти заново» ждёт **новые** учётные данные (`credentialsStamp` ≠ `loginBaseStamp`).
- Глобальные флаги Claude Code (`--debug-to-stderr`) — **до** подкоманды (`enablePositionalOptions`).
- `Process.destroy()` шлёт только SIGTERM — убивать через `ClaudeRuntime.kill` (SIGKILL всему дереву).
- PowerShell `Copy-Item` сохраняет время файла → git может «не заметить» изменение файла того же размера (скрипты теперь пишут байты заново).
- `adb shell am start -n …` без категории LAUNCHER раньше создавал второе окно; теперь `singleTask`, но для тестов используйте `monkey … LAUNCHER`.
- Отладка WebView и `/api/dev/exec` работают только в debuggable‑сборке.
- Haiku в Claude Code иногда начинает ответ с «Имя:» — следствие формата транскрипта (не меняли, т.к. это меняет промпт).
- Облако: порядок сообщений — **`sort_key`**, а не `id` (из облака сообщения получают локальные id в порядке прихода). Откат и перегенерация считают «до/после» по позиции в отсортированном списке.
- Облако: изменения БД ловят триггеры — не пишите в синхронизируемые таблицы в обход (например, `PRAGMA recursive_triggers`, временные таблицы); применение из облака — только внутри `cloudApplying` (иначе эхо в очередь). Файлы (GEMINI.md, память) триггеры не видят — после записи нужен `cloudQueueFile`.
- Облако: бесплатная квота Firestore действует только для базы `(default)` редакции Standard; сутки квоты — по тихоокеанскому времени. При `RESOURCE_EXHAUSTED` синхронизация ждёт до полуночи (Pacific), данные остаются на телефоне.
- Облако: вход Google — OAuth‑клиент типа **Desktop app** (loopback разрешён только ему), PKCE + state + случайный порт на 127.0.0.1. Для Android‑клиентов loopback Google запретил.
- **Android 15+ (телефон пользователя — Android 16): у приложения в фоне нет сети** (`dumpsys netpolicy` → `blocked=APP_BACKGROUND`), запросы падают с `Unable to resolve host … No address associated with hostname`. Поэтому вход в облако двухэтапный (браузер передаёт код → обмен, когда приложение снова на экране), а `CloudSync` не синхронизирует в фоне (`syncMissed` → запуск при `onResume`). **Вход Google для Vertex (AGY) обменивает код в фоне** — на этом телефоне он упадёт так же (пока не исправлено; обход — ручная вставка ссылки на странице «Google Vertex»).
- CDP/`devcall.js` не отвечает, пока приложение в фоне (WebView на паузе); снимок экрана телефона целиком — `adb exec-out screencap -p > file.png`.
- Облако: ключ данных и refresh‑токен — «строгие» секреты: без Keystore они не сохраняются, после перезапуска нужен пароль (статус `keystoreUnavailable`).
- `npm run dev`: мок падал на `btoa` с кириллицей в аватарах (исправлено в 1.8.0 — кодируются байты UTF‑8).
- Ориентиры производительности (1.7.0, реальные данные: 25 чатов): список чатов ~20 КБ / ~40 мс; открытие длинного чата ~100–150 мс; `/api/settings` ~7 мс; память JS ~10 МБ; APK 173 КБ.

---

## 16. Глоссарий

- **AGY / Google Antigravity** — Google‑продукт, OAuth‑клиент которого используется для входа в Vertex AI без API‑ключа.
- **Vertex AI** — облако Google, где вызываются Gemini и Claude (`aiplatform.googleapis.com`).
- **Движок (engine) / build** — номер нативной сборки APK (`versionCode`, `version.json → build`, `getEngineBuild()`).
- **OTA** — подписанное обновление только веб‑слоя (`index.html`, `app.js`, `styles.css`).
- **Мост (bridge)** — `window.AndroidServer` (Java‑объект `LocalBackendServer`).
- **Workspace** — папка `files/workspace` с `.md`‑файлами карточек, памяти и системного промпта.
- **Карточка** — персонаж или персона (строка БД + `.md`‑файл).
- **Свайп / вариант** — альтернативный ответ модели на то же сообщение (`swipes_json`, `swipe_index`).
- **Effort** — глубина рассуждений модели (`low…max`).
- **Самопроверка** — «Проверить запуск» Claude Code (`/api/claude/selftest`).
- **Безопасный режим Bun** — флаги `BUN_FEATURE_FLAG_*`, отключающие новые механизмы ядра (`.compat = safe`).
- **Облако** — зашифрованная копия данных в проекте Firebase пользователя (§17).
- **Хранилище ключа (vault)** — документ `users/{uid}/meta/vault`: ключ данных, обёрнутый паролем и кодом восстановления.
- **sync_id** — случайный идентификатор строки, общий для всех устройств (локальные `id` у каждого свои).
- **Очередь (outbox)** — `cloud_outbox`: что изменилось и ещё не выгружено.
- **Надгробие (tombstone)** — зашифрованная запись `{deleted: true}`: так другие устройства узнают об удалении.
- **Водяная метка (watermark)** — время последней принятой записи облака (`cloud_watermark`): pull читает только новее.

---

## 17. Облако: аккаунт, шифрование, синхронизация (с 1.8.0)

Необязательно: без него приложение работает как раньше. Пользователь создаёт **свой** проект Firebase (тариф Spark) по `firebase/README.md`, публикует `firebase/firestore.rules` и вставляет конфигурацию в «Настройки → Облако и аккаунт». Телефон остаётся рабочей копией, облако — зашифрованная копия, привязанная к аккаунту Google.

### 17.1 Классы и данные
- `CloudCrypto` — только JDK (тестируется на ПК); `CloudStore` — сеть (вход Google, Firebase Auth, Firestore REST); `CloudSync` — ключ, синхронизация, статус, квоты. Локальная часть (схема, экспорт/применение записей) — раздел «CLOUD SYNC: LOCAL RECORDS» в `LocalBackendServer`.
- Firestore:
```
users/{uid}/meta/vault          v, kdf = "pbkdf2-sha256", iter, salt, pw, rc, kid, u
users/{uid}/records/{docId}     c (шифротекст), u (время сервера, REQUEST_TIME), n (частей, если > 1)
users/{uid}/parts/{docId}-{i}   продолжение записи больше 900 КБ (максимум 6 частей)
```
- Записи (JSON внутри шифротекста, конверт `{v: 1, k, sid, mt}`): `character`, `persona` (имя, имя файла, текст карточки, аватар, приветствие, даты), `chat` (название, `characterSid`, `personaSid`, модель, effort, provider, даты), `message` (`chatSid`, role, content, thoughts, swipes, thoughtSwipes, swipeIndex, sortKey, createdAt), `memory` (sid чата; текст без заголовка «# Память чата #N» — N локальный), `prompt` (GEMINI.md), `settings` (модель, effort, safety, projectId, `activePersonaSid`). Удаление — надгробие `{deleted: true}`. `mt` — время последнего локального изменения (= `queued_at`).

### 17.2 Шифрование (`CloudCrypto`)
- Ключ данных (DEK) — 256 бит; подключи `HMAC-SHA256(DEK, "agy/enc/v1" | "agy/id/v1" | "agy/kid/v1")`.
- Запись: `[01][флаги: 1 = deflate][IV 12][шифротекст + тег]`, AES‑256‑GCM, AAD = 2 байта заголовка + `"agy/rec/v1|" + uid + "|" + docId`. Сжатие, только если меньше; распаковка не больше 32 МБ.
- `docId` = первые 32 hex `HMAC(idKey, kind + "\n" + sid)` — облако не видит ни типов записей, ни связей.
- Хранилище: KEK = PBKDF2‑HMAC‑SHA256(пароль в NFC UTF‑8, соль 16 байт, `iter` = 600 000), своя реализация на `Mac` (провайдеры по‑разному превращают char[] в байты). `pw`/`rc` = AES‑GCM(ключ, DEK), AAD `"agy/vault/v1|" + uid + "|pw"`/`"|rc"`. Код восстановления — 20 случайных байт, Crockford base32 (32 символа, `XXXX-…`), ключ = `HMAC(байты кода, "agy/recovery/v1")`; на телефоне не хранится.
- На телефоне DEK лежит в `cloud_dek` (строгий секрет, Keystore).

### 17.3 Вход (`CloudStore`)
- OAuth‑клиент пользователя типа **Desktop app**: системный браузер → `accounts.google.com` (scope `openid email profile`, `prompt=select_account`, PKCE S256, `state`) → одноразовый слушатель `127.0.0.1:<случайный порт>/cloud-callback`. Ожидающий вход хранится в `cloud_oauth_pending` 10 минут — ручная вставка адреса работает и после перезапуска.
- Вход в два этапа (сеть в фоне закрыта, §15): слушатель только проверяет `state` и кладёт код в `cloud_oauth_pending` (`capture`), браузеру отдаёт «Почти готово» с кнопкой `agyroleplay://cloud-signin`; когда приложение снова на экране (`setForeground(true)`), `finishCapturedSignIn` меняет код на `id_token` Google (сохраняется на 50 минут вместо кода — если Firebase сейчас недоступен) и затем на сессию Firebase, с повторами, пока Android возвращает сеть. В статусе `loginCaptured`.
- `oauth2.googleapis.com/token` → `id_token` → `identitytoolkit …/accounts:signInWithIdp` → Firebase `idToken` (только в памяти) + `refreshToken` (строгий секрет). Обновление — `securetoken.googleapis.com/v1/token` за 5 минут до истечения или по 401. На Identity Toolkit и Token Service уходят `X-Android-Package`/`X-Android-Cert` (ключ можно ограничить приложением).
- Firestore REST: `:commit` (до ~400 записей / 6 МБ, `updateTransforms u = REQUEST_TIME`, хранилище создаётся с `currentDocument.exists = false`), `:runQuery` (`u > max(метка − 5 с, время прошлого полного чтения − 10 с)`, сортировка `u, __name__`, страницы по 100 с курсором; `readTime` ответа → `cloud_read_time`), `:batchGet` (части), GET хранилища. Ошибки → `CloudException` (`ERR_AUTH, PERMISSION, QUOTA, NETWORK, CONFLICT, NOT_FOUND, CONFIG, OTHER`) с понятным русским текстом.

### 17.4 Синхронизация (`CloudSync`)
- Один рабочий поток, все операции под `lock`. Запуск: при старте (через 2 с), после локальных изменений (через 3 с, если очередь не пуста), при возврате в приложение (не чаще раза в минуту), вручную. Ждёт не больше одного следующего запуска. Только на переднем плане: в фоне запуск откладывается (`syncMissed`), сетевая ошибка из‑за ухода в фон ошибкой не считается. Раз в 30 минут — проверка хранилища (`kid`: не пересоздано ли с другого устройства).
- **Pull:** расшифровать → проверить `v` и что `docId` = docId(k, sid) → «новее побеждает»: пропустить, если `cloud_records.mt ≥ mt` (если пришла копия старее нашей — наша ставится в очередь снова); пропустить, если локальное изменение в очереди новее; иначе применить (карточки → чаты/настройки/промпт → память → сообщения, удаления последними) внутри `cloudApplying`; сообщение без чата паркуется. Метка сохраняется в той же транзакции.
- **Push:** очередь → экспорт → запечатать → записать. Строки нет: если облако её не знало — просто снять с очереди; сообщение/память удалённого чата — удалить документ; иначе надгробие. С очереди снимается, только если `queued_at` не изменился за время выгрузки.
- **Привязка:** пустое облако — «Создать хранилище» (сначала удаляются записи старого хранилища, затем ставится в очередь всё). Хранилище есть — «Открыть»: `merge` (поставить всё своё в очередь, затем pull: при расхождении побеждает телефон) или `replace` (проверить чтение облака → стереть телефон → pull). Тот же `kid` — просто продолжить (например, после сброса Keystore).
- **Выход:** `signOut(wipeLocal)` снимает привязку, ключ, сессию и служебные таблицы (и данные телефона). `wipeCloud` удаляет records, parts, хранилище (и по желанию пользователя Firebase), затем выход.
- **Квоты:** счётчики чтений/записей/удалений за тихоокеанские сутки (`cloud_usage`); при `RESOURCE_EXHAUSTED` — пауза до полуночи (Pacific) + 1 мин.
- **Резервная копия при включённом облаке:** сначала pull, затем импорт (триггеры ставят в очередь удалённые и восстановленные строки), затем файлы → облако заменяется копией.

### 17.5 Модель угроз
| Угроза | Защита |
|---|---|
| Утечка базы, доступ к консоли Firebase, сам Google | сквозное шифрование; видны только число, размер и время записей |
| Чужой аккаунт Google | правила: `uid` пути = `request.auth.uid`, провайдер google.com, `email_verified`, email владельца; OAuth‑клиент в режиме Testing |
| Подмена или перестановка документов | AES‑GCM с AAD (uid + docId), проверка docId по содержимому; старую копию «победит» более новая |
| Перехват кода OAuth другим приложением | PKCE + state + случайный порт на 127.0.0.1, слушатель одноразовый |
| Перебор пароля | PBKDF2 600 000, минимум 10 символов, индикатор надёжности; после 5 неверных попыток — пауза от 30 с |
| Вредные данные из облака | всё проверяется; пути файлов строятся только локально; лимит распаковки |
| Утечка ключей с телефона | Keystore; строгие секреты без Keystore не пишутся на диск; в JS, копию и журналы не попадают |
| Не защищает | разблокированный телефон в чужих руках; захват аккаунта Google (сможет удалить облачную копию, но не прочитать) |

### 17.6 Проверка на телефоне
- Нужен настоящий проект Firebase (README). Debuggable‑APK + `devcall.js`: `GET /api/cloud/status`, `POST /api/cloud/config {config}`… Вход Google — только нажатием в браузере телефона.
- Разрушающие проверки (`replace`, выход со стиранием) — только после `GET /api/backup/export`, сохранённого на ПК.
- Для проверки «второго устройства» без второго телефона: выйти со стиранием и войти снова (тот же аккаунт) — данные должны вернуться в том же порядке.
