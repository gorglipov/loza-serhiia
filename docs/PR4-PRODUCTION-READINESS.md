# LOZA: PR №4 перед Production

Перевірено 22.10.2026. [PR №4](https://github.com/gorglipov/loza-serhiia/pull/4),
гілка `codex/catalog-107`. Production перевірявся тільки читанням: жодних
віддалених міграцій, змін даних, секретів, Access, binding, розгортань чи Merge.
Ця перевірка додає тести та документацію, поведінка застосунку не змінена.

## Висновок і залежності

Код каталогу готовий до публікації **після** застосування 0004 → 0005 до правильної
Production D1 та успішного Pages check останнього коміту PR №4.

- [PR №3](https://github.com/gorglipov/loza-serhiia/pull/3) уже merged
  22.10.2026 о 15:57:49 UTC. Поточний `main` і Production —
  `7293e7036b041d21a16c4c8a0a588d173263ac86`.
- Цей коміт є предком PR №4. Повторно зливати PR №3 або переносити його зміни
  вручну не потрібно. PR №4 успадковує адмінпанель, Access, Telegram/outbox,
  кошик і Turnstile з `main`; GitHub не показує конфліктів.
- У Production застосовані тільки `0002_store_cart` і `0003_admin_telegram`.
  Без 0005 новий API навмисно відповідає `503`, тому **не Merge перед міграціями**.
- Повністю автономні повтори Telegram ще потребують окремого Cron Worker:
  на момент перевірки Workers API показує **0 окремих Worker scripts**.
  Це існуюче обмеження конфігурації, описане нижче. Pages сам Cron не запускає.

## Фактичні дані та сумісність

| Перевірка | Результат |
| --- | --- |
| Production D1 | 110 товарів: 107 реальних + 3 демонстраційні; 4 замовлення; 0 `order_checkout`, `order_items`, `mono_events`, `admin_stock_returns`, `telegram_outbox`; порушень foreign keys немає |
| Джерело | Усі 107 ID, 107 унікальних назв і характеристики Production збігаються з `server/catalog-source.json` і PDF власника |
| Імпорт | 0004 додає зв’язки до наявних товарів, не створює нові рядки `products`; 110 рядків зберігаються, демонстраційні стають архівними |
| Ціни | 84 точні ціни з колонки «Лоза» PDF, 23 відсутні. 0004 не встановлює `confirmed_price_kop`; усі 84 — кандидати до явного підтвердження |
| Preview | 107 сортів, 84 ціни, 107 ручних прапорців; одне підтвердження ціни вже зроблене адміністративною зміною з аудитом. Це рішення Preview не переноситься в Production |
| Наявність | Кожен із 107 сортів перевірений перемиканням в обидва боки через захищений API; прапорець незалежний від ціни; підтвердження ціни не виникає від перемикання |
| Умовна кількість | `stock=20/0` — сумісність зі старою схемою. П’ять замовлень по п’ять лоз не змінюють stock, наявність чи версію товару; скасування також нічого не повертає |
| Межі кошика | Залишаються правила одного замовлення: 1–5 одиниць сорту, до 20 різних сортів. Ліміту «продати лише 20 лоз загалом» немає |
| Старі дані | 0004/0005 не видаляють замовлення, позиції, транзакції, історичний журнал повернень, аудит, Telegram settings/outbox. Сумісність перевірена на фактичній DDL Production з синтетичними приватними записами |
| Захист | Серверні RS256 JWT, issuer/AUD/email allowlist, CSRF/Origin, no-store, версії, аудит та ідемпотентність зберігаються; нові CSV/availability маршрути під тим самим middleware |
| Оплата | `paymentsEnabled: false`; тести створюють замовлення без `MONO_TOKEN`/`MONO_WEBHOOK_KEY`. Webhook і банківські секрети не змінювалися |

PDF: «Каталог лози винограду 2026–2027», SHA-256
`94ef2e033480691a9b1162a5e825f48b0d5671a3a3936e2e165bddbeeb138a01`.
Характеристики без окремої перевірки власника залишаються непідтвердженими.

Обидва середовища мають різні DB ID. Наявність дев’яти необхідних env bindings
перевірена як `true`: чотири Access/admin, два Telegram, два Turnstile,
`CHECKOUT_SECURITY_KEY`. Формат відкритих Access domain/AUD/email полів валідний;
значення секретів не читались і не публікувались. Відкриті `/`, `/api/products`,
`/api/store/config` Production повертають 200, checkout доступний, платежі вимкнені.
Неавторизовані `/admin` та групи admin API ведуть у Access із правильним AUD;
серверні джерела й SQL назовні повертають 404.

## Тести і збірка

**37/37 passed, 0 failed, 0 skipped.** Wrangler 4.152.0 успішно зібрав Pages Functions.
Окреме складання Telegram Worker через `deploy --dry-run` також успішне;
реального deployment Worker не виконано. Після додавання нових файлів до Git
сканування секретів повторно пройшло.

Запуск включає справжній зібраний Worker, ізольовану Miniflare D1 з фактичною DDL
Production, копію тільки публічних товарних даних та синтетичні приватні записи.
Рядки покупців не копіювалися, реальному боту повідомлення не надсилалися.
Браузерні перевірки — Edge, 320/390/1440 px: картки без фото, фільтри, пошук,
кошик після reload, CSV, адміністратор, відсутність XSS і переповнення.

Окрема репетиція 0004 → 0005 порівнює всі поля наявних синтетичних замовлень,
доставки, позицій, банківських подій, повернень, вимкненого Telegram з версією,
черги повторів і адміністративної історії до/після міграцій. Повтор 0005 також
зберігає ці дані. Перевірені дублі/конфлікти CSV, відкликання ціни, застарілий
кошик, SQL-гонка з відкатом, JWT/CSRF, обмеження частоти й відсутність секретів.

Для повторення з установленими Node/Wrangler/Miniflare/Playwright:

```powershell
npx.cmd wrangler pages functions build --outfile .wrangler/admin-worker.js
node --test tests/access-configuration.test.mjs tests/admin-preview.test.mjs tests/catalog-csv.test.mjs tests/production-migrations.test.mjs tests/source-secrets.test.mjs tests/telegram-retry.test.mjs
```

Для цього комп’ютера шляхи залежностей наведені у `docs/PRODUCTION-READINESS.md`.
Додаткові env для точної репетиції поточного стану:

```powershell
$env:LOZA_PRODUCTION_SCHEMA_FILE = '.wrangler/production-schema.json'
$env:LOZA_PRODUCTION_PRODUCTS_FILE = '.wrangler/readiness-production-products.json'
```

Ці локальні JSON містять DDL і товари, секретів/персональних записів у них немає;
вони ігноруються Git. На іншому комп’ютері без цих env використовується синтетична
базова схема. Для браузерних тестів задайте `LOZA_PLAYWRIGHT_MODULE`, щоб не було skipped.

## Точний порядок публікації власником

Наведені команди **підготовлені, але не виконані**. Міграції не запускаються
автоматично від GitHub push або Pages build. Не використовуйте загальний
`d1 migrations apply`: тут є власний `loza_store_migrations`; потрібні лише два
явно вказані файли, без повтору 0002/0003 і без локальних копій файлів із «(2)».

### 1. Перевірити базу і точку відновлення

Cloudflare → Workers & Pages → `loza-serhiia` → Settings → Bindings → **Production**
→ `DB`. Звірте прив’язку саме з `grape-orders`, вона має відрізнятися від Preview.
У поточній робочій копії підготовлений локальний `.wrangler/catalog-production.toml`
з прочитаним Production DB ID; секретів у ньому немає, файл не входить у Git.
Цей конфіг лише вибирає ціль CLI, він не змінює прив’язку Pages.

Для іншої робочої копії створіть такий самий локальний файл, підставивши
**перевірений Production ID** з Cloudflare:

```toml
name = "loza-catalog-production-migration"
compatibility_date = "2026-10-22"
[[d1_databases]]
binding = "DB"
database_name = "grape-orders"
database_id = "REPLACE_WITH_VERIFIED_PRODUCTION_DATABASE_ID"
```

У PowerShell перейдіть у корінь робочої копії з останнім комітом `codex/catalog-107`.
Перевірте ID, збережіть bookmark Time Travel та export **поза репозиторієм**:

```powershell
$lozaConfig = '.wrangler/catalog-production.toml'
npx.cmd wrangler d1 info DB --config $lozaConfig
npx.cmd wrangler d1 time-travel info DB --config $lozaConfig
$lozaBackupDir = 'C:\Users\rigam\Documents\LOZA-backups'
New-Item -ItemType Directory -Path $lozaBackupDir -Force
$lozaBackup = Join-Path $lozaBackupDir ('grape-orders-before-catalog-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.sql')
npx.cmd wrangler d1 export DB --remote --config $lozaConfig --output $lozaBackup
if ($LASTEXITCODE -ne 0) { throw 'Backup failed; stop before migration' }
```

Export тимчасово блокує інші запити D1, тому оберіть коротке вікно обслуговування.
Повторіть у **Production D1 Console** початкові read-only перевірки й збережіть
результати у приватному місці, без експорту контактів у PR:

```sql
SELECT version FROM loza_store_migrations ORDER BY version;
SELECT COUNT(*) total, SUM(is_demo=0) real_products,
       COUNT(DISTINCT CASE WHEN is_demo=0 THEN name END) real_names FROM products;
SELECT 'orders' name, COUNT(*) n FROM orders
UNION ALL SELECT 'order_checkout',COUNT(*) FROM order_checkout
UNION ALL SELECT 'order_items',COUNT(*) FROM order_items
UNION ALL SELECT 'mono_events',COUNT(*) FROM mono_events
UNION ALL SELECT 'admin_stock_returns',COUNT(*) FROM admin_stock_returns
UNION ALL SELECT 'admin_audit_log',COUNT(*) FROM admin_audit_log
UNION ALL SELECT 'telegram_outbox',COUNT(*) FROM telegram_outbox;
SELECT enabled,version FROM telegram_settings WHERE id=1;
PRAGMA foreign_key_check;
```

Очікувано до міграцій: 0002/0003, 110/107/107, 4 замовлення, решта зазначених
таблиць порожня, Telegram `enabled=1, version=0`, foreign keys без порушень.
Якщо дані змінилися після цього звіту — звірте новий baseline, нічого не очищайте.

### 2. Застосувати тільки 0004, потім тільки 0005

На час двох міграцій і перемикання deployment утримайтесь від адміністративного
редагування. Старі demo-покупки будуть закриті, нові реальні товари ще не активні:
це короткий перехідний період, без обіцянки безперервного checkout.

**Наступний блок змінює Production D1. Запускати тільки після рішення власника:**

```powershell
npx.cmd wrangler d1 execute DB --remote --config $lozaConfig --file migrations/0004_catalog_107.sql
if ($LASTEXITCODE -ne 0) { throw '0004 failed; stop before 0005 and Merge' }
npx.cmd wrangler d1 execute DB --remote --config $lozaConfig --file migrations/0005_manual_availability.sql
if ($LASTEXITCODE -ne 0) { throw '0005 failed; stop before Merge' }
```

Не додавайте `BEGIN`/`COMMIT`, не змінюйте текст міграцій у Console.
Альтернатива: виконати кожен файл цілком у Console правильної Production D1,
послідовно 0004 → 0005, перевіривши успіх кожного.

0004 створює каталог/джерело/CSV і ціни-кандидати, архівує demo. 0005 переводить
наявність у ручний режим, замінює checkout/status тригери і прибирає списання.
**Після 0005 не запускати 0004 або 0003 повторно:** вони повернуть старі визначення
тригерів. Якщо 0005 вже застосована успішно, повтор для публікації не потрібний.

### 3. Перевірити результат D1 перед Merge

```sql
SELECT version FROM loza_store_migrations ORDER BY version;
SELECT COUNT(*) total_products FROM products; -- 110
SELECT COUNT(*) catalog_rows, COUNT(DISTINCT p.name) unique_names,
       SUM(p.price_kop IS NOT NULL) with_price,
       SUM(p.price_kop IS NULL) without_price,
       SUM(c.confirmed_price_kop IS NOT NULL) confirmed_prices
FROM products p JOIN product_catalog c ON c.product_id=p.id;
-- 107, 107, 84, 23, 0 до рішень власника
SELECT COUNT(*) manual_flags,SUM(in_stock) in_stock FROM product_availability;
-- 107, 0 для поточного Production baseline
SELECT COUNT(*) stock_mismatches FROM products p
JOIN product_availability a ON a.product_id=p.id
WHERE p.stock<>CASE WHEN a.in_stock=1 THEN 20 ELSE 0 END; -- 0
SELECT COUNT(*) active_demo FROM products WHERE is_demo=1 AND available=1; -- 0
SELECT name FROM sqlite_schema WHERE type='trigger' AND name IN
 ('loza_checkout_validate_manual','loza_checkout_snapshot_manual','loza_manual_stock_guard'); -- 3
SELECT name FROM sqlite_schema WHERE type='trigger' AND name IN
 ('loza_checkout_validate_v2','loza_checkout_reserve_v2','loza_stock_return_once'); -- порожньо
PRAGMA foreign_key_check; -- порожньо
```

Мають бути всі чотири маркери 0002/0003/0004/0005. Повторіть також baseline-запити
кількості замовлень/подій/аудиту/черги та Telegram settings із кроку 1: міграції
не повинні змінити жоден із цих результатів. При невідповідності не Merge.

### 4. Merge PR №4, потім контроль нового deployment

1. Переконайтеся, що останній коміт PR №4 має успішний Cloudflare Pages check,
   PR №3 досі merged і нових конфліктів немає. PR №4 лишено Draft: після перевірок
   власник натискає **Ready for review**, потім **Merge pull request → Confirm merge**.
2. Автоматичний Production deploy для `main` увімкнений. Дочекайтеся успіху
   нового main deployment у Cloudflare; перевірте його commit hash. Не промотуйте
   старий Preview і не завантажуйте корінь локальної папки з резервними файлами.
3. Без входу: каталог показує 107 реальних сортів без фото, demo відсутні,
   пошук і всі фільтри працюють; `/api/store/config` має `paymentsEnabled: false`.
4. Без входу `/admin` та `/api/admin/*` вимагають Access. Із дозволеним акаунтом
   перевірте товари/замовлення/аудит і налаштування Telegram; секрети не додавайте
   у браузер або PR.
5. Власник підтверджує ціни та вручну вмикає наявні сорти через адмінпанель або
   свіжий CSV. Без цих дій **після міграції всі покупки закриті**; це очікувано.
   Підтвердження і статуси Preview автоматично не копіюються.
6. Лише після рішення власника зробіть одне контрольне замовлення, перевірте
   суму сервера, статус, повідомлення Telegram без контактів, повтор запиту без
   другого order/event та незмінний stock. Реальна оплата залишається вимкненою.

### 5. Окремо завершити автономні повтори Telegram

Код черги й `workers/telegram-retry.js` уже є у `main` з PR №3 і збережений у PR №4.
Першу спробу Pages запускає після commit замовлення, на наступних успішних
оформленнях та через захищений ручний повтор черга також обробляється.
Але у перевіреному акаунті немає окремого Cron Worker: без наступного запиту
відкладений `retry` самостійно не виконається. Це потрібно врахувати при запуску.

Для регулярних спроб за розкладом власник окремо готує
`workers/wrangler.production.local.toml` із
`workers/wrangler.production.example.toml`, вписує перевірений Production DB ID
і додає в **цей окремий Worker** ті самі наявні `TELEGRAM_BOT_TOKEN` та
`TELEGRAM_CHAT_ID`. Pages secrets автоматично в нього не переносяться.
Після перевірки конфігурації — окремий усвідомлений deploy Worker й перевірка
Cron раз на хвилину. Інструкція: `docs/ADMIN-TELEGRAM-ROLLOUT.md`, розділ 4.
Новий бот, webhook або зміна чинних Pages secrets не потрібні.

`uncertain` навмисно не повторюється автоматично навіть із Cron: Telegram міг
уже прийняти повідомлення. Рішення про повтор приймає адміністратор з
попередженням про можливий дубль. Відмова Telegram не скасовує замовлення.

## Межі перевірки і відновлення

- Міграції у справжній Production та поведінка нового Production deployment
  ще не перевірені, оскільки їх не виконували. Факт успіху Preview не замінює
  контрольних дій після дозволеного Merge.
- Реальну доставку за Production Cron перевірити неможливо до його налаштування.
  Не змінювали робочі токени й не імітували збої робочого Telegram/Turnstile.
- Між міграціями та deployment є період роботи старого коду з новою схемою;
  не редагуйте каталог у цей час і не підтверджуйте ціни до нового deployment.
- Після 0005 не відкочуйте тільки Pages до старого коду: старий кількісний
  checkout несумісний із новими тригерами. При проблемі зупиніться і підготуйте
  сумісне виправлення. Відновлення D1 через export/Time Travel — лише окреме
  рішення власника з урахуванням замовлень, що надійшли після точки відновлення.
  Автоматичного відкату або видалення даних немає.

Офіційні довідки: [D1 export/import](https://developers.cloudflare.com/d1/best-practices/import-export-data/),
[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/),
[Pages Git integration](https://developers.cloudflare.com/pages/configuration/git-integration/).
