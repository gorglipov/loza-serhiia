# Перевірка адмінпанелі LOZA

Дата: 22 жовтня 2026. База: актуальний `main` після злиття PR №2 (`615d3e5`).

## Виконано локально

- Wrangler 4.151.3: Pages Functions успішно зібрані.
- Node 22.11, Miniflare 5.20261019.1-beta: ізольована D1, справжній зібраний Worker, RSA JWT fixtures і mock зовнішніх HTTP API.
- 12 сценаріїв пройшли, 0 помилок, 0 skipped, включно з Playwright/Microsoft Edge на 1440 і 390 px.

Сценарії: захист HTML/API без JWT; підроблений/прострочений JWT, чужі email/AUD/issuer/алгоритм; CSRF та Origin; повтор міграції/збереження старих записів; серверна сума і повтор створення; один outbox на замовлення; відсутність PII у повідомленні; 409 для застарілої версії складу; SQL injection як звичайний текст; одноразове повернення складу; переходи статусів; аудит; 429 та повтор без нового замовлення; невизначена доставка без автодубля; доступ до тестової відправки лише адміністратору; відкат outbox при провалі batch; expired lease; відсутність токенів у приватній відповіді; заборона доступу до SQL/серверних джерел; відсутність помилок JS і горизонтального overflow сторінки на смартфоні; безпечне відображення збереженого HTML як тексту. Пошук українських назв перевірено з іншого регістру.

`index.html`, `storefront.js`, `storefront.css`, `functions/api/mono/*`, `functions/api/np.js` та `_routes.json` не змінені.

## Що потребує налаштування Cloudflare Preview

GitHub: [Draft PR №3](https://github.com/gorglipov/loza-serhiia/pull/3). Cloudflare Pages check для `75a66fa` — success. Прочитано реальний [Preview гілки](https://codex-admin-telegram.loza-serhiia.pages.dev):

| Запит без авторизації | Відповідь |
| --- | --- |
| `/` | 200, магазин доступний |
| `/admin` | 503 `ADMIN_NOT_CONFIGURED`, `no-store, private` |
| `/api/admin/orders` | 503 `ADMIN_NOT_CONFIGURED`, `no-store, private` |
| `/api/admin/telegram` | 503 `ADMIN_NOT_CONFIGURED`, `no-store, private` |
| `/grape-orders-backup.sql` | 404, `no-store` |
| `/server/admin.js` | 404, `no-store` |

Приватні дані не видаються. Відповідь `ADMIN_NOT_CONFIGURED` означає, що принаймні одна з чотирьох нових адміністративних змінних у Preview ще відсутня або має некоректний формат. Наявність реальних Telegram secrets ці неавторизовані запити не перевіряють. Записів у віддалену D1 і реальних відправок боту під час цих перевірок не було.

Локальна симуляція не підтверджує роботу справжньої Access policy, allowlist Turnstile або доставку в живий Telegram-чат. Для цього потрібні окрема Preview D1 з міграцією `0003`, Preview Access application та чотири адміністративні змінні. Наявні Telegram secrets потрібно перевірити саме у Preview environment. Послідовність і негативні перевірки наведено в [ADMIN-TELEGRAM-ROLLOUT.md](ADMIN-TELEGRAM-ROLLOUT.md).

Production D1, секрети, webhook та розгортання не змінювалися. Cron Worker підготовлений, але не опублікований.
