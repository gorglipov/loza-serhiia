# LOZA: адмінпанель та існуючий Telegram-бот

PR №2 перевірено: злитий у `main`; база цієї роботи — `615d3e52d1002aa86de0ceacdc9778067f73751b`.
Цей PR не застосовує міграцій, не змінює binding Production, не розгортає Cron Worker і не змінює webhook Telegram/monobank. Платежі залишаються вимкненими.

## 1. Спочатку окрема Preview D1

У Cloudflare Pages → LOZA → Settings → Bindings → **Preview** прив’яжіть `DB` до окремої бази `grape-orders-preview`, а не до робочої `grape-orders`. Якщо база вже є, використовуйте її фактичну назву в командах. Не копіюйте персональні дані робочих покупців у Preview.

У PowerShell:

```powershell
Set-Location "C:\Users\rigam\Documents\Codex\2026-10-19\new-chat\work\loza-serhiia"
$lozaNode = "C:\Program Files\nodejs\node.exe"
$lozaWrangler = "C:\Users\rigam\AppData\Local\npm-cache\_npx\32026684e21afda6\node_modules\wrangler\bin\wrangler.js"
& $lozaNode $lozaWrangler login
& $lozaNode $lozaWrangler d1 list
```

Якщо Preview D1 ще немає:

```powershell
& $lozaNode $lozaWrangler d1 create grape-orders-preview
```

На **новій порожній Preview D1** спочатку потрібні базові таблиці. Ці дві команди не застосовуйте до Production:

```powershell
& $lozaNode $lozaWrangler d1 execute grape-orders-preview --remote --command "CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, amount_kop INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending'); CREATE TABLE IF NOT EXISTS mono_events(id TEXT PRIMARY KEY);"
& $lozaNode $lozaWrangler d1 execute grape-orders-preview --remote --file .\migrations\0002_store_cart.sql
```

До наявної Preview D1 після `0002_store_cart` застосуйте нову міграцію:

```powershell
& $lozaNode $lozaWrangler d1 execute grape-orders-preview --remote --file .\migrations\0003_admin_telegram.sql
& $lozaNode $lozaWrangler d1 execute grape-orders-preview --remote --command "SELECT version FROM loza_store_migrations; SELECT COUNT(*) AS products FROM products; SELECT enabled,version FROM telegram_settings; PRAGMA foreign_key_check;"
```

Міграція адитивна та повторювана: створює окремі таблиці версій, аудиту, повернення складу та черги сповіщень. Не видаляє і не перебудовує чинні таблиці. Старим замовленням сповіщення заднім числом не надсилаються. Ціни/доступність/залишки міграція `0003` не змінює.

## 2. Cloudflare Access

