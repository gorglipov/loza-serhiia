# LOZA: застосувати D1 і Turnstile перед злиттям PR

**Production ще не оновлюємо.** Спочатку застосуйте SQL та нові налаштування, потім зливайте PR `codex/store-cart-checkout` у `main`. Автоматичного запуску міграції під час збірки немає.

## Що змінює міграція

Файл: `migrations/0002_store_cart.sql`.

- Додає `products`, `order_checkout`, `order_items`, `checkout_rate_limits`, `loza_store_migrations`, індекси та два тригери для нової таблиці оформлення.
- Не виконує DROP, ALTER, UPDATE або DELETE над наявними `orders` чи `mono_events`. Їхні старі записи залишаються на місці.
- Додає 3 явно демонстраційні товари з тестовими цінами 500/350/650 грн та тестовими залишками 50/40/30.
- Зберігає назви й характеристики 107 наявних сортів як `loza-001` … `loza-107`, але ставить `price_kop = NULL`, `available = 0`, `stock = 0`. Старі ціни зі сторінки не імпортуються як актуальні.
- `ON CONFLICT DO NOTHING` робить повторний запуск безпечним для вже внесених цін і залишків: він не відновлює продані демонстраційні залишки.
- Маркер `0002_store_cart` записується останнім. Нові API не працюють, якщо завершеної міграції немає.

## 1. Відкрити папку PR

Ці команди призначені для вашого Windows PowerShell. Токени та резервні копії не потрібно надсилати в чат або додавати в GitHub.

```powershell
Set-Location "C:\Users\rigam\Documents\Codex\2026-10-19\new-chat\work\loza-serhiia"
$lozaNode = "C:\Program Files\nodejs\node.exe"
$lozaWrangler = "C:\Users\rigam\AppData\Local\npm-cache\_npx\32026684e21afda6\node_modules\wrangler\bin\wrangler.js"
& $lozaNode $lozaWrangler login
```

Нижче блоки виконуються послідовно в одному вікні PowerShell. Використовується вже встановлений на цьому комп’ютері Wrangler 4.151.3; додаткове завантаження npm не потрібне. На іншому ПК шлях до встановленого Wrangler потрібно замінити.

Завершіть вхід у Cloudflare у браузері. Для команд нижче потрібен доступ до D1 бази **grape-orders**. Це окремо від авторизації GitHub. Не змінюйте наявний production binding **DB → grape-orders**.

## 2. Перевірити стару схему й кількість записів

```powershell
& $lozaNode $lozaWrangler d1 execute grape-orders --remote --command "PRAGMA table_info(orders); PRAGMA table_info(mono_events); SELECT 'orders' AS table_name, COUNT(*) AS records FROM orders UNION ALL SELECT 'mono_events', COUNT(*) FROM mono_events;"
```

Збережіть кількість записів. В `orders` мають бути `id` (PRIMARY KEY або UNIQUE), `amount_kop`, `status`, як у чинному API. Якщо схема інша або нові таблиці вже використовуються іншим кодом, зупиніться й звірте схему перед застосуванням цього файлу. Не видаляйте таблиці для виправлення помилки.

## 3. Зберегти резервну копію поза папкою сайту

Файл експорту може містити особисті дані та банківські події. Шлях нижче розміщений поза репозиторієм і каталогом публікації.

```powershell
$lozaBackupDir = "C:\Users\rigam\Documents\LOZA-backups"
New-Item -ItemType Directory -Path $lozaBackupDir -Force | Out-Null
$lozaStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$lozaBackupFile = Join-Path $lozaBackupDir "grape-orders-$lozaStamp.pre-store.sql"
& $lozaNode $lozaWrangler d1 export grape-orders --remote --output $lozaBackupFile
if ($LASTEXITCODE -ne 0) { throw "Не вдалося експортувати базу. Міграцію не запускайте." }
Get-Item -LiteralPath $lozaBackupFile | Select-Object FullName,Length
```

## 4. Застосувати SQL саме до grape-orders

```powershell
& $lozaNode $lozaWrangler d1 execute grape-orders --remote --file ".\migrations\0002_store_cart.sql"
if ($LASTEXITCODE -ne 0) { throw "Міграція не завершилась. PR поки не зливайте." }
```

Тут використовується готовий SQL-файл через `d1 execute`; окремий `wrangler.toml` із новими або вигаданими ідентифікаторами бази не додається. Після успіху перевірте маркер і старі лічильники:

