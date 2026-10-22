# LOZA PR №3: перевірка перед Merge

Дата: 22 жовтня 2026. PR: [№3](https://github.com/gorglipov/loza-serhiia/pull/3), гілка `codex/admin-telegram`, база `main` після PR №2. Merge не виконано. Жодних віддалених INSERT/UPDATE/DELETE, розгортання Production, зміни секретів, Access policy чи binding під час перевірки не було.

## Висновок

Код підготовлений до Merge після успішного Cloudflare Pages check останнього коміту. Перевірених блокерів у коді або Production D1 не знайдено. Власник підтвердив перевірку адмінпанелі, Telegram і замовлень у Preview. Після Merge потрібна контрольна перевірка нового коду у Production; перелік нижче.

## Що перевірено

| Пункт | Результат |
| --- | --- |
| Серверний Access | RS256 підпис; JWKS лише фіксованої команди; точні issuer/AUD; строки JWT; точний email allowlist |
| Адміністративні маршрути | `/admin`, `/api/admin` і всі дочірні маршрути закриті middleware; mutation API не виконує дій без Access + CSRF + same-origin JSON |
| Права та персональні дані | Підроблений email заголовок не авторизує; чужий підписаний email відхиляється; приватні відповіді `no-store`; клієнтський HTML використовує текстове екранування |
| Секрети | Сканування відстежуваних файлів на типові credential literals/private keys; перевірки canary секретів у публічних/приватних відповідях і клієнтських файлах пройшли |
| Production D1 | Binding `DB` присутній; маркери `0002`/`0003` та всі 15 потрібних таблиць на місці; foreign key check без порушень; таблиці версій покривають товари/замовлення |
| Узгодженість даних | Суми/кількість позицій checkout узгоджені; повернення складу стосуються скасованих замовлень; зміни адміністратора мають аудит; події нового замовлення унікальні |
| Ізоляція середовищ | Preview і Production прив’язані до різних D1; binding не змінювався |
| Фактична схема | Через read-only API отримано тільки DDL без рядків покупців/банківських операцій; створено ізольовану D1 з цією схемою; усі статуси/записи/тригери перевірено на синтетичних даних |
| Публічний Production | `/` і `/api/products` — 200 без Access; `/api/store/config` — 200, `checkoutAvailable: true`, `paymentsEnabled: false` |
| Access у Production | Неавторизовані GET до всіх груп admin API ведуть у Access; domain/AUD збігаються з налаштуваннями Production |
| Незалежність від оплати | Каталог, розрахунок, створення замовлень, адмінпанель і Telegram перевірені без `MONO_TOKEN`/`MONO_WEBHOOK_KEY`; `paymentsEnabled` залишається false |
| Збережені файли | `index.html`, `storefront.js/css`, `_routes.json`, `functions/api/mono/*` і `functions/api/np.js` не змінені від `main` |

Усі дев’ять потрібних Production env bindings присутні: чотири адміністративні, `CHECKOUT_SECURITY_KEY`, два Turnstile та два Telegram. Відкриті конфігураційні поля перевірено тільки за булевими ознаками, значення не виводилися. Зашифровані значення через API не розкривалися.

## Тести та збірка

- Pages Functions: Wrangler 4.152.0 — успішна збірка.
- Production Cron Worker: успішний `deploy --dry-run` із прикладом конфігурації; реального deployment не виконано.
- **22/22 тестів, 0 помилок, 0 skipped** з копією фактичної Production-схеми в ізольованому Miniflare. Ніяких відправок робочому боту чи записів у Production.
- Ті самі **22/22** повторно пройшли на чистій синтетичній схемі, включно з доданими до Git файлами сканера й тестів.
- Браузер: Microsoft Edge, 1440 та 390 px; без JS помилок, без виконання збереженого HTML, без переповнення сторінки.
- Тести включають підроблений/чужий/прострочений JWT, AUD/issuer/email, CSRF/Origin, усі адміністративні mutation маршрути, відсутність банківських ключів, secret leakage, ідемпотентність, ціни сервера, відкат D1 batch, одноразове повернення складу, статуси/аудит, Telegram 429, lease expiry та невизначену доставку.
- Уточнено час lease для кожного окремого повідомлення та розрахунок `retry_after` від завершення відповіді; додано окремий тест із повільними відповідями. Нової міграції для цього не потрібно.
- Повідомлення про неналаштовану адмінпанель/схему тепер коректні для обох середовищ, без прив’язки тексту помилки до Preview.

Команди для повторення на цьому комп’ютері:

```powershell
Set-Location "C:\Users\rigam\Documents\Codex\2026-10-19\new-chat\work\loza-serhiia"
$lozaNode = "C:\Program Files\nodejs\node.exe"
$lozaWrangler = "C:\Users\rigam\AppData\Local\npm-cache\_npx\32026684e21afda6\node_modules\wrangler\bin\wrangler.js"
& $lozaNode $lozaWrangler pages functions build --outfile .wrangler/admin-worker.js
$env:LOZA_MINIFLARE_MODULE = "C:\Users\rigam\AppData\Local\npm-cache\_npx\32026684e21afda6\node_modules\miniflare\dist\src\index.js"
$env:LOZA_PLAYWRIGHT_MODULE = "C:\Users\rigam\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright\index.mjs"
$env:LOZA_GIT = "C:\Users\rigam\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd\git.exe"
& $lozaNode --test .\tests\access-configuration.test.mjs .\tests\admin-preview.test.mjs .\tests\telegram-retry.test.mjs .\tests\source-secrets.test.mjs
```

Ці команди використовують синтетичну базову схему. Для точного повтору зі збереженою **DDL-only** копією Production додайте перед тестами:

```powershell
$env:LOZA_PRODUCTION_SCHEMA_FILE = "C:\Users\rigam\Documents\Codex\2026-10-19\new-chat\work\loza-serhiia\.wrangler\production-schema.json"
```

Копія DDL і результати read-only API зберігаються тільки в ігнорованій `.wrangler/`; у Git не додаються. Локальна невідстежувана копія міграції користувача залишена недоторканою.

## Неперевірені ризики та межі

1. **Новий код ще не виконується у Production.** Повний браузерний вхід адміністратора, реальний Turnstile → замовлення → Telegram з Production secrets не виконувалися: для цього потрібне опублікування після рішення власника. Наявність encrypted bindings підтверджена, їхній вміст/формат/відповідність боту не читається API. Preview перевірений власником, але це не доводить правильність усіх Production secret values.
2. **Cron для Telegram не підтверджений.** У списку Workers не знайдено Production Telegram Worker LOZA за відповідною назвою. Без окремого запланованого виконавця повтори запускаються новими замовленнями та кнопкою адміністратора. Для гарантованої повторної обробки за відсутності нових замовлень підготовлено `workers/wrangler.production.example.toml`; сам він не розгортається. Зовнішні scheduler із довільними назвами не аудитувалися.
3. **Telegram не гарантує exactly-once при втраті відповіді.** `uncertain` свідомо не повторюється автоматично. Власник перевіряє чат і явно дозволяє повтор, який може створити дубль; прийняте замовлення зберігається незалежно від Telegram.
4. **Навантаження й збої зовнішніх сервісів.** Не виконувалося навантажувальне тестування, реальна ротація ключів Access чи відключення Cloudflare/Telegram. При недоступності JWKS адмінпанель закриває доступ; rate limits, retry і timeout перевірені локально. Публічний магазин не залежить від Access JWKS.
5. **Резервне відновлення та історичні витоки.** Наявні дані не змінювалися; відновлення з резервної копії не випробовувалося. Сканування покриває поточні відстежувані файли й типові формати, не є аудитом усієї Git-історії чи інших сервісів.

## Дії власника після Merge

1. Дочекатися успішного Production deployment саме останнього коміту PR.
2. Без входу відкрити магазин/каталог/кошик; адміністративні адреси мають вимагати Access.
3. Увійти дозволеним email у `/admin`; відкрити товари, історію і замовлення. Перевірити, що старі дані на місці.
4. Через `/admin` → Telegram надіслати тест. За потреби створити одне явно тестове замовлення зі справжнім Turnstile, перевірити одне повідомлення без контактів і без платежу; скасувати його через адмінпанель і перевірити залишок.
5. Для повторів без трафіку налаштувати окремий Cron Worker з Production D1 та наявними Telegram secrets. Приклад конфігурації не містить ID бази чи секретів; скопіювати в локальний файл, вписати перевірений ID `grape-orders` і застосувати вручну за процедурою з `ADMIN-TELEGRAM-ROLLOUT.md`. Не використовувати Preview DB ID.

Сам PR не вмикає реальну оплату і не змінює monobank webhook.