Для поточного `*.pages.dev` почніть із **Pages → Settings → Enable access policy → Manage**: Cloudflare створить Access application для Preview. Змініть його Allow policy на точний email власника та візьміть AUD саме з нього. Для першого тестування можна залишити захист усього Preview hostname: це охоплює і HTML, і API. **Не видаляйте wildcard заради Preview** — у процедурі Cloudflare це використовується для окремого захисту production `pages.dev`. [Офіційна інструкція Pages Access](https://developers.cloudflare.com/pages/platform/known-issues/#enable-access-on-your-pagesdev-domain).

Якщо налаштовуєте окремий захист шляхів через **Self-hosted application** у Cloudflare Zero Trust → Access → Applications, використовуйте стабільний Preview hostname гілки з PR. Потрібні обидві групи шляхів на тому самому hostname:

Preview цієї гілки: `codex-admin-telegram.loza-serhiia.pages.dev` ([відкрити](https://codex-admin-telegram.loza-serhiia.pages.dev)).

- `/admin`, `/admin/*`;
- `/api/admin`, `/api/admin/*`.

Додайте їх до **одного Access application з одним AUD**, використовуючи додаткові public hostnames/paths. Якщо інтерфейс потребує окремих застосунків, не задавайте два різних AUD в цій реалізації: використайте один застосунок для всього Preview hostname (для тестування), або один застосунок з кількома шляхами. Production каталог не закривайте цілком.

Політика: **Allow → Emails → точна адреса власника**. Не використовуйте Everyone, Bypass чи Service Auth для адмінпанелі. Увімкніть MFA в обраному постачальнику ідентифікації; коротку сесію, наприклад 1 годину. Email у allow policy і `ADMIN_EMAILS` мають збігатися. Не надавайте стороннім доступ через загальний домен пошти.

Перевірте, що Access охоплює також точні шляхи без завершального `/`. Не покладайтеся лише на wildcard. Альтернативні deployment URL, які не охоплені Access, залишаються закритими сервером: без підписаного assertion заголовка буде 403.

У **Pages → Settings → Variables and Secrets → Preview** додайте:

| Назва | Тип | Значення |
| --- | --- | --- |
| `ACCESS_TEAM_DOMAIN` | Variable | `https://ВАША-КОМАНДА.cloudflareaccess.com`, без `/` у кінці |
| `ACCESS_AUD` | Variable | Application Audience (AUD), 64 hex символи, з цього Access application |
| `ADMIN_EMAILS` | Secret | Точна email адреса адміністратора; за потреби кілька через кому |
| `ADMIN_CSRF_SECRET` | Secret | Нове випадкове значення щонайменше 32 символи |

Згенерувати 32 випадкові байти локально (результат вставляйте тільки в Cloudflare Secret):

```powershell
& $lozaNode -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Сервер перевіряє RSA/RS256 підпис за JWKS налаштованої команди, `iss`, `aud`, `exp`, `iat`, `nbf`, тип токена та точну email адресу. Ключі беруться лише з фіксованого `ACCESS_TEAM_DOMAIN`, з кешем і оновленням для ротації. Непідписаний email заголовок не використовується. Немає режиму обходу авторизації для Preview чи localhost у коді застосунку.

Зміни потребують same-origin JSON POST та HMAC CSRF токена, прив’язаного до JWT/користувача/Origin/строку сесії. Приватні відповіді мають `no-store`, CSP і заборону iframe. Дані в UI вставляються через `textContent`, без HTML із введених значень.

## 3. Існуючий Telegram-бот

Новий бот не потрібен. Webhook не змінюється. Використовується тільки офіційний `sendMessage`.

Перевірте наявність **в Preview**, оскільки Production Secrets не слід вважати автоматично доступними в Preview:

- `TELEGRAM_BOT_TOKEN` — Secret існуючого бота;
- `TELEGRAM_CHAT_ID` — Secret, числовий ID приватного чату/групи власника.

Не надсилайте токени в чат, код, GitHub, URL браузера чи скриншоти. Панель повертає тільки ознаку налаштованості. Власник уже має почати діалог із ботом або дозволити йому писати у відповідну групу.

Повідомлення містить номер, товари зі знімка замовлення, кількість, суму і статус. Телефон, ім’я, місто, відділення та коментар не передаються. Тест із Preview використовує того самого бота і прийде у налаштований чат; запускайте його свідомо через `/admin` → Telegram → «Надіслати тест».

Створення замовлення та вставка у `telegram_outbox` виконуються одним D1 batch. Лише після commit запускається відправка. На кожне замовлення є один унікальний event key. Atomic claim і lease захищають від паралельної відправки; підтверджений `message_id` зберігається. Помилка Telegram не скасовує замовлення і не створює нове.

Підтверджені Bot API відмови 429/5xx повторюються з backoff, з урахуванням `retry_after`, до 8 спроб. Інші відмови видимі як `failed`. Прострочений lease, timeout або втрата відповіді — `uncertain`: Telegram міг уже отримати повідомлення. Bot API `sendMessage` не має ключа ідемпотентності, тому абсолютне exactly-once при втраті відповіді неможливе. Автоповтор таких подій вимкнено; адміністратор спочатку перевіряє чат, а потім явно дозволяє повтор із попередженням про дубль. Ця дія записується в історію.

## 4. Автоматичні повтори без нових замовлень

Pages Functions не запускають Scheduled Events. Підготовлено окремий Cron Worker, який використовує **ту саму чергу D1**, без HTTP endpoint для її запуску. Самостійно він із PR не публікується.

Для Preview скопіюйте `workers/wrangler.preview.example.toml` у файл поза репозиторієм або у локальний `workers/wrangler.preview.local.toml` (не комітьте його), впишіть **ID окремої Preview D1**. Якщо конфігурація поза `workers/`, задайте абсолютний `main` до `workers/telegram-retry.js`.

```powershell
& $lozaNode $lozaWrangler secret put TELEGRAM_BOT_TOKEN --config .\workers\wrangler.preview.local.toml
& $lozaNode $lozaWrangler secret put TELEGRAM_CHAT_ID --config .\workers\wrangler.preview.local.toml
& $lozaNode $lozaWrangler deploy --config .\workers\wrangler.preview.local.toml
```

Worker має окремі secrets: внесіть туди ті самі наявні значення, не створюючи бота. Cron раз на хвилину забирає до 10 належних подій. Без Cron повтори запускаються при наступних успішних оформленнях/повторах запитів і через захищену кнопку «Повторити заплановані». Нові замовлення запускають першу відправку відразу через `waitUntil`.

## 5. Перевірка у Cloudflare Preview

1. Прив’яжіть окрему Preview D1, застосуйте `0002` (якщо нова база) і `0003`, налаштуйте Access та Preview variables/secrets. Збережіть чинні Turnstile ключі та `CHECKOUT_SECURITY_KEY`; додайте Preview hostname до Turnstile allowlist.
2. Запустіть **Retry deployment тільки для Preview гілки PR** у Pages. Не натискайте Promote to Production і не зливайте PR.
3. В інкогніто відкрийте `/admin` і `/api/admin/orders`: Access має просити вхід. Сторонній email не повинен отримувати дані. Прямий URL deployment без Access має повертати 403 від сервера. Якщо `/admin` повертає 503, перевірте змінні Access та міграцію.
4. Увійдіть дозволеним email: перевірте Dashboard, пошук/фільтри товарів, гривні з двома десятковими знаками, редагування характеристик. Дві вкладки зі старою версією товару: друга зміна повинна отримати 409.
5. Створіть демонстраційне замовлення з кошика після Turnstile. Перевірте номер/суму/`pending`, відповідний рядок в адмінпанелі та **одне** повідомлення Telegram без контактів. Повтор тієї самої заявки не повинен створити другий order/event.
6. Перевірте послідовності `pending → confirmed → shipped → completed` та `pending/confirmed → cancelled`. Повторне скасування не збільшує залишок; виконане/скасоване замовлення не відкривається повторно. Старі статуси поза цим workflow показуються без автоматичного перетворення.
7. У `/admin` → Telegram натисніть «Надіслати тест». Після зміни налаштувань перевірте історію. Тест можна надіслати і коли сповіщення про нові замовлення вимкнені.
8. Перевірте чергу та Cron: `retry` після відомої відмови, `sent` після успіху; `uncertain` не повторюється без рішення адміністратора. Для симуляції 429/втрати відповіді використовуйте локальний тест нижче, не змінюйте робочий токен.
9. Смартфон: меню прокручується, таблиці мають горизонтальний скрол; редагування, закриття діалогу і форма кошика працюють. Запит із чужим Origin/без CSRF — 403, приватні відповіді — `Cache-Control: private, no-store`.

## 6. Автоматизований локальний Preview

Тести запускають справжній зібраний Pages Worker у Miniflare з ізольованою D1, локальними RSA JWT та підставними відповідями Access/Turnstile/Telegram. Тестовий ключ не довірений у Cloudflare і не додається в код сервера. Робочі API та персональні дані не використовуються.

На цьому комп’ютері вже є кешовані Wrangler/Miniflare:

```powershell
& $lozaNode $lozaWrangler pages functions build --outfile .wrangler/admin-worker.js
$env:LOZA_MINIFLARE_MODULE = "C:\Users\rigam\AppData\Local\npm-cache\_npx\32026684e21afda6\node_modules\miniflare\dist\src\index.js"
& $lozaNode --test .\tests\admin-preview.test.mjs
```

Для додаткового браузерного тесту на цьому комп’ютері задайте перед запуском:

```powershell
$env:LOZA_PLAYWRIGHT_MODULE = "C:\Users\rigam\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright\index.mjs"
```

Тест використовує встановлений Microsoft Edge у headless режимі, перевіряє 1440/390 px і зберігає локальні скриншоти в `.wrangler/`. Без цієї змінної браузерний сценарій позначається як skipped, решта 11 сценаріїв виконуються.

На іншому комп’ютері потрібні Node 22+, Wrangler та Miniflare; вкажіть `LOZA_MINIFLARE_MODULE` на встановлений `miniflare/dist/src/index.js`. Збірка потрібна перед кожним тестом після зміни Functions.

## 7. Production — лише після окремого рішення

Перед майбутнім злиттям зробіть export **поза папкою публікації**, перевірте реальну схему `orders` (включно з CHECK статусів), кількість записів та `PRAGMA foreign_key_check`. Схема повинна дозволяти нові адміністративні статуси; якщо є обмеження — зупиніться і підготуйте окрему узгоджену міграцію, не перебудовуйте таблицю навмання.

```powershell
$lozaBackupDir = "C:\Users\rigam\Documents\LOZA-backups"
New-Item -ItemType Directory -Path $lozaBackupDir -Force
$lozaBackupFile = Join-Path $lozaBackupDir ("grape-orders-before-admin-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".sql")
& $lozaNode $lozaWrangler d1 export grape-orders --remote --output $lozaBackupFile
& $lozaNode $lozaWrangler d1 execute grape-orders --remote --command "SELECT sql FROM sqlite_master WHERE name='orders'; SELECT COUNT(*) AS orders_count FROM orders; SELECT COUNT(*) AS mono_events_count FROM mono_events; SELECT version FROM loza_store_migrations; PRAGMA foreign_key_check;"
```

**Наступна команда змінює робочу D1 — виконуйте її лише після перевірки Preview та власного рішення про публікацію:**

```powershell
& $lozaNode $lozaWrangler d1 execute grape-orders --remote --file .\migrations\0003_admin_telegram.sql
```

Повторіть перевірку кількості `orders`/`mono_events` і foreign keys. Налаштуйте Access для всіх робочих hostname та ті самі чотири змінні адміністратора в **Production** з відповідним AUD. Наявні Telegram secrets залиште; для майбутнього Production Cron потрібна окрема конфігурація з фактичною робочою D1, не Preview ID. Лише потім зливайте PR — Pages Git integration може опублікувати `main` автоматично.

У цій робочій папці були локальні SQL файли/резервна копія. Вони не включені до Git/PR. Новий middleware забороняє публічну видачу SQL, серверного коду і dotfiles; резервні копії все одно зберігайте поза коренем сайту та не робіть прямий upload папки з backup-файлами. Нічого з цих локальних файлів не видалено.

## Офіційні джерела

- [Cloudflare Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Access Pages Plugin та очікувані domain/AUD](https://developers.cloudflare.com/pages/functions/plugins/cloudflare-access/)
- [Telegram Bot API sendMessage](https://core.telegram.org/bots/api#sendmessage), [retry_after](https://core.telegram.org/bots/api#responseparameters)
- [D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