```powershell
& $lozaNode $lozaWrangler d1 execute grape-orders --remote --command "SELECT version FROM loza_store_migrations WHERE version='0002_store_cart'; SELECT id,name,price_kop,available,stock,is_demo FROM products WHERE is_demo=1; SELECT 'orders' AS table_name, COUNT(*) AS records FROM orders UNION ALL SELECT 'mono_events', COUNT(*) FROM mono_events;"
```

Старі лічильники не повинні зменшитися. Вони можуть зрости, якщо під час роботи надійшли нові замовлення чи події webhook. Не вставляйте результат SELECT з особистими даними в публічні коментарі PR.

## 5. Налаштувати Turnstile та захист запитів

1. У Cloudflare відкрийте **Turnstile**, додайте віджет **LOZA checkout** у режимі **Managed**.
2. Додайте hostname `loza-serhiia.pages.dev`. Для перегляду PR додайте також точний hostname його Cloudflare Preview з Deployments. Не використовуйте адресу Vercel для D1 оформлення.
3. У **Workers & Pages → loza-serhiia → Settings → Variables and Secrets** додайте:

| Назва | Тип | Значення |
| --- | --- | --- |
| `TURNSTILE_SITE_KEY` | Text | Public sitekey вашого віджета |
| `TURNSTILE_SECRET_KEY` | Secret | Secret key того самого віджета |
| `CHECKOUT_SECURITY_KEY` | Secret | Випадковий ключ із 32 байтів / 64 hex символів |

Генерація нового `CHECKOUT_SECURITY_KEY` у PowerShell:

```powershell
$lozaBytes = New-Object byte[] 32
$lozaRandom = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$lozaRandom.GetBytes($lozaBytes)
$lozaRandom.Dispose()
[BitConverter]::ToString($lozaBytes).Replace("-", "").ToLowerInvariant()
```

Скопіюйте результат безпосередньо в Cloudflare Secret. Не записуйте його в HTML/JS, README, PR або чат. Не змінюйте `MONO_TOKEN`, `MONO_WEBHOOK_KEY` та інші чинні секрети.

Нові значення потрібні в Production, а для перегляду PR — також у Preview. Залиште наявне підключення `DB` без змін. Зміни змінних набувають сили після нового розгортання відповідного середовища. Після налаштування повторно розгорніть Preview PR.

Якщо секрети відсутні, Turnstile не пройдено або використано публічні тестові ключі Cloudflare, створення нового замовлення блокується. Значення secret key ніколи не повертається браузеру. Public sitekey передавати браузеру потрібно для роботи віджета.

## 6. Публікація

Коли SQL застосований і налаштування готові, відкрийте Cloudflare Preview PR: товари мають завантажуватися, а форма — показувати Turnstile. Формування замовлення створює реальний рядок у D1 і резервує демонстраційний залишок, хоча оплата вимкнена.

Після завершення підготовки переведіть PR із Draft у Ready, злийте його в `main`, дочекайтеся успішного production deployment Cloudflare та відкрийте `https://loza-serhiia.pages.dev/#catalog`. Сторінки Vercel можуть показувати статичний дизайн, але не мають Cloudflare D1 binding.

## Реальні ціни й склад

У D1 Studio можна змінювати таблицю `products` через ваш авторизований Cloudflare акаунт. Для активації справжнього сорту внесіть перевірену ціну цілим числом у копійках, фактичний `stock` і `available = 1`; `is_demo` залиште 0. Непрайсовані сорти приховані з торгового каталогу. Демонстраційні товари можна вимкнути через `available = 0`. Публічного API редагування товарів немає.

Для перегляду приватного замовлення використовуйте D1 Studio й пов’язані таблиці `orders`, `order_checkout`, `order_items` за `order_id`. API не повертає покупцям чи стороннім користувачам ім’я, телефон, адресу або коментар. Не створюйте публічну сторінку/endpoint зі списком замовлень.

## Відкат без втрати нових подій

Якщо потрібен відкат коду, поверніть попередній deployment/коміт. Нові таблиці можна залишити: тригери прив’язані лише до `order_checkout`, старі `orders` і `mono_events` не перебудовуються. Не видаляйте нові таблиці та не відновлюйте весь старий експорт поверх живої бази без окремого плану збереження нових записів.

## Джерела команд і API

- [Cloudflare D1 CLI: execute та export](https://developers.cloudflare.com/d1/wrangler-commands/)
- [D1 batch: транзакційне виконання](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Обов’язкова серверна перевірка Turnstile](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
